-- Additive stage: old workers keep writing diff until the deployment is verified.
SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));
LOCK TABLE credit.diff IN SHARE ROW EXCLUSIVE MODE;

CREATE TYPE credit.metric_type AS ENUM ('num','date','text');
CREATE TYPE credit.entry_event AS ENUM ('maintenance','new','renewal','increase','revocation');
CREATE TABLE credit.institution (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (btrim(name)<>''),
  institution_type text NOT NULL,
  confidentiality_status boolean NOT NULL DEFAULT false,
  bank_office text, applying_department text, handler text, bond_preference text,
  UNIQUE(id,name)
);
CREATE TABLE credit.metric (
  id text PRIMARY KEY, name text NOT NULL UNIQUE, type credit.metric_type NOT NULL
);
INSERT INTO credit.metric VALUES
  ('status','审批状态','text'),('effective_date','授信起始日','date'),('expiry_date','授信到期日','date'),
  ('total','授信总额','num'),('detail','授信额度明细','text'),('notes','备注','text'),
  ('bond_investment_limit','债券投资额度','num'),('bond_investment_detail','债券投资说明','text'),
  ('bond_investment_secondary_used','债券二级买卖净余额','num'),
  ('bond_investment_used','历史台账债券已用','num'),
  ('yield_certificate_limit','收益凭证额度','num'),('interbank_lending_limit','同业拆借额度','num'),
  ('legal_overdraft_limit','法透额度','num'),('legal_overdraft_used','法透已用','num'),
  ('other_used','其它已用','num'),('other_detail','其它说明','text');
CREATE TABLE credit.entry (
  report_date date NOT NULL,
  field_id text NOT NULL REFERENCES credit.metric(id),
  institution_id bigint NOT NULL REFERENCES credit.institution(id),
  v_num numeric(20,6), v_date date, v_text text,
  event credit.entry_event NOT NULL DEFAULT 'maintenance',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), created_by text,
  updated_at timestamptz,
  PRIMARY KEY(report_date,field_id,institution_id),
  CHECK (num_nonnulls(v_num,v_date,v_text)=1),
  CHECK (field_id<>'status' OR v_text IN ('approved','applying','revoked')),
  CHECK (field_id NOT IN ('total','bond_investment_limit','yield_certificate_limit','interbank_lending_limit','legal_overdraft_limit') OR v_num>=0)
);
CREATE INDEX credit_entry_latest_idx ON credit.entry(institution_id,field_id,report_date DESC);
CREATE INDEX credit_entry_expiry_idx ON credit.entry(v_date) WHERE field_id='expiry_date';

CREATE FUNCTION credit.validate_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind credit.metric_type;
BEGIN
  SELECT type INTO kind FROM credit.metric WHERE id=NEW.field_id;
  IF (kind='num' AND NEW.v_num IS NULL) OR (kind='date' AND NEW.v_date IS NULL)
    OR (kind='text' AND NEW.v_text IS NULL) THEN RAISE EXCEPTION 'Credit metric value type mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_entry BEFORE INSERT OR UPDATE ON credit.entry FOR EACH ROW EXECUTE FUNCTION credit.validate_entry();
CREATE FUNCTION credit.guard_metric_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type<>OLD.type AND EXISTS(SELECT 1 FROM credit.entry WHERE field_id=OLD.id) THEN
    RAISE EXCEPTION 'Credit metric type cannot change while entries exist';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_metric_type BEFORE UPDATE ON credit.metric FOR EACH ROW EXECUTE FUNCTION credit.guard_metric_type();

CREATE FUNCTION credit.guard_entry_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Credit entries cannot be deleted'; END IF;
  IF (NEW.report_date,NEW.field_id,NEW.institution_id,NEW.created_at,NEW.created_by)
    IS DISTINCT FROM (OLD.report_date,OLD.field_id,OLD.institution_id,OLD.created_at,OLD.created_by) THEN
    RAISE EXCEPTION 'Credit entry identity and creation fields are immutable';
  END IF;
  IF current_setting('credit.entry_write',true) IS DISTINCT FROM 'on'
    AND current_setting('credit.correct_history',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Credit entries are append only';
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;
-- Install after backfill, which may replace old expiry values with the sentinel.

-- Compose current metadata field by field, including false and empty strings.
INSERT INTO credit.institution(name,institution_type,confidentiality_status,bank_office,applying_department,handler,bond_preference)
SELECT institution_name,institution_type,confidentiality_status,bank_office,applying_department,handler,bond_preference
FROM credit.state_as_of((SELECT max(effective_on) FROM credit.diff)) ORDER BY id;
INSERT INTO credit.entry(report_date,field_id,institution_id,v_num,v_date,v_text,event,created_at,created_by,updated_at)
SELECT d.effective_on,m.id,i.id,
  CASE WHEN m.type='num' THEN (e.value#>>'{}')::numeric END,
  CASE WHEN m.type='date' THEN (e.value#>>'{}')::date END,
  CASE WHEN m.type='text' THEN e.value#>>'{}' END,
  d.type::credit.entry_event,d.created_at,d.created_by,d.updated_at
FROM credit.diff d JOIN credit.institution i ON i.name=d.institution_name
CROSS JOIN LATERAL jsonb_each(to_jsonb(d)) e JOIN credit.metric m ON m.id=e.key
WHERE e.value<>'null'::jsonb;

-- Replace manual revocations at their business date, never globally in history.
INSERT INTO credit.entry(report_date,field_id,institution_id,v_date,event,created_at,created_by,updated_at)
SELECT d.effective_on,'expiry_date',i.id,DATE '1970-01-01',d.type::credit.entry_event,d.created_at,d.created_by,d.updated_at
FROM credit.diff d JOIN credit.institution i ON i.name=d.institution_name WHERE d.status='revoked'
ON CONFLICT(report_date,field_id,institution_id) DO UPDATE SET v_date=excluded.v_date;

-- A later recorded approval restores its actual old term after a revocation,
-- including status-only approvals that inherited an unchanged actual term.
INSERT INTO credit.entry(report_date,field_id,institution_id,v_date,event,created_at,created_by,updated_at)
SELECT d.effective_on,'expiry_date',i.id,s.expiry_date,d.type::credit.entry_event,d.created_at,d.created_by,d.updated_at
FROM credit.diff d JOIN credit.institution i ON i.name=d.institution_name
CROSS JOIN LATERAL credit.state_as_of(d.effective_on,ARRAY[d.institution_name]) s
WHERE d.status='approved' AND s.expiry_date IS NOT NULL
  AND EXISTS(SELECT 1 FROM credit.diff old WHERE old.institution_name=d.institution_name AND old.effective_on<d.effective_on AND old.status='revoked')
ON CONFLICT(report_date,field_id,institution_id) DO UPDATE SET v_date=excluded.v_date;

-- Preserve dates/events even when an old row only changed status or metadata.
-- Repeat the inherited note; an unregistered note starts as the empty string.
INSERT INTO credit.entry(report_date,field_id,institution_id,v_text,event,created_at,created_by,updated_at)
SELECT d.effective_on,'notes',i.id,coalesce(s.notes,''),d.type::credit.entry_event,d.created_at,d.created_by,d.updated_at
FROM credit.diff d JOIN credit.institution i ON i.name=d.institution_name
CROSS JOIN LATERAL credit.state_as_of(d.effective_on,ARRAY[d.institution_name]) s
WHERE NOT EXISTS(SELECT 1 FROM credit.entry e WHERE e.institution_id=i.id AND e.report_date=d.effective_on);

ALTER TABLE credit.institution_client ADD COLUMN institution_id bigint;
UPDATE credit.institution_client m SET institution_id=i.id FROM credit.institution i WHERE i.name=m.institution_name;
ALTER TABLE credit.institution_client ALTER COLUMN institution_id SET NOT NULL;
ALTER TABLE credit.institution_client DROP CONSTRAINT institution_client_pkey;
ALTER TABLE credit.institution_client ADD PRIMARY KEY(institution_id,client_id);
ALTER TABLE credit.institution_client ADD CONSTRAINT credit_client_institution_fk
  FOREIGN KEY(institution_id,institution_name) REFERENCES credit.institution(id,name) ON UPDATE CASCADE;

CREATE TRIGGER guard_entry_history BEFORE UPDATE OR DELETE ON credit.entry FOR EACH ROW EXECUTE FUNCTION credit.guard_entry_history();

CREATE TYPE credit.entry_state AS (
  institution_id bigint,institution_name text,institution_type text,confidentiality_status boolean,
  bank_office text,applying_department text,handler text,bond_preference text,
  total numeric,effective_date date,expiry_date date,detail text,notes text,
  bond_investment_limit numeric,bond_investment_detail text,bond_investment_used numeric,
  bond_investment_secondary_used numeric,yield_certificate_limit numeric,interbank_lending_limit numeric,
  legal_overdraft_limit numeric,legal_overdraft_used numeric,other_used numeric,other_detail text,
  status text,last_changed_on date,created_at timestamptz,updated_at timestamptz
);
CREATE FUNCTION credit.entry_as_of(as_of date,institution_names text[] DEFAULT NULL)
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
      'created_at',s.created_at,'updated_at',s.updated_at,'status',CASE
        WHEN s.data->>'expiry_date'='1970-01-01' THEN 'revoked'
        WHEN (s.data->>'expiry_date')::date>=as_of THEN 'approved'
        WHEN s.data->>'expiry_date' IS NOT NULL THEN 'applying' ELSE coalesce(s.data->>'status','applying') END)) r
$$;

-- Abort the entire migration on lost values or an accidental new revocation.
CREATE FUNCTION credit.verify_entry_migration() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT effective_on FROM credit.diff) dates
    CROSS JOIN LATERAL credit.state_as_of(dates.effective_on) old
    LEFT JOIN LATERAL credit.entry_as_of(dates.effective_on,ARRAY[old.institution_name]) new ON true
    CROSS JOIN credit.metric m
    WHERE (CASE
      WHEN m.id='expiry_date' AND old.status='revoked' THEN '"1970-01-01"'::jsonb
      WHEN m.id='notes' THEN to_jsonb(coalesce(old.notes,'')) ELSE to_jsonb(old)->m.id END)
      IS DISTINCT FROM (CASE
        WHEN m.id='status' THEN (SELECT to_jsonb(e.v_text) FROM credit.entry e
          WHERE e.institution_id=new.institution_id AND e.field_id='status' AND e.report_date<=dates.effective_on
          ORDER BY e.report_date DESC LIMIT 1)
        WHEN m.id='notes' THEN to_jsonb(coalesce(new.notes,'')) ELSE to_jsonb(new)->m.id END)
  ) THEN RAISE EXCEPTION 'Credit entry historical value reconciliation failed'; END IF;
  IF EXISTS (
    SELECT institution_name FROM credit.state_as_of((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date) WHERE status='revoked'
    EXCEPT SELECT institution_name FROM credit.entry_as_of((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date) WHERE status='revoked'
  ) OR EXISTS (
    SELECT institution_name FROM credit.entry_as_of((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date) WHERE status='revoked'
    EXCEPT SELECT institution_name FROM credit.state_as_of((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date) WHERE status='revoked'
  ) THEN RAISE EXCEPTION 'Credit entry revoked institution set changed'; END IF;
END $$;
REVOKE ALL ON FUNCTION credit.verify_entry_migration() FROM PUBLIC;
SELECT credit.verify_entry_migration();

-- Existing consumers still use a name projection; stable ID and name are one FK.
CREATE OR REPLACE FUNCTION credit.link_institution_clients() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,credit AS $$
DECLARE candidate_ids bigint[]; candidate_count integer; iid bigint; iname text;
BEGIN
  IF TG_TABLE_NAME='institution' THEN iid:=NEW.id; iname:=NEW.name;
  ELSE SELECT id INTO iid FROM credit.institution WHERE name=NEW.institution_name; iname:=NEW.institution_name; END IF;
  IF iid IS NULL OR EXISTS(SELECT 1 FROM credit.institution_client WHERE institution_id=iid) THEN RETURN NEW; END IF;
  SELECT array_agg(DISTINCT public.resolve_client(part)),count(*) INTO candidate_ids,candidate_count
    FROM regexp_split_to_table(iname,'[&＆]') part;
  IF array_position(candidate_ids,NULL) IS NULL AND cardinality(candidate_ids)=candidate_count
    AND NOT EXISTS(SELECT 1 FROM credit.institution_client WHERE client_id=ANY(candidate_ids)) THEN
    INSERT INTO credit.institution_client(institution_id,institution_name,client_id,notes)
      SELECT iid,iname,unnest(candidate_ids),'完整名称自动匹配';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER link_institution_clients AFTER INSERT ON credit.institution FOR EACH ROW EXECUTE FUNCTION credit.link_institution_clients();

CREATE FUNCTION credit.append_entry(on_date date,name text,patch jsonb,actor text,event_type credit.entry_event DEFAULT 'maintenance')
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE iid bigint; previous jsonb; merged_event credit.entry_event; old_event credit.entry_event;
  field record; value jsonb; changed boolean:=false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));
  IF to_regclass('credit.diff') IS NOT NULL AND current_setting('credit.mirror_legacy',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Credit entry writes await cutover';
  END IF;
  IF on_date IS NULL OR name IS NULL OR btrim(name)='' OR patch IS NULL OR jsonb_typeof(patch)<>'object' THEN
    RAISE EXCEPTION 'Invalid credit entry input';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(patch) k WHERE NOT EXISTS(SELECT 1 FROM credit.metric m WHERE m.id=k)
    AND k NOT IN ('institution_type','confidentiality_status','bank_office','applying_department','handler','bond_preference')) THEN
    RAISE EXCEPTION 'Unknown credit entry field';
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
    INSERT INTO credit.entry(report_date,field_id,institution_id,v_num,v_date,v_text,event,created_by)
    VALUES(on_date,field.id,iid,CASE WHEN field.type='num' THEN (value#>>'{}')::numeric END,
      CASE WHEN field.type='date' THEN (value#>>'{}')::date END,
      CASE WHEN field.type='text' THEN value#>>'{}' END,merged_event,actor)
    ON CONFLICT(report_date,field_id,institution_id) DO UPDATE SET
      v_num=excluded.v_num,v_date=excluded.v_date,v_text=excluded.v_text,event=excluded.event,updated_at=clock_timestamp();
    changed:=true;
  END LOOP;
  -- A newly registered institution or an explicit event needs a date even if all business values are missing.
  IF NOT EXISTS(SELECT 1 FROM credit.entry WHERE institution_id=iid AND report_date<=on_date)
    OR event_type<>'maintenance' AND NOT EXISTS(SELECT 1 FROM credit.entry WHERE institution_id=iid AND report_date=on_date) THEN
    INSERT INTO credit.entry(report_date,field_id,institution_id,v_text,event,created_by)
    VALUES(on_date,'notes',iid,coalesce(previous->>'notes',''),merged_event,actor);
    changed:=true;
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

-- Mirror only actual changes. Old same-day sparse rows can contain stale values.
CREATE FUNCTION credit.mirror_legacy_diff() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payload jsonb; expiry date;
BEGIN
  IF TG_OP='INSERT' THEN payload:=jsonb_strip_nulls(to_jsonb(NEW));
  ELSE SELECT coalesce(jsonb_object_agg(p.key,p.value),'{}') INTO payload FROM jsonb_each(to_jsonb(NEW)) p
    WHERE p.value IS DISTINCT FROM to_jsonb(OLD)->p.key AND p.value<>'null'::jsonb; END IF;
  payload:=payload-'{id,institution_name,effective_on,created_at,created_by,updated_at,type}'::text[];
  IF NEW.status='revoked' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    payload:=payload||jsonb_build_object('expiry_date','1970-01-01');
  ELSIF NEW.status='approved' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    SELECT expiry_date INTO expiry FROM credit.state_as_of(NEW.effective_on,ARRAY[NEW.institution_name]);
    IF expiry IS NOT NULL THEN payload:=payload||jsonb_build_object('expiry_date',expiry);
    ELSIF EXISTS(SELECT 1 FROM credit.entry_as_of(NEW.effective_on,ARRAY[NEW.institution_name]) WHERE expiry_date=DATE '1970-01-01') THEN
      RAISE EXCEPTION 'Reactivating revoked credit requires an expiry date';
    END IF;
  END IF;
  PERFORM set_config('credit.mirror_legacy','on',true);
  PERFORM credit.append_entry(NEW.effective_on,NEW.institution_name,payload,NEW.created_by,NEW.type::credit.entry_event);
  PERFORM set_config('credit.mirror_legacy','off',true);
  RETURN NEW;
END $$;
CREATE TRIGGER a_mirror_legacy_diff AFTER INSERT OR UPDATE ON credit.diff FOR EACH ROW EXECUTE FUNCTION credit.mirror_legacy_diff();

CREATE FUNCTION credit.guard_institution_rename() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name<>OLD.name AND to_regclass('credit.diff') IS NOT NULL THEN RAISE EXCEPTION 'Credit rename awaits cutover'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_institution_rename BEFORE UPDATE ON credit.institution FOR EACH ROW EXECUTE FUNCTION credit.guard_institution_rename();

REVOKE ALL ON credit.institution,credit.metric,credit.entry FROM PUBLIC;
REVOKE ALL ON FUNCTION credit.entry_as_of(date,text[]),credit.append_entry(date,text,jsonb,text,credit.entry_event),
  credit.validate_entry(),credit.guard_metric_type(),credit.guard_entry_history(),credit.mirror_legacy_diff(),credit.guard_institution_rename() FROM PUBLIC;
-- Mirror explicitly granted invoker privileges; do not introduce SECURITY DEFINER.
DO $$ DECLARE g record; BEGIN
  FOR g IN SELECT DISTINCT a.grantee,a.privilege_type FROM pg_class t CROSS JOIN LATERAL aclexplode(coalesce(t.relacl,acldefault('r',t.relowner))) a
    WHERE t.oid='credit.diff'::regclass AND a.grantee<>0 AND a.privilege_type IN ('SELECT','INSERT','UPDATE') LOOP
    EXECUTE format('GRANT %s ON credit.institution,credit.entry TO %I',g.privilege_type,pg_get_userbyid(g.grantee));
    IF g.privilege_type='SELECT' THEN
      EXECUTE format('GRANT SELECT ON credit.metric TO %I',pg_get_userbyid(g.grantee));
      EXECUTE format('GRANT EXECUTE ON FUNCTION credit.entry_as_of(date,text[]) TO %I',pg_get_userbyid(g.grantee));
    END IF;
    IF g.privilege_type='INSERT' THEN
      EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE credit.institution_id_seq TO %I',pg_get_userbyid(g.grantee));
    END IF;
  END LOOP;
  FOR g IN SELECT DISTINCT a.grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='credit.append_diff(date,text,jsonb,text,text)'::regprocedure AND a.grantee<>0 AND a.privilege_type='EXECUTE' LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION credit.append_entry(date,text,jsonb,text,credit.entry_event) TO %I',pg_get_userbyid(g.grantee));
  END LOOP;
END $$;
