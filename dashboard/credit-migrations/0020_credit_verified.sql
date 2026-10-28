-- Explicit report-day verification, without changing historical business values.
SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));
ALTER TABLE credit.entry ADD COLUMN verified boolean NOT NULL DEFAULT false;
ALTER TYPE credit.entry_state ADD ATTRIBUTE verified boolean;

CREATE OR REPLACE FUNCTION credit.entry_as_of(as_of date,institution_names text[] DEFAULT NULL)
RETURNS SETOF credit.entry_state LANGUAGE sql STABLE AS $$
  WITH latest AS (
    SELECT DISTINCT ON(e.institution_id,e.field_id) e.*
    FROM credit.entry e JOIN credit.institution i ON i.id=e.institution_id
    WHERE e.report_date<=as_of AND (institution_names IS NULL OR i.name=ANY(institution_names))
    ORDER BY e.institution_id,e.field_id,e.report_date DESC
  ), states AS (
    SELECT institution_id,jsonb_object_agg(field_id,coalesce(to_jsonb(v_num),to_jsonb(v_date),to_jsonb(v_text))) AS data,
      max(report_date) AS last_changed_on,max(created_at) AS created_at,max(updated_at) AS updated_at
    FROM latest GROUP BY institution_id
  )
  SELECT r.* FROM states s JOIN credit.institution i ON i.id=s.institution_id
  CROSS JOIN LATERAL jsonb_populate_record(NULL::credit.entry_state,
    s.data || (to_jsonb(i)-'{id,name}'::text[]) || jsonb_build_object(
      'institution_id',i.id,'institution_name',i.name,'last_changed_on',s.last_changed_on,
      'verified',coalesce((SELECT bool_or(e.verified) FROM credit.entry e WHERE e.institution_id=i.id AND e.report_date=as_of),false),
      'created_at',s.created_at,'updated_at',s.updated_at,'status',CASE
        WHEN s.data->>'expiry_date'='1970-01-01' THEN 'revoked'
        WHEN (s.data->>'expiry_date')::date>=as_of THEN 'approved'
        WHEN s.data->>'expiry_date' IS NOT NULL THEN 'applying' ELSE coalesce(s.data->>'status','applying') END)) r
$$;

CREATE OR REPLACE FUNCTION credit.append_entry(on_date date,name text,patch jsonb,actor text,event_type credit.entry_event DEFAULT 'maintenance')
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE iid bigint; previous jsonb; merged_event credit.entry_event; old_event credit.entry_event;
  field record; value jsonb; changed boolean:=false; day_verified boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));
  IF to_regclass('credit.diff') IS NOT NULL AND current_setting('credit.mirror_legacy',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Credit entry writes await cutover';
  END IF;
  IF on_date IS NULL OR name IS NULL OR btrim(name)='' OR patch IS NULL OR jsonb_typeof(patch)<>'object' THEN
    RAISE EXCEPTION 'Invalid credit entry input';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(patch) k WHERE NOT EXISTS(SELECT 1 FROM credit.metric m WHERE m.id=k)
    AND k NOT IN ('institution_type','confidentiality_status','bank_office','applying_department','handler','bond_preference','verified')) THEN
    RAISE EXCEPTION 'Unknown credit entry field';
  END IF;
  IF patch ? 'verified' AND jsonb_typeof(patch->'verified') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'Credit verified must be boolean';
  END IF;
  SELECT id INTO iid FROM credit.institution WHERE institution.name=append_entry.name FOR UPDATE;
  IF iid IS NULL THEN
    INSERT INTO credit.institution(name,institution_type,confidentiality_status,bank_office,applying_department,handler,bond_preference)
    VALUES(name,patch->>'institution_type',coalesce((patch->>'confidentiality_status')::boolean,false),patch->>'bank_office',
      patch->>'applying_department',patch->>'handler',patch->>'bond_preference') RETURNING id INTO iid;
    changed:=true;
  ELSE
    SELECT to_jsonb(s) INTO previous FROM credit.entry_as_of(on_date,ARRAY[name]) s;
    previous:=previous||jsonb_build_object('status',(SELECT v_text FROM credit.entry
      WHERE institution_id=iid AND field_id='status' AND report_date<=on_date ORDER BY report_date DESC LIMIT 1));
    UPDATE credit.institution i SET
      institution_type=CASE WHEN patch ? 'institution_type' THEN patch->>'institution_type' ELSE i.institution_type END,
      confidentiality_status=CASE WHEN patch ? 'confidentiality_status' THEN (patch->>'confidentiality_status')::boolean ELSE i.confidentiality_status END,
      bank_office=CASE WHEN patch ? 'bank_office' THEN patch->>'bank_office' ELSE i.bank_office END,
      applying_department=CASE WHEN patch ? 'applying_department' THEN patch->>'applying_department' ELSE i.applying_department END,
      handler=CASE WHEN patch ? 'handler' THEN patch->>'handler' ELSE i.handler END,
      bond_preference=CASE WHEN patch ? 'bond_preference' THEN patch->>'bond_preference' ELSE i.bond_preference END
    WHERE i.id=iid AND EXISTS(SELECT 1 FROM jsonb_each(patch) p
      WHERE p.key IN ('institution_type','confidentiality_status','bank_office','applying_department','handler','bond_preference')
        AND p.value IS DISTINCT FROM to_jsonb(i)->p.key);
    changed:=FOUND;
  END IF;
  SELECT coalesce(bool_or(verified),false) INTO day_verified FROM credit.entry WHERE institution_id=iid AND report_date=on_date;
  IF patch ? 'verified' THEN day_verified:=(patch->>'verified')::boolean; END IF;
  SELECT event INTO old_event FROM credit.entry WHERE institution_id=iid AND report_date=on_date LIMIT 1;
  merged_event:=CASE
    WHEN event_type='maintenance' THEN coalesce(old_event,event_type)
    WHEN old_event IS NULL OR old_event='maintenance' THEN event_type
    WHEN old_event='revocation' OR event_type='revocation' THEN 'revocation'::credit.entry_event
    WHEN old_event='new' OR event_type='new' THEN 'new'::credit.entry_event
    WHEN old_event='increase' OR event_type='increase' THEN 'increase'::credit.entry_event ELSE event_type END;
  PERFORM set_config('credit.entry_write','on',true);
  FOR field IN SELECT m.* FROM credit.metric m WHERE patch ? m.id LOOP
    value:=patch->field.id;
    IF value='null'::jsonb THEN CONTINUE; END IF;
    value:=CASE field.type WHEN 'num' THEN to_jsonb((value#>>'{}')::numeric(20,6))
      WHEN 'date' THEN to_jsonb((value#>>'{}')::date) ELSE to_jsonb(value#>>'{}') END;
    IF value IS NOT DISTINCT FROM previous->field.id THEN CONTINUE; END IF;
    INSERT INTO credit.entry(report_date,field_id,institution_id,v_num,v_date,v_text,event,created_by,verified)
    VALUES(on_date,field.id,iid,CASE WHEN field.type='num' THEN (value#>>'{}')::numeric END,
      CASE WHEN field.type='date' THEN (value#>>'{}')::date END,
      CASE WHEN field.type='text' THEN value#>>'{}' END,merged_event,actor,day_verified)
    ON CONFLICT(report_date,field_id,institution_id) DO UPDATE SET
      v_num=excluded.v_num,v_date=excluded.v_date,v_text=excluded.v_text,event=excluded.event,updated_at=clock_timestamp();
    changed:=true;
  END LOOP;
  -- A newly registered institution or an explicit event needs a date even if all business values are missing.
  IF NOT EXISTS(SELECT 1 FROM credit.entry WHERE institution_id=iid AND report_date<=on_date)
    OR day_verified AND NOT EXISTS(SELECT 1 FROM credit.entry WHERE institution_id=iid AND report_date=on_date)
    OR event_type<>'maintenance' AND NOT EXISTS(SELECT 1 FROM credit.entry WHERE institution_id=iid AND report_date=on_date) THEN
    INSERT INTO credit.entry(report_date,field_id,institution_id,v_text,event,created_by,verified)
    VALUES(on_date,'notes',iid,coalesce(previous->>'notes',''),merged_event,actor,day_verified);
    changed:=true;
  END IF;
  IF patch ? 'verified' THEN
    UPDATE credit.entry SET verified=day_verified WHERE institution_id=iid AND report_date=on_date AND verified IS DISTINCT FROM day_verified;
    changed:=changed OR FOUND;
  END IF;
  UPDATE credit.entry SET event=merged_event WHERE institution_id=iid AND report_date=on_date AND event<>merged_event;
  PERFORM set_config('credit.entry_write','off',true);
  IF EXISTS(SELECT 1 FROM (SELECT DISTINCT report_date FROM credit.entry WHERE institution_id=iid AND report_date>=on_date) d
    CROSS JOIN LATERAL credit.entry_as_of(d.report_date,ARRAY[name]) s
    WHERE s.expiry_date<>DATE '1970-01-01' AND s.effective_date>s.expiry_date) THEN
    RAISE EXCEPTION 'Credit expiry precedes effective date';
  END IF;
  RETURN CASE WHEN changed THEN iid ELSE NULL END;
END $$;

