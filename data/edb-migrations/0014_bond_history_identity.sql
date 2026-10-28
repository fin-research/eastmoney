-- Valuation security identity is separate from primary issuance tranche identity.
-- Raw source observations and NULLs are never rewritten by this mapping.
CREATE TABLE public.bond_history_identity (
  source_code text PRIMARY KEY REFERENCES public.bond_issuance(bond_code),
  canonical_code text NOT NULL REFERENCES public.bond_issuance(bond_code),
  effective_from date NOT NULL,
  official_url text NOT NULL CHECK (official_url ~ '^https://[^[:space:]]+$'),
  official_sha256 text NOT NULL CHECK (official_sha256 ~ '^[0-9a-f]{64}$'),
  official_pages integer[] NOT NULL CHECK (cardinality(official_pages)>0 AND 0<ALL(official_pages)),
  vendor_mapping_sha256 text NOT NULL CHECK (vendor_mapping_sha256 ~ '^[0-9a-f]{64}$'),
  review_sha256 text NOT NULL CHECK (review_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (source_code<>canonical_code),
  CHECK (source_code ~ '^[0-9]{6}(X([2-9])?)?\.(SH|SZ)$'),
  CHECK (canonical_code ~ '^[0-9]{6}(X([2-9])?)?\.(SH|SZ)$')
);
CREATE UNIQUE INDEX bond_history_identity_source_encoding_idx
  ON public.bond_history_identity(public.exchange_bond_code(source_code));
CREATE INDEX bond_history_identity_canonical_idx ON public.bond_history_identity(canonical_code);

CREATE FUNCTION public.check_bond_history_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_row public.bond_issuance; target_row public.bond_issuance;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bond-history-identity',0));
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'Reviewed bond history identity is immutable';
  END IF;
  IF EXISTS(SELECT 1 FROM public.bond_history_identity
    WHERE source_code=NEW.canonical_code OR canonical_code=NEW.source_code) THEN
    RAISE EXCEPTION 'Bond history identity target must be direct and final';
  END IF;
  SELECT * INTO source_row FROM public.bond_issuance WHERE bond_code=NEW.source_code FOR SHARE;
  SELECT * INTO target_row FROM public.bond_issuance WHERE bond_code=NEW.canonical_code FOR SHARE;
  IF source_row.bond_code IS NULL OR target_row.bond_code IS NULL OR
    source_row.issue_date>NEW.effective_from OR target_row.issue_date>NEW.effective_from OR
    (source_row.issuer_name,source_row.maturity_date,source_row.interest_rate_type,source_row.bond_type)
    IS DISTINCT FROM
    (target_row.issuer_name,target_row.maturity_date,target_row.interest_rate_type,target_row.bond_type) THEN
    RAISE EXCEPTION 'Bond history identity conflicts with issuance metadata';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_bond_history_identity BEFORE INSERT OR UPDATE ON public.bond_history_identity
  FOR EACH ROW EXECUTE FUNCTION public.check_bond_history_identity();

CREATE FUNCTION public.protect_bond_history_identity_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.bond_code,NEW.issue_date,NEW.issuer_name,NEW.maturity_date,NEW.interest_rate_type,NEW.bond_type)
    IS DISTINCT FROM
    (OLD.bond_code,OLD.issue_date,OLD.issuer_name,OLD.maturity_date,OLD.interest_rate_type,OLD.bond_type)
    AND EXISTS(SELECT 1 FROM public.bond_history_identity
      WHERE source_code=OLD.bond_code OR canonical_code=OLD.bond_code) THEN
    RAISE EXCEPTION 'Refresh conflicts with reviewed valuation security identity';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_bond_history_identity_metadata BEFORE UPDATE ON public.bond_issuance
  FOR EACH ROW EXECUTE FUNCTION public.protect_bond_history_identity_metadata();

-- Filter requested dates before grouping. Each non-NULL value remains a real
-- source value. Different non-NULL values are explicit per-field conflicts.
CREATE FUNCTION public.bond_history_observations(p_dates date[])
RETURNS TABLE(bond_code integer,valuation_date date,chinabond_yield_pct double precision,
  outstanding_balance_cny double precision,remaining_term_years double precision,
  raw_codes integer[],conflict_fields text[])
LANGUAGE SQL STABLE AS $$
  WITH members AS (
    SELECT coalesce(public.exchange_bond_code(m.canonical_code),h.bond_code) AS canonical_code,
      h.* FROM public.bond_history h LEFT JOIN public.bond_history_identity m
      ON public.exchange_bond_code(m.source_code)=h.bond_code AND h.valuation_date>=m.effective_from
    WHERE h.valuation_date=ANY(p_dates)
  )
  SELECT canonical_code,valuation_date,
    CASE WHEN count(DISTINCT chinabond_yield_pct)=1 THEN min(chinabond_yield_pct) END,
    CASE WHEN count(DISTINCT outstanding_balance_cny)<=1
      THEN min(outstanding_balance_cny) FILTER(WHERE bond_code=canonical_code) END,
    CASE WHEN count(DISTINCT remaining_term_years)=1 THEN min(remaining_term_years) END,
    array_agg(bond_code ORDER BY bond_code),
    array_remove(ARRAY[
      CASE WHEN count(DISTINCT chinabond_yield_pct)>1 THEN 'YIELDCNBD' END,
      CASE WHEN count(DISTINCT outstanding_balance_cny)>1 THEN 'BONDBALANCE' END,
      CASE WHEN count(DISTINCT remaining_term_years)>1 THEN 'MATUCNBD' END],NULL)
  FROM members GROUP BY canonical_code,valuation_date
$$;
