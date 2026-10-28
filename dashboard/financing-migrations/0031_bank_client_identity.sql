-- Bank departments are business identities. An asset-management identity never
-- borrows the bank's legal fullname, and a product manager is not its investor.
CREATE FUNCTION public.bank_client_context(value text)
RETURNS TABLE(bank_id bigint,is_asset_management boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH normalized AS (
    SELECT regexp_replace(public.normalize_client_name(value),'^(银行|营业部大客户|机构投资者)-','') AS name
  ), parsed AS (
    SELECT name ~ '(\((资管|资产管理|资产管理部)\)|(资管|资产管理|资产管理部))$' AS asset,
      regexp_replace(name,'(\((资管|资产管理|资产管理部|金市|自营)\)|(资管|资产管理|资产管理部|金市|自营))$','') AS bank_name
    FROM normalized
  )
  SELECT DISTINCT c.id,p.asset FROM parsed p JOIN public.client c ON c.type='银行'
    AND (public.normalize_client_name(c.name)=p.bank_name
      OR public.normalize_client_name(c.fullname)=p.bank_name
      OR EXISTS (SELECT 1 FROM public.client_alias a WHERE a.match_kind='exact' AND a.alias=p.bank_name AND a.client_id=c.id))
$$;
REVOKE ALL ON FUNCTION public.bank_client_context(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.resolve_client(value text) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE normalized text := public.normalize_client_name(value); candidates bigint[]; bank_ids bigint[]; asset boolean;
BEGIN
  IF normalized IS NULL OR normalized = '' THEN RETURN NULL; END IF;
  -- A whole bank name defaults to the proprietary bank identity. Only a terminal,
  -- explicit department label selects the separately maintained bank asset client.
  SELECT array_agg(DISTINCT bank_id),bool_or(is_asset_management) INTO bank_ids,asset
    FROM public.bank_client_context(value);
  IF cardinality(bank_ids)>1 THEN RETURN NULL; END IF;
  IF cardinality(bank_ids)=1 THEN
    IF NOT asset THEN RETURN bank_ids[1]; END IF;
    SELECT array_agg(a.id) INTO candidates FROM public.client b JOIN public.client a
      ON a.name=b.name||'资管' AND a.type='理财子' WHERE b.id=bank_ids[1];
    IF cardinality(candidates)=1 THEN RETURN candidates[1]; END IF;
    RETURN NULL; -- Never fall back to the bank for an explicit but unmaintained asset client.
  END IF;
  SELECT array_agg(DISTINCT id) INTO candidates FROM (
    SELECT client_id AS id FROM public.client_alias WHERE match_kind = 'exact' AND alias = normalized
    UNION SELECT id FROM public.client WHERE public.normalize_client_name(name) = normalized
      OR public.normalize_client_name(fullname) = normalized
  ) resolved;
  IF cardinality(candidates) = 1 THEN RETURN candidates[1]; END IF;
  IF cardinality(candidates) > 1 THEN RETURN NULL; END IF;
  -- Strip only a source category, never infer an investor from a manager substring.
  SELECT array_agg(DISTINCT id) INTO candidates FROM (
    SELECT client_id AS id FROM public.client_alias WHERE match_kind = 'exact'
      AND alias = regexp_replace(normalized, '^(银行|营业部大客户|机构投资者)-', '')
    UNION SELECT id FROM public.client WHERE public.normalize_client_name(name) = regexp_replace(normalized, '^(银行|营业部大客户|机构投资者)-', '')
      OR public.normalize_client_name(fullname) = regexp_replace(normalized, '^(银行|营业部大客户|机构投资者)-', '')
  ) resolved;
  IF cardinality(candidates) = 1 THEN RETURN candidates[1]; END IF;
  IF cardinality(candidates) > 1 THEN RETURN NULL; END IF;
  SELECT array_agg(DISTINCT client_id) INTO candidates FROM public.client_alias
    WHERE match_kind = 'pattern' AND normalized ~ alias;
  IF cardinality(candidates) = 1 THEN RETURN candidates[1]; END IF;
  RETURN NULL;
END;
$$;
