BEGIN;

ALTER TABLE financing.audit_logs
	DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;

ALTER TABLE financing.audit_logs
	ADD CONSTRAINT audit_logs_entity_type_check CHECK (entity_type IN (
		'project', 'sop', 'person', 'reminder_rule', 'auth', 'finance_parameter',
		'debt_limit', 'debt', 'cashflow', 'balance_snapshot'
	));

CREATE OR REPLACE FUNCTION financing.current_app_user_can_edit()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, financing
AS $$
	SELECT EXISTS (
		SELECT 1
		FROM financing.people person
		WHERE person.neon_auth_user_id::text = auth.user_id()
			AND person.active = TRUE
			AND person.role IN ('admin', 'handler', 'reviewer')
	);
$$;

REVOKE ALL ON FUNCTION financing.current_app_user_can_edit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION financing.current_app_user_can_edit() TO authenticated;

CREATE OR REPLACE FUNCTION financing.audit_data_api_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, financing
AS $$
DECLARE
	auth_user_id text := auth.user_id();
	actor_id text;
	actor_email text;
	row_json jsonb;
	entity_id text;
	action_name text := lower(TG_OP);
BEGIN
	IF auth_user_id IS NULL THEN
		RETURN COALESCE(NEW, OLD);
	END IF;

	SELECT person.id, person.email
	INTO actor_id, actor_email
	FROM financing.people person
	WHERE person.neon_auth_user_id::text = auth_user_id
		AND person.active = TRUE
	LIMIT 1;

	IF actor_id IS NULL THEN
		RAISE EXCEPTION 'authenticated user is not an active financing person';
	END IF;

	row_json := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
	entity_id := CASE TG_ARGV[0]
		WHEN 'debt' THEN row_json ->> 'id'
		WHEN 'cashflow' THEN concat_ws(':', row_json ->> 'debt_id', row_json ->> 'sequence')
		WHEN 'balance_snapshot' THEN concat_ws(':', row_json ->> 'as_of_date', row_json ->> 'debt_type', row_json ->> 'subtype')
		WHEN 'finance_parameter' THEN row_json ->> 'code'
		WHEN 'debt_limit' THEN row_json ->> 'debt_type'
		ELSE NULL
	END;

	INSERT INTO financing.audit_logs (
		id, actor_person_id, actor_email, action, entity_type, entity_id,
		summary, before_json, after_json
	) VALUES (
		gen_random_uuid()::text,
		actor_id,
		actor_email,
		action_name,
		TG_ARGV[0],
		entity_id,
		format('Data API %s %s', action_name, TG_TABLE_NAME),
		CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END,
		CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END
	);

	RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE ALL ON FUNCTION financing.audit_data_api_write() FROM PUBLIC, authenticated;

DO $$
DECLARE
	table_name text;
BEGIN
	FOREACH table_name IN ARRAY ARRAY[
		'debt', 'bond', 'income_certificate', 'income_right', 'refinancing', 'swap_facility',
		'cashflow', 'balance_snapshot', 'finance_parameters', 'debt_limit_configs'
	]
	LOOP
		EXECUTE format('ALTER TABLE financing.%I ENABLE ROW LEVEL SECURITY', table_name);
		EXECUTE format('DROP POLICY IF EXISTS data_api_editor ON financing.%I', table_name);
		EXECUTE format(
			'CREATE POLICY data_api_editor ON financing.%I FOR ALL TO authenticated USING (financing.current_app_user_can_edit()) WITH CHECK (financing.current_app_user_can_edit())',
			table_name
		);
	END LOOP;

	DROP POLICY IF EXISTS data_api_audit_reader ON financing.audit_logs;
	ALTER TABLE financing.audit_logs ENABLE ROW LEVEL SECURITY;
	CREATE POLICY data_api_audit_reader ON financing.audit_logs
		FOR SELECT TO authenticated
		USING (financing.current_app_user_can_edit());
END;
$$;

DO $$
DECLARE
	table_name text;
	entity_type text;
BEGIN
	FOR table_name, entity_type IN
		SELECT * FROM (VALUES
			('debt', 'debt'),
			('bond', 'debt'),
			('income_certificate', 'debt'),
			('income_right', 'debt'),
			('refinancing', 'debt'),
			('swap_facility', 'debt'),
			('cashflow', 'cashflow'),
			('balance_snapshot', 'balance_snapshot'),
			('finance_parameters', 'finance_parameter'),
			('debt_limit_configs', 'debt_limit')
		) AS configured(table_name, entity_type)
	LOOP
		EXECUTE format('DROP TRIGGER IF EXISTS audit_data_api_write ON financing.%I', table_name);
		EXECUTE format(
			'CREATE TRIGGER audit_data_api_write AFTER INSERT OR UPDATE OR DELETE ON financing.%I FOR EACH ROW EXECUTE FUNCTION financing.audit_data_api_write(%L)',
			table_name,
			entity_type
		);
	END LOOP;
END;
$$;

GRANT USAGE ON SCHEMA financing TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
	financing.debt,
	financing.bond,
	financing.income_certificate,
	financing.income_right,
	financing.refinancing,
	financing.swap_facility,
	financing.cashflow,
	financing.balance_snapshot,
	financing.finance_parameters,
	financing.debt_limit_configs
TO authenticated;
GRANT SELECT ON TABLE financing.audit_logs TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE financing.debt_id_seq TO authenticated;

COMMIT;
