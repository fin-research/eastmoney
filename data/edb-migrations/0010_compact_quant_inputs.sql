-- Compact the observed inputs. Exchange bond code layout is [market][suffix][six digits]:
-- SH=1, SZ=2; ordinary=0, X=1, X2=2. Other suffixes are not model inputs.
CREATE FUNCTION public.exchange_bond_code(p_code text) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE
    WHEN upper(p_code) ~ '^[0-9]{6}(X[1-9]|X)?\.(SH|SZ)$' THEN
      (CASE WHEN upper(p_code) LIKE '%.SH' THEN 1 ELSE 2 END) * 10000000
      + (CASE WHEN upper(p_code) ~ '^[0-9]{6}X[1-9]\.'
          THEN substring(upper(p_code) from 'X([1-9])\.')::integer
          WHEN upper(p_code) ~ '^[0-9]{6}X\.' THEN 1 ELSE 0 END) * 1000000
      + left(p_code, 6)::integer
  END
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.bond_history
             WHERE bond_code NOT LIKE '%.IB' AND public.exchange_bond_code(bond_code) IS NULL) THEN
    RAISE EXCEPTION 'bond_history has exchange codes outside the eight-digit contract';
  END IF;
  IF EXISTS (SELECT 1 FROM public.bond_history WHERE bond_code NOT LIKE '%.IB'
             GROUP BY public.exchange_bond_code(bond_code), valuation_date HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'encoded bond_history keys would collide';
  END IF;
END $$;

DELETE FROM public.bond_history WHERE bond_code LIKE '%.IB';
ALTER TABLE public.bond_history DROP CONSTRAINT IF EXISTS bond_history_bond_code_check;
ALTER TABLE public.bond_history ALTER COLUMN bond_code TYPE integer
  USING public.exchange_bond_code(bond_code);
ALTER TABLE public.bond_history ADD CONSTRAINT bond_history_code_range
  CHECK (bond_code BETWEEN 10000000 AND 29999999);

-- Every current issue code/field has one observation date. Complete the
-- one-row-per-bond structure before removing issue field rows.
ALTER TABLE public.bond_issuance ADD COLUMN cross_market_code text;
ALTER TABLE public.bond_issuance ADD COLUMN tenor_year double precision;
ALTER TABLE public.bond_issuance ADD COLUMN bond_expire_year text;
ALTER TABLE public.bond_issuance ADD COLUMN pay_per_year double precision;
ALTER TABLE public.bond_issuance ADD COLUMN tomrty_year double precision;
ALTER TABLE public.bond_issuance ADD COLUMN dec_tomrtyyear1 text;
ALTER TABLE public.bond_issuance ADD COLUMN org_form text;
ALTER TABLE public.bond_issuance ADD COLUMN issuance_rating text;
ALTER TABLE public.bond_issuance ADD COLUMN quarantine_tender_date text;
ALTER TABLE public.bond_issuance ADD COLUMN quarantine_final_coupon_pct double precision;
ALTER TABLE public.bond_issuance ADD COLUMN quarantine_issuance_rating text;
ALTER TABLE public.bond_issuance ADD COLUMN quarantine_announcement_date text;
ALTER TABLE public.bond_issuance ADD COLUMN pricing_invalid_code boolean NOT NULL DEFAULT false;
ALTER TABLE public.bond_issuance ADD COLUMN issue_spread_invalid_code boolean NOT NULL DEFAULT false;
ALTER TABLE public.bond_issuance ADD COLUMN placement_checked_at date;
WITH fields AS (
  SELECT upper(entity_key) AS code,
    jsonb_object_agg(field, coalesce(to_jsonb(numeric_value), to_jsonb(text_value))) AS values
  FROM public.quant_input WHERE dataset='issue' GROUP BY upper(entity_key)
)
UPDATE public.bond_issuance i SET
  cross_market_code=fields.values->>'CROSS_MARKET_CODE',
  tenor_year=(fields.values->>'TENOR_YEAR')::double precision,
  bond_expire_year=fields.values->>'BOND_EXPIRE_YEAR',
  pay_per_year=(fields.values->>'PAYPERYEAR')::double precision,
  tomrty_year=(fields.values->>'TOMRTY_YEAR')::double precision,
  dec_tomrtyyear1=fields.values->>'DEC_TOMRTYYEAR1',
  org_form=fields.values->>'ORGFORM',
  issuance_rating=fields.values->>'ISSCORPCREDITRAT',
  placement_type=coalesce(i.placement_type,
    CASE WHEN fields.values->>'RAISEWAY' IN ('公募','私募') THEN fields.values->>'RAISEWAY' END),
  maturity_date=coalesce(i.maturity_date,
    CASE WHEN fields.values->>'MATURITYDATE' ~ '^\d{4}[-/]\d{1,2}[-/]\d{1,2}$'
      THEN to_date(replace(fields.values->>'MATURITYDATE','-','/'),'YYYY/MM/DD') END)
FROM fields WHERE i.bond_code=fields.code;
WITH fields AS (
  SELECT upper(entity_key) AS code,
    jsonb_object_agg(field, coalesce(to_jsonb(numeric_value), to_jsonb(text_value))) AS values
  FROM public.quant_input WHERE dataset='issue_pricing_quarantine' GROUP BY upper(entity_key)
)
UPDATE public.bond_issuance i SET
  quarantine_tender_date=fields.values->>'TENDERDATE',
  quarantine_final_coupon_pct=(fields.values->>'TENDERFINALCOUPON')::double precision,
  quarantine_issuance_rating=fields.values->>'ISSCORPCREDITRAT',
  quarantine_announcement_date=fields.values->>'TENDERANNCDATE'
FROM fields WHERE i.bond_code=fields.code;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.quant_input q WHERE dataset IN ('issue','issue_pricing_quarantine')
             AND NOT EXISTS (SELECT 1 FROM public.bond_issuance i WHERE i.bond_code=upper(q.entity_key))) THEN
    RAISE EXCEPTION 'issue input lacks a matching bond_issuance row';
  END IF;
END $$;

DROP FUNCTION public.refresh_bond_issuance_from_quant_input(text[]);
ALTER TABLE public.bond_issuance DROP COLUMN source_record_count;
ALTER TABLE public.bond_issuance DROP COLUMN source_last_synced_at;
ALTER TABLE public.bond_issuance DROP COLUMN projected_at;
ALTER TABLE public.bond_issuance DROP COLUMN placement_source_hash;
ALTER TABLE public.bond_issuance DROP COLUMN placement_recorded_at;

DELETE FROM public.quant_input WHERE dataset IN ('issue','issue_pricing_quarantine');
-- The report is the authoritative LCR/NSFR observation on overlapping dates.
DELETE FROM public.quant_input company USING public.quant_input report
WHERE company.dataset='company' AND report.dataset='company_report'
  AND company.field=report.field AND company.observation_date=report.observation_date;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.quant_input GROUP BY field,observation_date HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'quant_input field/date keys remain ambiguous';
  END IF;
END $$;
ALTER TABLE public.quant_input DROP CONSTRAINT quant_input_pkey;
DROP INDEX public.quant_input_date_idx;
ALTER TABLE public.quant_input DROP COLUMN dataset;
ALTER TABLE public.quant_input DROP COLUMN entity_key;
ALTER TABLE public.quant_input DROP COLUMN source;
ALTER TABLE public.quant_input DROP COLUMN source_key;
ALTER TABLE public.quant_input DROP COLUMN source_hash;
ALTER TABLE public.quant_input DROP COLUMN first_ingested_at;
ALTER TABLE public.quant_input DROP COLUMN synced_at;
ALTER TABLE public.quant_input ADD PRIMARY KEY (field, observation_date);
CREATE INDEX quant_input_date_idx ON public.quant_input(observation_date DESC, field);
COMMENT ON TABLE public.quant_input IS 'Market and company observations by field/date. Issue facts live in bond_issuance; missing values have no row. On overlapping company LCR/NSFR dates, the fund report wins.';

DROP TABLE public.bond_history_version;
DROP TABLE public.bond_history_request;
DROP TABLE public.bond_placement_request;
DROP TABLE public.quant_input_sync;
