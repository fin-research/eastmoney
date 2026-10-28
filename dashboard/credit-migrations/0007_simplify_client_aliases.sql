-- Run after bank asset identities (0006). Both financing and credit use this
-- shared resolver; change the alias schema and its readers in one transaction.
SELECT pg_advisory_xact_lock(hashtext('financing.local_debt_maintenance'));
SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));

CREATE TEMP TABLE previous_client_resolution ON COMMIT DROP AS
WITH names AS (
  SELECT alias AS name FROM public.client_alias WHERE match_kind='exact'
  UNION SELECT name FROM public.client
  UNION SELECT fullname FROM public.client
  UNION SELECT counterparty FROM financing.debt
  UNION SELECT institution_name FROM credit.institution
)
SELECT name,public.resolve_client(name) AS client_id FROM names WHERE name IS NOT NULL;

CREATE FUNCTION public.client_match_key(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT regexp_replace(
    replace(replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(public.normalize_client_name(value),'[“”"‘’]','','g'),
          '^(银行-|机构投资者-|营业部大客户-?(?=.)|营业部散户-?(?=.))',''),
        '\(被[^()]*吸收合并\)$',''),
      '农村商业银行','农商行'),'农商银行','农商行'),
    '(股份有限公司|有限责任公司|有限公司)$','')
$$;

-- Keep direct master-name lookups indexed after switching normalization rules.
DROP INDEX public.client_normalized_name_idx;
DROP INDEX public.client_normalized_fullname_idx;
CREATE INDEX client_match_name_idx ON public.client(public.client_match_key(name));
CREATE INDEX client_match_fullname_idx ON public.client(public.client_match_key(fullname));

CREATE FUNCTION public.client_bank_province(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT substring(public.client_match_key(value) FROM
    '^(北京|天津|河北|山西|内蒙古|辽宁|吉林|黑龙江|上海|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|重庆|四川|贵州|云南|西藏|陕西|甘肃|青海|宁夏|新疆|香港|澳门|台湾)')
$$;
CREATE FUNCTION public.client_bank_key(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT regexp_replace(regexp_replace(public.client_match_key(value),
    '^(中国|北京|天津|河北|山西|内蒙古|辽宁|吉林|黑龙江|上海|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|重庆|四川|贵州|云南|西藏|陕西|甘肃|青海|宁夏|新疆|香港|澳门|台湾)(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)?',''), '银行$','行')
$$;

-- Return all candidates. Ambiguity is never resolved by row order or a fuzzy score.
CREATE FUNCTION public.client_name_candidates(value text,bank_only boolean DEFAULT false)
RETURNS TABLE(client_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH input AS (SELECT public.client_match_key(value) AS key,
      public.client_bank_key(value) AS bank_key,public.client_bank_province(value) AS province),
  direct AS (
    SELECT c.id FROM public.client c CROSS JOIN input i
    WHERE (NOT bank_only OR c.type='银行')
      AND (public.client_match_key(c.name)=i.key OR public.client_match_key(c.fullname)=i.key)
  )
  SELECT id FROM direct
  UNION
  SELECT c.id FROM public.client c CROSS JOIN input i
  WHERE NOT EXISTS(SELECT 1 FROM direct) AND c.type='银行' AND length(i.bank_key)>1
    AND i.bank_key NOT IN ('农商行','联社','农联社','农信联社','农村信用社')
    AND (public.client_bank_key(c.name)=i.bank_key OR public.client_bank_key(c.fullname)=i.bank_key)
    AND (i.province IS NULL
      OR coalesce(public.client_bank_province(c.name),public.client_bank_province(c.fullname)) IS NULL
      OR i.province=coalesce(public.client_bank_province(c.name),public.client_bank_province(c.fullname)))
$$;

CREATE FUNCTION public.resolve_client_by_rules(value text) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE key text:=public.client_match_key(value); base text; product text; ids bigint[]; bank_ids bigint[];
  asset boolean; owner_id bigint;
BEGIN
  IF key IS NULL OR key='' THEN RETURN NULL; END IF;
  asset:=key ~ '(\((资管|资管部|资产管理|资产管理部)\)|(资管|资管部|资产管理|资产管理部))$';
  base:=regexp_replace(key,'(\((资管|资管部|资产管理|资产管理部|金市|自营)\)|(资管|资管部|资产管理|资产管理部|金市|自营))$','');
  IF base<>key THEN
    SELECT array_agg(DISTINCT client_id) INTO bank_ids FROM public.client_name_candidates(base,true);
    IF cardinality(bank_ids)>1 THEN RETURN NULL; END IF;
    IF cardinality(bank_ids)=1 THEN
      IF NOT asset THEN RETURN bank_ids[1]; END IF;
      SELECT c.id INTO owner_id FROM public.client b JOIN public.client c
        ON c.name=b.name||'资管' AND c.type='理财子' WHERE b.id=bank_ids[1];
      RETURN owner_id; -- Missing explicit asset identity must not fall back to its bank.
    END IF;
  END IF;

  SELECT array_agg(DISTINCT client_id) INTO ids FROM public.client_name_candidates(key);
  IF cardinality(ids)=1 THEN RETURN ids[1]; END IF;
  IF cardinality(ids)>1 THEN RETURN NULL; END IF;

  -- Only known named products at the end of an account string qualify. The
  -- preceding account holder must end in a company name, optionally followed by 代/代表.
  product:=regexp_replace(key,'\)+$','');
  SELECT array_agg(DISTINCT c.id) INTO ids FROM public.client c
  WHERE public.client_match_key(c.name) ~ '(资产管理计划|资金信托计划|私募证券投资基金)$'
    AND right(product,length(public.client_match_key(c.name)))=public.client_match_key(c.name)
    AND left(product,length(product)-length(public.client_match_key(c.name))) ~ '公司(\(?(代|代表))?$';
  IF cardinality(ids)=1 THEN RETURN ids[1]; END IF;
  IF cardinality(ids)>1 THEN RETURN NULL; END IF;

  -- Wealth products are identified by a known wealth company's prefix. If the
  -- text names two different wealth companies, require an explicit exception.
  SELECT array_agg(DISTINCT c.id) INTO ids FROM public.client c
    WHERE c.type='理财子' AND c.name LIKE '%理财' AND strpos(key,public.client_match_key(c.name))>0;
  IF cardinality(ids)=1 THEN
    SELECT c.id INTO owner_id FROM public.client c WHERE c.id=ids[1]
      AND starts_with(key,public.client_match_key(c.name));
    IF owner_id IS NOT NULL THEN RETURN owner_id; END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TEMP TABLE retained_client_aliases ON COMMIT DROP AS
SELECT DISTINCT public.client_match_key(alias) AS alias,client_id FROM public.client_alias
WHERE match_kind='exact' AND public.resolve_client_by_rules(alias) IS DISTINCT FROM client_id;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM retained_client_aliases GROUP BY alias HAVING count(DISTINCT client_id)>1) THEN
    RAISE EXCEPTION 'Conflicting client aliases after normalization';
  END IF;
END $$;

ALTER TABLE public.client_alias DROP CONSTRAINT client_alias_pkey;
ALTER TABLE public.client_alias DROP COLUMN match_kind,DROP COLUMN notes;
DELETE FROM public.client_alias;
INSERT INTO public.client_alias(alias,client_id) SELECT alias,client_id FROM retained_client_aliases;
ALTER TABLE public.client_alias ADD PRIMARY KEY(alias);
COMMENT ON TABLE public.client_alias IS '仅保存通用规则不能处理的精确别名或实际投资人例外；alias 为 client_match_key 标准化键';

CREATE OR REPLACE FUNCTION public.bank_client_context(value text)
RETURNS TABLE(bank_id bigint,is_asset_management boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH input AS (SELECT public.client_match_key(value) AS key),parsed AS (
    SELECT key ~ '(\((资管|资管部|资产管理|资产管理部)\)|(资管|资管部|资产管理|资产管理部))$' AS asset,
      regexp_replace(key,'(\((资管|资管部|资产管理|资产管理部|金市|自营)\)|(资管|资管部|资产管理|资产管理部|金市|自营))$','') AS base FROM input
  ), candidates AS (
    SELECT n.client_id AS id,p.asset FROM parsed p CROSS JOIN LATERAL public.client_name_candidates(p.base,true) n
    UNION SELECT c.id,p.asset FROM parsed p JOIN public.client_alias a ON a.alias=public.client_match_key(p.base)
      JOIN public.client c ON c.id=a.client_id AND c.type='银行'
  ) SELECT DISTINCT id,asset FROM candidates
$$;

CREATE OR REPLACE FUNCTION public.resolve_client(value text) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE key text:=public.client_match_key(value); resolved bigint; bank_ids bigint[]; asset boolean;
BEGIN
  IF key IS NULL OR key='' THEN RETURN NULL; END IF;
  SELECT client_id INTO resolved FROM public.client_alias WHERE alias=key;
  IF resolved IS NOT NULL THEN RETURN resolved; END IF;
  resolved:=public.resolve_client_by_rules(value);
  IF resolved IS NOT NULL THEN RETURN resolved; END IF;
  -- Department names can still use a genuinely exceptional bank abbreviation.
  SELECT array_agg(DISTINCT bank_id),bool_or(is_asset_management) INTO bank_ids,asset FROM public.bank_client_context(value);
  IF cardinality(bank_ids)=1 THEN
    IF NOT asset THEN RETURN bank_ids[1]; END IF;
    SELECT c.id INTO resolved FROM public.client b JOIN public.client c ON c.name=b.name||'资管' AND c.type='理财子' WHERE b.id=bank_ids[1];
    RETURN resolved;
  END IF;
  RETURN NULL;
END $$;

-- Assert the live debt, credit, master-name and former exact-alias corpus before
-- committing any deletions. Existing associations and monetary facts are not rewritten.
DO $$ DECLARE differences text; BEGIN
  SELECT string_agg(name,', ') INTO differences FROM previous_client_resolution
    WHERE public.resolve_client(name) IS DISTINCT FROM client_id;
  IF differences IS NOT NULL THEN RAISE EXCEPTION 'Client resolution changed: %',differences; END IF;
END $$;
REVOKE ALL ON FUNCTION public.client_match_key(text),public.client_bank_province(text),public.client_bank_key(text),
  public.client_name_candidates(text,boolean),public.resolve_client_by_rules(text) FROM PUBLIC;
