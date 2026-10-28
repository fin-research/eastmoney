-- Snapshot-to-diff conversion. Historical authors were not recorded and remain NULL.
SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));
CREATE TABLE credit.diff (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  institution_name text NOT NULL CHECK (btrim(institution_name) <> ''),
  effective_on date NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text,
  updated_at timestamptz,
  cleared_fields text[] NOT NULL DEFAULT '{}',
  institution_type text,
  confidentiality_status boolean,
  status credit.credit_status,
  total numeric(20,6) CHECK (total >= 0),
  effective_date date,
  expiry_date date,
  bank_office text,
  applying_department text,
  handler text,
  detail text,
  bond_preference text,
  notes text,
  bond_investment_limit numeric(20,6) CHECK (bond_investment_limit >= 0),
  bond_investment_detail text,
  yield_certificate_limit numeric(20,6) CHECK (yield_certificate_limit >= 0),
  yield_certificate_detail text,
  legal_overdraft_limit numeric(20,6) CHECK (legal_overdraft_limit >= 0),
  legal_overdraft_detail text,
  margin_income_rights_limit numeric(20,6) CHECK (margin_income_rights_limit >= 0),
  margin_income_rights_detail text,
  interbank_lending_limit numeric(20,6) CHECK (interbank_lending_limit >= 0),
  interbank_lending_detail text,
  other_limit numeric(20,6) CHECK (other_limit >= 0),
  other_detail text,
  bond_investment_used numeric(20,6),
  legal_overdraft_used numeric(20,6),
  margin_income_rights_used numeric(20,6),
  other_used numeric(20,6)
);
CREATE INDEX credit_diff_as_of_idx ON credit.diff(institution_name,effective_on DESC,created_at DESC,id DESC);
CREATE INDEX credit_diff_date_idx ON credit.diff(effective_on);
COMMENT ON TABLE credit.diff IS '授信逐字段追加变更；NULL表示未变，cleared_fields表示显式清空';
COMMENT ON COLUMN credit.diff.effective_on IS '业务生效日；补录历史不改变自动创建时间';
COMMENT ON COLUMN credit.diff.detail IS '授信额度的自然语言表述';
COMMENT ON COLUMN credit.diff.notes IS '人工备注';
COMMENT ON COLUMN credit.diff.created_by IS 'Auth0 user id；迁移历史作者未知时为空';

CREATE FUNCTION credit.state_as_of(as_of date)
RETURNS SETOF credit.diff LANGUAGE sql STABLE AS $$
  WITH entries AS (
    SELECT d.institution_name,d.effective_on,d.created_at,d.id,e.key,e.value
    FROM credit.diff d CROSS JOIN LATERAL jsonb_each(to_jsonb(d) - '{id,institution_name,effective_on,created_at,created_by,updated_at,cleared_fields}'::text[]) e
    WHERE d.effective_on <= as_of AND (e.value <> 'null'::jsonb OR e.key=ANY(d.cleared_fields))
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

CREATE FUNCTION credit.append_diff(on_date date, name text, patch jsonb, actor text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE previous jsonb; changes jsonb; cleared text[]; inserted_id bigint; result credit.diff; allowed text[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));
  IF on_date IS NULL OR name IS NULL OR btrim(name)='' OR jsonb_typeof(patch) <> 'object' THEN
    RAISE EXCEPTION 'Invalid credit diff input';
  END IF;
  -- jsonb_populate_record supplies typed NULL fields without allowing audit/identity changes.
  SELECT array_agg(key) INTO allowed FROM jsonb_object_keys(to_jsonb(jsonb_populate_record(NULL::credit.diff,'{}')) - '{id,institution_name,effective_on,created_at,created_by,updated_at,cleared_fields}'::text[]) key;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(patch) key WHERE NOT key=ANY(allowed)) THEN
    RAISE EXCEPTION 'Unknown credit diff field';
  END IF;
  -- Compare typed values so numeric(20,6) rounding cannot create repeated false diffs.
  SELECT jsonb_object_agg(e.key,typed.data->e.key) INTO patch
    FROM jsonb_each(patch) e CROSS JOIN LATERAL
      (SELECT to_jsonb(r) AS data FROM jsonb_populate_record(NULL::credit.diff,patch) r) typed;
  SELECT to_jsonb(s) INTO previous FROM credit.state_as_of(on_date) s WHERE institution_name=name;
  SELECT jsonb_object_agg(key,value) INTO changes FROM jsonb_each(patch)
    WHERE value IS DISTINCT FROM coalesce(previous->key,'null'::jsonb);
  IF changes IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(array_agg(key),'{}') INTO cleared FROM jsonb_each(changes) WHERE value='null'::jsonb;
  INSERT INTO credit.diff(institution_name,effective_on,created_by,cleared_fields,institution_type,confidentiality_status,status,total,effective_date,expiry_date,bank_office,applying_department,handler,detail,bond_preference,notes,bond_investment_limit,bond_investment_detail,yield_certificate_limit,yield_certificate_detail,legal_overdraft_limit,legal_overdraft_detail,margin_income_rights_limit,margin_income_rights_detail,interbank_lending_limit,interbank_lending_detail,other_limit,other_detail,bond_investment_used,legal_overdraft_used,margin_income_rights_used,other_used)
  SELECT name,on_date,actor,cleared,r.institution_type,r.confidentiality_status,r.status,r.total,r.effective_date,r.expiry_date,r.bank_office,r.applying_department,r.handler,r.detail,r.bond_preference,r.notes,r.bond_investment_limit,r.bond_investment_detail,r.yield_certificate_limit,r.yield_certificate_detail,r.legal_overdraft_limit,r.legal_overdraft_detail,r.margin_income_rights_limit,r.margin_income_rights_detail,r.interbank_lending_limit,r.interbank_lending_detail,r.other_limit,r.other_detail,r.bond_investment_used,r.legal_overdraft_used,r.margin_income_rights_used,r.other_used FROM jsonb_populate_record(NULL::credit.diff,changes) r
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

-- Retain every old reporting cut, including a revocation when a name disappears.
DO $$
DECLARE d date; row record; payload jsonb;
BEGIN
  FOR d IN SELECT DISTINCT report_date FROM credit.institution ORDER BY report_date LOOP
    FOR row IN
      SELECT DISTINCT ON (institution_name) * FROM credit.institution WHERE report_date<=d
      ORDER BY institution_name,report_date DESC
    LOOP
      payload := (to_jsonb(row)-'{report_date,institution_name,total_limit,total_used,notes,usage_details,updated_at}'::text[])
        || jsonb_build_object('total',row.total_limit,'detail',row.notes,'notes',row.usage_details,
          'status',CASE WHEN row.report_date<d THEN 'revoked' ELSE row.status::text END);
      payload := payload || coalesce((SELECT jsonb_object_agg(key,value) FROM (
        SELECT i.item_type::text||'_limit' key,to_jsonb(i.limit_amount) value FROM credit.item i WHERE i.report_date=row.report_date AND i.institution_name=row.institution_name
        UNION ALL SELECT i.item_type::text||'_detail',to_jsonb(i.details) FROM credit.item i WHERE i.report_date=row.report_date AND i.institution_name=row.institution_name
        UNION ALL SELECT i.item_type::text||'_used',to_jsonb(i.used_amount) FROM credit.item i WHERE i.report_date=row.report_date AND i.institution_name=row.institution_name AND i.item_type NOT IN ('yield_certificate','interbank_lending')
      ) fields),'{}');
      PERFORM credit.append_diff(d,row.institution_name,payload,NULL);
    END LOOP;
  END LOOP;
END $$;

-- Only exceptional, explicit historical correction may mutate a recorded row.
CREATE FUNCTION credit.guard_diff_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Credit diff rows cannot be deleted'; END IF;
  IF current_setting('credit.correct_history',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Credit diff rows are append only; enable credit.correct_history for a historical correction';
  END IF;
  IF NEW.id<>OLD.id OR NEW.created_at<>OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Credit diff creation provenance is immutable';
  END IF;
  NEW.updated_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER guard_diff_history BEFORE UPDATE OR DELETE ON credit.diff FOR EACH ROW EXECUTE FUNCTION credit.guard_diff_history();
CREATE TRIGGER link_institution_clients AFTER INSERT ON credit.diff FOR EACH ROW EXECUTE FUNCTION credit.link_institution_clients();

DROP VIEW credit.institution_usage;
DROP VIEW credit.usage_reconciliation;
DROP VIEW credit.item_usage;
DROP FUNCTION credit.refresh_institution_events();
DROP TABLE credit.institution_event;
DROP TABLE credit.item;
DROP TABLE credit.institution;
DROP FUNCTION credit.set_institution_usage_sum();
DROP FUNCTION credit.sync_item_usage_sum();
REVOKE ALL ON credit.diff FROM PUBLIC;
REVOKE ALL ON FUNCTION credit.state_as_of(date),credit.append_diff(date,text,jsonb,text),credit.guard_diff_history() FROM PUBLIC;
