BEGIN;

-- Shared customer identity; domain facts stay in their owning schemas.
CREATE TABLE public.client (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (btrim(name) <> ''),
  fullname text,
  type text NOT NULL CHECK (type IN ('银行', '理财子', '券商', '基金', '营业部客户', '其它')),
  subtype text
);
COMMENT ON COLUMN public.client.fullname IS '经核实的全名；来源仅有简称或汇总客户时为空，禁止猜测补全';

CREATE FUNCTION public.normalize_client_name(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT regexp_replace(translate(normalize(value, NFKC), '（）', '()'), '[[:space:]]+', '', 'g')
$$;

CREATE TABLE public.client_alias (
  alias text NOT NULL CHECK (alias <> ''),
  match_kind text NOT NULL DEFAULT 'exact' CHECK (match_kind IN ('exact', 'pattern')),
  client_id bigint NOT NULL REFERENCES public.client(id) ON DELETE RESTRICT,
  notes text NOT NULL,
  PRIMARY KEY (alias, match_kind)
);
CREATE INDEX client_alias_client_idx ON public.client_alias(client_id);
CREATE INDEX client_normalized_name_idx ON public.client(public.normalize_client_name(name));
CREATE INDEX client_normalized_fullname_idx ON public.client(public.normalize_client_name(fullname));

CREATE FUNCTION public.resolve_client(value text) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE normalized text := public.normalize_client_name(value); candidates bigint[];
BEGIN
  IF normalized IS NULL OR normalized = '' THEN RETURN NULL; END IF;
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
REVOKE ALL ON FUNCTION public.resolve_client(text) FROM PUBLIC;
REVOKE ALL ON TABLE public.client, public.client_alias FROM PUBLIC;

ALTER TABLE financing.debt ADD COLUMN client_id bigint;
CREATE FUNCTION financing.resolve_debt_client() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, financing AS $$
BEGIN
  -- Explicit administrator selections win. Changing the raw name reruns matching.
  IF (TG_OP = 'INSERT' AND NEW.client_id IS NULL)
    OR (TG_OP = 'UPDATE' AND NEW.counterparty IS DISTINCT FROM OLD.counterparty
        AND NEW.client_id IS NOT DISTINCT FROM OLD.client_id) THEN
    NEW.client_id := public.resolve_client(NEW.counterparty);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION financing.resolve_debt_client() FROM PUBLIC;

-- PostgreSQL does not inherit foreign keys or triggers; install on every table.
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['debt','bond','income_certificate','income_right','refinancing','swap_facility'] LOOP
    EXECUTE format('ALTER TABLE ONLY financing.%I ADD CONSTRAINT %I FOREIGN KEY (client_id) REFERENCES public.client(id) ON DELETE RESTRICT', table_name, table_name || '_client_fk');
    EXECUTE format('CREATE INDEX %I ON ONLY financing.%I(client_id)', table_name || '_client_idx', table_name);
    EXECUTE format('CREATE TRIGGER resolve_debt_client BEFORE INSERT OR UPDATE OF counterparty, client_id ON financing.%I FOR EACH ROW EXECUTE FUNCTION financing.resolve_debt_client()', table_name);
  END LOOP;
END $$;

CREATE OR REPLACE VIEW financing.debt_overview AS
SELECT d.id, d.debt_type, d.subtype, d.name, d.counterparty, d.amount,
  d.interest_payable, d.total_amount, d.annual_rate, d.issue_date, d.maturity_date,
  d.term_days, d.activated_at, d.settled_at, d.closed_at, d.status, d.created_at, d.updated_at,
  COALESCE(NULLIF(d.subtype, ''), d.debt_type) AS reporting_type,
  d.client_id
FROM financing.debt d;

-- Principal outstanding at the credit report's business date, in CNY yuan.
CREATE FUNCTION financing.credit_usage_as_of(as_of date)
RETURNS TABLE (client_id bigint, debt_type text, amount numeric, debt_count bigint)
LANGUAGE sql STABLE SET search_path = pg_catalog, financing AS $$
  SELECT d.client_id, d.debt_type, sum(d.amount), count(*)
  FROM financing.debt d
  WHERE d.debt_type IN ('收益凭证', '同业拆借')
    AND d.activated_at <= as_of
    AND (d.maturity_date IS NULL OR d.maturity_date > as_of)
    AND (d.settled_at IS NULL OR d.settled_at > as_of)
    AND (d.closed_at IS NULL OR d.closed_at > as_of)
  GROUP BY d.client_id, d.debt_type
$$;
REVOKE ALL ON FUNCTION financing.credit_usage_as_of(date) FROM PUBLIC;

COMMIT;
