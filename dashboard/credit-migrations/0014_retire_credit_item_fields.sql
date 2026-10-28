-- Retired fields are archived before removal so historical diff values remain auditable.
SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));
CREATE TABLE IF NOT EXISTS credit.retired_diff_fields (
  diff_id bigint PRIMARY KEY, institution_name text NOT NULL, effective_on date NOT NULL,
  created_at timestamptz NOT NULL, created_by text, archived_values jsonb NOT NULL
);
INSERT INTO credit.retired_diff_fields(diff_id,institution_name,effective_on,created_at,created_by,archived_values)
SELECT id,institution_name,effective_on,created_at,created_by,
  jsonb_strip_nulls(jsonb_build_object('yield_certificate_detail',yield_certificate_detail,
    'legal_overdraft_detail',legal_overdraft_detail,'interbank_lending_detail',interbank_lending_detail,
    'other_limit',other_limit))
FROM credit.diff
WHERE yield_certificate_detail IS NOT NULL OR legal_overdraft_detail IS NOT NULL
   OR interbank_lending_detail IS NOT NULL OR other_limit IS NOT NULL
ON CONFLICT (diff_id) DO NOTHING;

DROP FUNCTION credit.append_diff(date,text,jsonb,text);
CREATE OR REPLACE FUNCTION credit.append_diff(on_date date, name text, patch jsonb, actor text, event_type text)
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
    INSERT INTO credit.diff(institution_name,effective_on,created_by,type,institution_type,confidentiality_status,status,total,effective_date,expiry_date,bank_office,applying_department,handler,detail,bond_preference,notes,bond_investment_limit,bond_investment_detail,yield_certificate_limit,legal_overdraft_limit,interbank_lending_limit,other_detail,bond_investment_used,legal_overdraft_used,other_used,bond_investment_secondary_used)
    SELECT name,on_date,actor,event_type,r.institution_type,r.confidentiality_status,r.status,r.total,r.effective_date,r.expiry_date,r.bank_office,r.applying_department,r.handler,r.detail,r.bond_preference,r.notes,r.bond_investment_limit,r.bond_investment_detail,r.yield_certificate_limit,r.legal_overdraft_limit,r.interbank_lending_limit,r.other_detail,r.bond_investment_used,r.legal_overdraft_used,r.other_used,r.bond_investment_secondary_used
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

ALTER TABLE credit.diff
  DROP COLUMN yield_certificate_detail,
  DROP COLUMN legal_overdraft_detail,
  DROP COLUMN interbank_lending_detail,
  DROP COLUMN other_limit;

CREATE FUNCTION credit.append_diff(on_date date, name text, patch jsonb, actor text)
RETURNS bigint LANGUAGE sql AS $$
  SELECT credit.append_diff(on_date,name,patch,actor,'maintenance')
$$;
REVOKE ALL ON FUNCTION credit.append_diff(date,text,jsonb,text) FROM PUBLIC;
