-- Dedicated raw inputs for issuer pricing research. The existing quant_input
-- rows remain the field-level source of truth for primary issuance facts.
CREATE TABLE public.bond_issuance (
  bond_code text PRIMARY KEY,
  issue_date date NOT NULL,
  issuer_name text NOT NULL,
  short_name text,
  bond_type text,
  issuer_rating text,
  bond_rating text,
  original_tenor_years double precision,
  issue_amount_100m double precision,
  interest_rate_type text,
  has_option boolean,
  has_guarantee boolean,
  placement_type text,
  tender_date date,
  tender_announcement_date date,
  final_coupon_pct double precision,
  coupon_reference_pct double precision,
  issue_spread_bp double precision,
  source_record_count integer NOT NULL,
  source_last_synced_at timestamptz NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (btrim(bond_code) <> '' AND btrim(issuer_name) <> ''),
  CHECK (original_tenor_years IS NULL OR original_tenor_years > 0),
  CHECK (issue_amount_100m IS NULL OR issue_amount_100m >= 0)
);
CREATE INDEX bond_issuance_issuer_date_idx ON public.bond_issuance (issuer_name, issue_date DESC);
CREATE INDEX bond_issuance_issue_date_idx ON public.bond_issuance (issue_date DESC);
COMMENT ON TABLE public.bond_issuance IS 'One bond per row, projected from public.quant_input issue fields. Reference coupon and actual final tender coupon are distinct. NULL placement_type means public/private status is unverified.';
COMMENT ON COLUMN public.bond_issuance.source_last_synced_at IS 'Latest ingestion time among source fields; not an as-of historical data vintage.';

CREATE TABLE public.bond_history (
  bond_code text NOT NULL,
  valuation_date date NOT NULL,
  chinabond_yield_pct double precision,
  outstanding_balance_cny double precision,
  remaining_term_years double precision,
  yield_source text,
  balance_source text,
  term_source text,
  source_snapshot_at timestamptz NOT NULL,
  last_imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (bond_code, valuation_date),
  CHECK (btrim(bond_code) <> ''),
  CHECK (outstanding_balance_cny IS NULL OR outstanding_balance_cny >= 0),
  CHECK (remaining_term_years IS NULL OR remaining_term_years >= 0),
  CHECK (chinabond_yield_pct IS NOT NULL OR outstanding_balance_cny IS NOT NULL OR remaining_term_years IS NOT NULL)
);
CREATE INDEX bond_history_date_idx ON public.bond_history (valuation_date DESC, bond_code);
COMMENT ON TABLE public.bond_history IS 'Daily bond-level secondary observations. Missing fields stay NULL; positive balance is required before a bond contributes to issuer spread.';
COMMENT ON COLUMN public.bond_history.outstanding_balance_cny IS 'Choice BONDBALANCE raw response, empirically denominated in yuan for the verified issuer sample; retain raw value and source.';
COMMENT ON COLUMN public.bond_history.source_snapshot_at IS 'Time the historical snapshot was captured or saved, not a point-in-time vendor revision archive.';

CREATE TABLE public.bond_industry_curve (
  curve_code text NOT NULL,
  curve_name text NOT NULL,
  observation_date date NOT NULL,
  tenor_years double precision NOT NULL,
  yield_pct double precision NOT NULL,
  node_label text,
  source text NOT NULL,
  source_snapshot_at timestamptz NOT NULL,
  last_imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (curve_code, observation_date, tenor_years),
  CHECK (btrim(curve_code) <> '' AND tenor_years > 0)
);
CREATE INDEX bond_industry_curve_date_idx ON public.bond_industry_curve (observation_date DESC, curve_code);
COMMENT ON TABLE public.bond_industry_curve IS 'Source curve nodes by date and tenor. No curve interpolation, extrapolation or issuer-spread calculation is stored here.';

CREATE FUNCTION public.refresh_bond_issuance_from_quant_input(p_codes text[] DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE changed_rows bigint;
BEGIN
  WITH latest AS (
    SELECT DISTINCT ON (upper(entity_key), field)
      upper(entity_key) AS bond_code, field, observation_date,
      numeric_value, text_value, synced_at
    FROM public.quant_input
    WHERE dataset = 'issue' AND entity_key <> ''
      AND (p_codes IS NULL OR upper(entity_key) = ANY(p_codes))
    ORDER BY upper(entity_key), field, observation_date DESC, synced_at DESC
  ), source_rows AS (
    SELECT bond_code, max(observation_date) AS issue_date,
      max(text_value) FILTER (WHERE field = 'ISSUER_NAME') AS issuer_name,
      max(text_value) FILTER (WHERE field = 'BOND_NAME_ABBR') AS short_name,
      max(text_value) FILTER (WHERE field = 'BOND_TYPE') AS bond_type,
      max(text_value) FILTER (WHERE field = 'ISSUER_RATING') AS issuer_rating,
      max(text_value) FILTER (WHERE field = 'BOND_RATING') AS bond_rating,
      max(numeric_value) FILTER (WHERE field = 'TENOR_YEAR') AS tenor_years,
      max(numeric_value) FILTER (WHERE field = 'BOND_EXPIRE_YEAR') AS alternate_tenor_years,
      max(numeric_value) FILTER (WHERE field = 'ACTUAL_ISSUE_SCALE') AS issue_amount_100m,
      max(text_value) FILTER (WHERE field = 'PI_RATE_TYPE') AS interest_rate_type,
      max(text_value) FILTER (WHERE field = 'IS_OEB') AS option_text,
      max(numeric_value) FILTER (WHERE field = 'IS_OEB') AS option_numeric,
      max(text_value) FILTER (WHERE field = 'IS_GUARANTEE') AS guarantee_text,
      max(numeric_value) FILTER (WHERE field = 'IS_GUARANTEE') AS guarantee_numeric,
      max(text_value) FILTER (WHERE field = 'TENDERDATE') AS tender_date_text,
      max(text_value) FILTER (WHERE field = 'TENDERANNCDATE') AS announcement_date_text,
      max(numeric_value) FILTER (WHERE field = 'TENDERFINALCOUPON') AS final_coupon_pct,
      max(numeric_value) FILTER (WHERE field = 'ISSUERATE_REFERENCE') AS coupon_reference_pct,
      max(numeric_value) FILTER (WHERE field = 'ISSUECREDITSPREAD') AS issue_spread_bp,
      count(*)::integer AS source_record_count,
      max(synced_at) AS source_last_synced_at
    FROM latest GROUP BY bond_code
  ), normalized AS (
    SELECT bond_code, issue_date, issuer_name, short_name, bond_type,
      issuer_rating, bond_rating,
      coalesce(tenor_years, alternate_tenor_years) AS original_tenor_years,
      issue_amount_100m, interest_rate_type,
      CASE WHEN option_numeric IN (0,1) THEN option_numeric = 1
        WHEN option_text IN ('是','1','yes','Yes') THEN true
        WHEN option_text IN ('否','0','no','No') THEN false END AS has_option,
      CASE WHEN guarantee_numeric IN (0,1) THEN guarantee_numeric = 1
        WHEN guarantee_text IN ('是','1','yes','Yes') THEN true
        WHEN guarantee_text IN ('否','0','no','No') THEN false END AS has_guarantee,
      CASE WHEN tender_date_text ~ '^\d{4}[-/]\d{1,2}[-/]\d{1,2}$'
        THEN to_date(replace(tender_date_text, '-', '/'), 'YYYY/MM/DD') END AS tender_date,
      CASE WHEN announcement_date_text ~ '^\d{4}[-/]\d{1,2}[-/]\d{1,2}$'
        THEN to_date(replace(announcement_date_text, '-', '/'), 'YYYY/MM/DD') END AS tender_announcement_date,
      final_coupon_pct, coupon_reference_pct, issue_spread_bp,
      source_record_count, source_last_synced_at
    FROM source_rows WHERE issuer_name IS NOT NULL
  )
  INSERT INTO public.bond_issuance (
    bond_code, issue_date, issuer_name, short_name, bond_type,
    issuer_rating, bond_rating, original_tenor_years, issue_amount_100m,
    interest_rate_type, has_option, has_guarantee, tender_date,
    tender_announcement_date, final_coupon_pct, coupon_reference_pct,
    issue_spread_bp, source_record_count, source_last_synced_at
  )
  SELECT bond_code, issue_date, issuer_name, short_name, bond_type,
    issuer_rating, bond_rating, original_tenor_years, issue_amount_100m,
    interest_rate_type, has_option, has_guarantee, tender_date,
    tender_announcement_date, final_coupon_pct, coupon_reference_pct,
    issue_spread_bp, source_record_count, source_last_synced_at
  FROM normalized
  ON CONFLICT (bond_code) DO UPDATE SET
    issue_date = excluded.issue_date,
    issuer_name = excluded.issuer_name,
    short_name = excluded.short_name,
    bond_type = excluded.bond_type,
    issuer_rating = excluded.issuer_rating,
    bond_rating = excluded.bond_rating,
    original_tenor_years = excluded.original_tenor_years,
    issue_amount_100m = excluded.issue_amount_100m,
    interest_rate_type = excluded.interest_rate_type,
    has_option = excluded.has_option,
    has_guarantee = excluded.has_guarantee,
    tender_date = excluded.tender_date,
    tender_announcement_date = excluded.tender_announcement_date,
    final_coupon_pct = excluded.final_coupon_pct,
    coupon_reference_pct = excluded.coupon_reference_pct,
    issue_spread_bp = excluded.issue_spread_bp,
    source_record_count = excluded.source_record_count,
    source_last_synced_at = excluded.source_last_synced_at,
    projected_at = clock_timestamp()
  WHERE (bond_issuance.source_record_count, bond_issuance.source_last_synced_at)
    IS DISTINCT FROM (excluded.source_record_count, excluded.source_last_synced_at);
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  RETURN changed_rows;
END;
$$;
COMMENT ON FUNCTION public.refresh_bond_issuance_from_quant_input(text[]) IS 'Idempotently project primary issue fields already persisted in public.quant_input. No Choice request.';
