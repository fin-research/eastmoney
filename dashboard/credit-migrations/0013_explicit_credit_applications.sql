-- One institution has one business change per day. Preserve the original rows
-- and every subsequent same-day revision before replacing their sparse values.
SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import', 0));
LOCK TABLE credit.diff IN ACCESS EXCLUSIVE MODE;

CREATE TABLE credit.diff_merge_archive (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id bigint NOT NULL,
  merged_id bigint NOT NULL,
  original_row jsonb NOT NULL,
  changed_by text,
  archived_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE credit.diff_merge_archive IS '同日授信变更合并前的完整原记录及后续修订';
REVOKE ALL ON credit.diff_merge_archive FROM PUBLIC;

CREATE TEMP TABLE credit_snapshots_before ON COMMIT DROP AS
SELECT business_date, coalesce((
  SELECT jsonb_agg(to_jsonb(s) - '{id,effective_on,created_at,created_by,updated_at}'::text[] ORDER BY s.institution_name)
  FROM credit.state_as_of(business_date) s
), '[]'::jsonb) AS snapshot
FROM (SELECT DISTINCT effective_on AS business_date FROM credit.diff) dates;

ALTER TABLE credit.diff DISABLE TRIGGER guard_diff_history;
DO $$
DECLARE group_row record; source_row record; keeper_id bigint; payload jsonb; field_names text;
BEGIN
  SELECT string_agg(format('%I', attname), ',' ORDER BY attnum) INTO field_names
  FROM pg_attribute WHERE attrelid='credit.diff'::regclass AND attnum>0 AND NOT attisdropped
    AND attname NOT IN ('id','institution_name','effective_on','created_at','created_by','updated_at');
  FOR group_row IN
    SELECT institution_name,effective_on FROM credit.diff
    GROUP BY institution_name,effective_on HAVING count(*)>1
  LOOP
    SELECT id INTO keeper_id FROM credit.diff
    WHERE institution_name=group_row.institution_name AND effective_on=group_row.effective_on
    ORDER BY created_at,id LIMIT 1;
    FOR source_row IN SELECT * FROM credit.diff
      WHERE institution_name=group_row.institution_name AND effective_on=group_row.effective_on
      ORDER BY created_at,id
    LOOP
      INSERT INTO credit.diff_merge_archive(source_id,merged_id,original_row,changed_by)
      VALUES(source_row.id,keeper_id,to_jsonb(source_row),source_row.created_by);
    END LOOP;
    SELECT jsonb_object_agg(key,value) INTO payload FROM (
      SELECT DISTINCT ON (e.key) e.key,e.value
      FROM credit.diff d CROSS JOIN LATERAL jsonb_each(to_jsonb(d) -
        '{id,institution_name,effective_on,created_at,created_by,updated_at}'::text[]) e
      WHERE d.institution_name=group_row.institution_name AND d.effective_on=group_row.effective_on
        AND e.value<>'null'::jsonb
      ORDER BY e.key,d.created_at DESC,d.id DESC
    ) latest;
    EXECUTE format('UPDATE credit.diff SET (%s)=(SELECT %s FROM jsonb_populate_record(NULL::credit.diff,$1) r) WHERE id=$2',field_names,field_names)
      USING payload,keeper_id;
    DELETE FROM credit.diff WHERE institution_name=group_row.institution_name
      AND effective_on=group_row.effective_on AND id<>keeper_id;
  END LOOP;
END $$;
ALTER TABLE credit.diff ENABLE TRIGGER guard_diff_history;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM credit_snapshots_before b WHERE b.snapshot IS DISTINCT FROM coalesce((
      SELECT jsonb_agg(to_jsonb(s) - '{id,effective_on,created_at,created_by,updated_at}'::text[] ORDER BY s.institution_name)
      FROM credit.state_as_of(b.business_date) s
    ),'[]'::jsonb)
  ) THEN RAISE EXCEPTION 'Credit state changed during same-day consolidation'; END IF;
END $$;

CREATE UNIQUE INDEX credit_diff_institution_day_idx ON credit.diff(institution_name,effective_on);
ALTER TABLE credit.diff ADD COLUMN type text NOT NULL DEFAULT 'maintenance'
  CONSTRAINT credit_diff_type_check CHECK (type IN ('maintenance','new','renewal','increase','renewal_increase','revocation'));
COMMENT ON COLUMN credit.diff.type IS '授信申请事件；maintenance 为日常维护，renewal_increase 为同日续期及扩额';

-- Historical import is the baseline. Later events are classified once from the
-- net daily result, then remain stored facts instead of being re-inferred by UI.
ALTER TABLE credit.diff DISABLE TRIGGER guard_diff_history;
DO $$
DECLARE row_data credit.diff; before_state credit.diff; after_state credit.diff; first_date date;
  renewed boolean; increased boolean; next_type text;
BEGIN
  SELECT min(effective_on) INTO first_date FROM credit.diff;
  FOR row_data IN SELECT * FROM credit.diff ORDER BY effective_on,created_at,id LOOP
    IF row_data.effective_on=first_date THEN CONTINUE; END IF;
    SELECT * INTO before_state FROM credit.state_as_of(row_data.effective_on-1)
      WHERE institution_name=row_data.institution_name;
    SELECT * INTO after_state FROM credit.state_as_of(row_data.effective_on)
      WHERE institution_name=row_data.institution_name;
    renewed := before_state.expiry_date IS NOT NULL AND after_state.expiry_date>before_state.expiry_date
      AND (before_state.status='approved' OR after_state.status='approved');
    increased := before_state.total IS NOT NULL AND after_state.total>before_state.total;
    next_type := CASE
      WHEN after_state.status='revoked' AND before_state.status IS DISTINCT FROM 'revoked' THEN 'revocation'
      WHEN after_state.status='approved' AND (before_state.id IS NULL OR before_state.status IS DISTINCT FROM 'approved') THEN 'new'
      WHEN renewed AND increased THEN 'renewal_increase'
      WHEN renewed THEN 'renewal'
      WHEN increased AND (after_state.status='approved' OR before_state.status='approved') THEN 'increase'
      ELSE 'maintenance' END;
    UPDATE credit.diff SET type=next_type WHERE id=row_data.id;
  END LOOP;
END $$;
ALTER TABLE credit.diff ENABLE TRIGGER guard_diff_history;

CREATE OR REPLACE FUNCTION credit.state_as_of(as_of date)
RETURNS SETOF credit.diff LANGUAGE sql STABLE AS $$
  WITH entries AS (
    SELECT d.institution_name,d.effective_on,d.created_at,d.id,e.key,e.value
    FROM credit.diff d CROSS JOIN LATERAL jsonb_each(to_jsonb(d) -
      '{id,institution_name,effective_on,created_at,created_by,updated_at,type}'::text[]) e
    WHERE d.effective_on<=as_of AND e.value<>'null'::jsonb
  ), latest AS (
    SELECT DISTINCT ON (institution_name,key) institution_name,key,value
    FROM entries ORDER BY institution_name,key,effective_on DESC,created_at DESC,id DESC
  ), states AS (
    SELECT institution_name,jsonb_object_agg(key,value) AS data FROM latest GROUP BY institution_name
  )
  SELECT (jsonb_populate_record(NULL::credit.diff,s.data || jsonb_build_object(
    'institution_name',s.institution_name,'effective_on',as_of,'id',d.id,
    'created_at',d.created_at,'created_by',d.created_by,'updated_at',d.updated_at,'type',d.type))).*
  FROM states s CROSS JOIN LATERAL (
    SELECT * FROM credit.diff d WHERE d.institution_name=s.institution_name AND d.effective_on<=as_of
    ORDER BY effective_on DESC,created_at DESC,id DESC LIMIT 1
  ) d
$$;

CREATE OR REPLACE FUNCTION credit.guard_diff_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Credit diff rows cannot be deleted'; END IF;
  IF current_setting('credit.correct_history',true) IS DISTINCT FROM 'on'
     AND current_setting('credit.merge_same_day',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Credit diff rows are append only; enable credit.correct_history for a historical correction';
  END IF;
  IF NEW.id<>OLD.id OR NEW.institution_name<>OLD.institution_name OR NEW.effective_on<>OLD.effective_on
     OR NEW.created_at<>OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Credit diff creation provenance is immutable';
  END IF;
  NEW.updated_at:=clock_timestamp(); RETURN NEW;
END $$;

DROP FUNCTION credit.append_diff(date,text,jsonb,text);
CREATE FUNCTION credit.append_diff(on_date date, name text, patch jsonb, actor text, event_type text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE previous jsonb; changes jsonb; inserted_id bigint; result credit.diff; existing credit.diff;
  allowed text[]; field_names text; merged_type text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));
  IF on_date IS NULL OR name IS NULL OR btrim(name)='' OR jsonb_typeof(patch)<>'object'
     OR event_type NOT IN ('maintenance','new','renewal','increase','renewal_increase','revocation') THEN
    RAISE EXCEPTION 'Invalid credit diff input';
  END IF;
  SELECT array_agg(key) INTO allowed FROM jsonb_object_keys(to_jsonb(jsonb_populate_record(NULL::credit.diff,'{}')) -
    '{id,institution_name,effective_on,created_at,created_by,updated_at,type}'::text[]) key;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(patch) key WHERE NOT key=ANY(allowed)) THEN
    RAISE EXCEPTION 'Unknown credit diff field';
  END IF;
  patch:=jsonb_strip_nulls(patch);
  SELECT jsonb_object_agg(e.key,typed.data->e.key) INTO patch
    FROM jsonb_each(patch) e CROSS JOIN LATERAL
      (SELECT to_jsonb(r) AS data FROM jsonb_populate_record(NULL::credit.diff,patch) r) typed;
  SELECT to_jsonb(s) INTO previous FROM credit.state_as_of(on_date) s WHERE institution_name=name;
  SELECT jsonb_object_agg(key,value) INTO changes FROM jsonb_each(patch)
    WHERE value IS DISTINCT FROM coalesce(previous->key,'null'::jsonb);
  IF changes IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO existing FROM credit.diff WHERE institution_name=name AND effective_on=on_date FOR UPDATE;
  IF existing.id IS NULL THEN
    INSERT INTO credit.diff(institution_name,effective_on,created_by,type,institution_type,confidentiality_status,status,total,effective_date,expiry_date,bank_office,applying_department,handler,detail,bond_preference,notes,bond_investment_limit,bond_investment_detail,yield_certificate_limit,yield_certificate_detail,legal_overdraft_limit,legal_overdraft_detail,interbank_lending_limit,interbank_lending_detail,other_limit,other_detail,bond_investment_used,legal_overdraft_used,other_used,bond_investment_secondary_used)
    SELECT name,on_date,actor,event_type,r.institution_type,r.confidentiality_status,r.status,r.total,r.effective_date,r.expiry_date,r.bank_office,r.applying_department,r.handler,r.detail,r.bond_preference,r.notes,r.bond_investment_limit,r.bond_investment_detail,r.yield_certificate_limit,r.yield_certificate_detail,r.legal_overdraft_limit,r.legal_overdraft_detail,r.interbank_lending_limit,r.interbank_lending_detail,r.other_limit,r.other_detail,r.bond_investment_used,r.legal_overdraft_used,r.other_used,r.bond_investment_secondary_used
    FROM jsonb_populate_record(NULL::credit.diff,changes) r RETURNING id INTO inserted_id;
  ELSE
    merged_type := CASE
      WHEN event_type='maintenance' THEN existing.type
      WHEN existing.type='maintenance' THEN event_type
      WHEN event_type='revocation' OR existing.type='revocation' THEN 'revocation'
      WHEN existing.type='new' OR event_type='new' THEN 'new'
      WHEN existing.type='renewal_increase' OR event_type='renewal_increase'
        OR existing.type='renewal' AND event_type='increase'
        OR existing.type='increase' AND event_type='renewal' THEN 'renewal_increase'
      ELSE event_type END;
    INSERT INTO credit.diff_merge_archive(source_id,merged_id,original_row,changed_by)
    VALUES(existing.id,existing.id,to_jsonb(existing),actor);
    SELECT string_agg(format('%I',attname),',' ORDER BY attnum) INTO field_names FROM pg_attribute
      WHERE attrelid='credit.diff'::regclass AND attnum>0 AND NOT attisdropped
        AND attname NOT IN ('id','institution_name','effective_on','created_at','created_by','updated_at','type');
    PERFORM set_config('credit.merge_same_day','on',true);
    EXECUTE format('UPDATE credit.diff SET (%s,type)=(SELECT %s,$3::text FROM jsonb_populate_record(NULL::credit.diff,$1) r) WHERE id=$2',field_names,field_names)
      USING to_jsonb(existing)||changes,existing.id,merged_type;
    PERFORM set_config('credit.merge_same_day','off',true);
    inserted_id:=existing.id;
  END IF;
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
REVOKE ALL ON FUNCTION credit.append_diff(date,text,jsonb,text,text) FROM PUBLIC;

-- Historical migration tests and the import CLI still use the four-argument
-- maintenance form; both paths now share the same same-day merge behavior.
CREATE FUNCTION credit.append_diff(on_date date, name text, patch jsonb, actor text)
RETURNS bigint LANGUAGE sql AS $$
  SELECT credit.append_diff(on_date,name,patch,actor,'maintenance')
$$;
REVOKE ALL ON FUNCTION credit.append_diff(date,text,jsonb,text) FROM PUBLIC;
