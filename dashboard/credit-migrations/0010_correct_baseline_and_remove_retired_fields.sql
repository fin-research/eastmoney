-- Historical conversion is a correction of the baseline, not new business activity.
SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));
LOCK TABLE credit.diff IN ACCESS EXCLUSIVE MODE;

-- 0009 and its ledger entry were committed in the same transaction. Capture the
-- exact conversion row identities before any UPDATE changes their xmin. Never
-- identify a migration solely by missing authors (old imports have no authors too).
CREATE TEMP TABLE credit_conversion_rows ON COMMIT DROP AS
SELECT d.* FROM credit.diff d JOIN credit.schema_migration m ON d.xmin=m.xmin
WHERE m.name='0009_bond_usage_and_other.sql' AND d.created_by IS NULL AND d.updated_at IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM credit_conversion_rows d
    CROSS JOIN LATERAL jsonb_each(jsonb_strip_nulls(to_jsonb(d) -
      '{id,institution_name,effective_on,created_at,created_by,updated_at,cleared_fields,bond_investment_secondary_used,other_limit,other_used,other_detail}'::text[])) e) THEN
    RAISE EXCEPTION 'Unexpected fields in bond conversion; refusing to alter business diffs';
  END IF;
  IF EXISTS (SELECT 1 FROM credit.diff d CROSS JOIN LATERAL unnest(d.cleared_fields) f
    WHERE f NOT IN ('margin_income_rights_limit','margin_income_rights_used','margin_income_rights_detail')
      AND NOT (d.institution_name='烟台银行' AND f='total')) THEN
    RAISE EXCEPTION 'Unreviewed historical cleared value; correction required before dropping cleared_fields';
  END IF;
END $$;

-- Narrow migration-only bypass; the append-only guard is restored in this same
-- transaction. Original creation provenance is retained on corrected rows.
ALTER TABLE credit.diff DISABLE TRIGGER guard_diff_history;
DO $$
DECLARE r record; baseline_id bigint;
BEGIN
  FOR r IN SELECT * FROM credit_conversion_rows ORDER BY effective_on,created_at,id LOOP
    SELECT d.id INTO baseline_id FROM credit.diff d
      WHERE d.institution_name=r.institution_name AND d.effective_on=r.effective_on
        AND d.id NOT IN (SELECT id FROM credit_conversion_rows)
        AND (d.created_at,d.id)<(r.created_at,r.id)
      ORDER BY d.created_at DESC,d.id DESC LIMIT 1;
    IF baseline_id IS NULL THEN
      -- A later historical reconciliation without an original period row is
      -- a baseline correction, not a newly recorded secondary trade.
      IF r.other_limit IS NOT NULL OR r.other_used IS NOT NULL OR r.other_detail IS NOT NULL
        OR cardinality(r.cleared_fields)>0
        OR NOT EXISTS(SELECT 1 FROM credit.diff d WHERE d.institution_name=r.institution_name AND d.effective_on<r.effective_on) THEN
        RAISE EXCEPTION 'Missing original period for conversion %',r.id;
      END IF;
      SELECT d.id INTO baseline_id FROM credit.diff d
        WHERE d.institution_name=r.institution_name
          AND d.id NOT IN (SELECT id FROM credit_conversion_rows)
        ORDER BY d.effective_on,d.created_at,d.id LIMIT 1;
    END IF;
    UPDATE credit.diff SET
      bond_investment_secondary_used=coalesce(r.bond_investment_secondary_used,bond_investment_secondary_used),
      other_limit=coalesce(r.other_limit,other_limit),other_used=coalesce(r.other_used,other_used),
      other_detail=coalesce(r.other_detail,other_detail),updated_at=clock_timestamp()
    WHERE id=baseline_id;
  END LOOP;
END $$;
DELETE FROM credit.diff WHERE id IN (SELECT id FROM credit_conversion_rows);

-- Confirmed bad imported total: correct its baseline as well as the later clear.
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM credit.diff WHERE institution_name='烟台银行' AND total IS NOT NULL AND total<>3557.35) THEN
    RAISE EXCEPTION 'Unexpected Yantai Bank total; refusing to overwrite';
  END IF;
END $$;
UPDATE credit.diff SET total=NULL,updated_at=clock_timestamp()
WHERE institution_name='烟台银行' AND total=3557.35;
ALTER TABLE credit.diff ENABLE TRIGGER guard_diff_history;

ALTER TABLE credit.diff DROP COLUMN cleared_fields,
  DROP COLUMN margin_income_rights_limit,
  DROP COLUMN margin_income_rights_used,
  DROP COLUMN margin_income_rights_detail;
COMMENT ON TABLE credit.diff IS '授信逐字段变更；NULL表示未变，零和空字符串为有效值；历史迁移直接修订原记录';
COMMENT ON COLUMN credit.diff.effective_date IS '授信起始日，与数据库创建时间及变更业务生效日无关';
COMMENT ON COLUMN credit.diff.expiry_date IS '授信到期日';

CREATE OR REPLACE FUNCTION credit.state_as_of(as_of date)
RETURNS SETOF credit.diff LANGUAGE sql STABLE AS $$
  WITH entries AS (
    SELECT d.institution_name,d.effective_on,d.created_at,d.id,e.key,e.value
    FROM credit.diff d CROSS JOIN LATERAL jsonb_each(to_jsonb(d) - '{id,institution_name,effective_on,created_at,created_by,updated_at}'::text[]) e
    WHERE d.effective_on <= as_of AND e.value <> 'null'::jsonb
  ), latest AS (
    SELECT DISTINCT ON (institution_name,key) institution_name,key,value
    FROM entries ORDER BY institution_name,key,effective_on DESC,created_at DESC,id DESC
  ), states AS (
    SELECT institution_name,jsonb_object_agg(key,value) AS data FROM latest GROUP BY institution_name
  )
  SELECT (jsonb_populate_record(NULL::credit.diff,s.data || jsonb_build_object(
    'institution_name',s.institution_name,'effective_on',as_of,'id',d.id,
    'created_at',d.created_at,'created_by',d.created_by,'updated_at',d.updated_at))).*
  FROM states s CROSS JOIN LATERAL (
    SELECT * FROM credit.diff d WHERE d.institution_name=s.institution_name AND d.effective_on<=as_of
    ORDER BY effective_on DESC,created_at DESC,id DESC LIMIT 1
  ) d
$$;


CREATE OR REPLACE FUNCTION credit.append_diff(on_date date, name text, patch jsonb, actor text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE previous jsonb; changes jsonb; inserted_id bigint; result credit.diff; allowed text[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));
  IF on_date IS NULL OR name IS NULL OR btrim(name)='' OR jsonb_typeof(patch) <> 'object' THEN
    RAISE EXCEPTION 'Invalid credit diff input';
  END IF;
  -- jsonb_populate_record supplies typed NULL fields without allowing audit/identity changes.
  SELECT array_agg(key) INTO allowed FROM jsonb_object_keys(to_jsonb(jsonb_populate_record(NULL::credit.diff,'{}')) - '{id,institution_name,effective_on,created_at,created_by,updated_at}'::text[]) key;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(patch) key WHERE NOT key=ANY(allowed)) THEN
    RAISE EXCEPTION 'Unknown credit diff field';
  END IF;
  patch := jsonb_strip_nulls(patch);
  -- Compare typed values so numeric(20,6) rounding cannot create repeated false diffs.
  SELECT jsonb_object_agg(e.key,typed.data->e.key) INTO patch
    FROM jsonb_each(patch) e CROSS JOIN LATERAL
      (SELECT to_jsonb(r) AS data FROM jsonb_populate_record(NULL::credit.diff,patch) r) typed;
  SELECT to_jsonb(s) INTO previous FROM credit.state_as_of(on_date) s WHERE institution_name=name;
  SELECT jsonb_object_agg(key,value) INTO changes FROM jsonb_each(patch)
    WHERE value IS DISTINCT FROM coalesce(previous->key,'null'::jsonb);
  IF changes IS NULL THEN RETURN NULL; END IF;
  INSERT INTO credit.diff(institution_name,effective_on,created_by,institution_type,confidentiality_status,status,total,effective_date,expiry_date,bank_office,applying_department,handler,detail,bond_preference,notes,bond_investment_limit,bond_investment_detail,yield_certificate_limit,yield_certificate_detail,legal_overdraft_limit,legal_overdraft_detail,interbank_lending_limit,interbank_lending_detail,other_limit,other_detail,bond_investment_used,legal_overdraft_used,other_used,bond_investment_secondary_used)
  SELECT name,on_date,actor,r.institution_type,r.confidentiality_status,r.status,r.total,r.effective_date,r.expiry_date,r.bank_office,r.applying_department,r.handler,r.detail,r.bond_preference,r.notes,r.bond_investment_limit,r.bond_investment_detail,r.yield_certificate_limit,r.yield_certificate_detail,r.legal_overdraft_limit,r.legal_overdraft_detail,r.interbank_lending_limit,r.interbank_lending_detail,r.other_limit,r.other_detail,r.bond_investment_used,r.legal_overdraft_used,r.other_used,r.bond_investment_secondary_used FROM jsonb_populate_record(NULL::credit.diff,changes) r
  RETURNING id INTO inserted_id;
  SELECT * INTO result FROM credit.state_as_of(on_date) WHERE institution_name=name;
  IF result.institution_type IS NULL OR result.status IS NULL OR result.confidentiality_status IS NULL THEN
    RAISE EXCEPTION 'Institution type, status and confidentiality are required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT effective_on FROM credit.diff WHERE institution_name=name AND effective_on>=on_date) dates
    CROSS JOIN LATERAL credit.state_as_of(dates.effective_on) s
    WHERE s.institution_name=name AND s.effective_date>s.expiry_date
  ) THEN RAISE EXCEPTION 'Credit expiry precedes effective date'; END IF;
  RETURN inserted_id;
END $$;
