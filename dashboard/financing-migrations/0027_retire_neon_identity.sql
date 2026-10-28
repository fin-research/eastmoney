BEGIN;

-- Only apply after the Auth0 Worker is active and all identity mappings are reconciled.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM financing.people WHERE neon_auth_user_id IS NOT NULL AND auth0_user_id IS NULL) THEN
    RAISE EXCEPTION 'Unmigrated financing identity; do not retire Neon Auth';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION financing.current_app_user_can_edit()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, financing AS $$
  SELECT EXISTS (
    SELECT 1 FROM financing.people person
    WHERE person.active = TRUE AND person.auth0_account_active
      AND person.auth0_user_id = NULLIF(current_setting('request.financing.user_id', TRUE), '')
      AND person.auth0_authorized_until > CURRENT_TIMESTAMP
      AND 'data_manage' = ANY(person.auth0_permissions)
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
	auth_user_id text := NULLIF(current_setting('request.financing.user_id', TRUE), '');
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
	WHERE person.auth0_user_id = auth_user_id
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
		WHEN 'finance_parameter' THEN COALESCE(row_json ->> 'code', row_json ->> 'period_end')
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



ALTER TABLE financing.people DROP CONSTRAINT IF EXISTS people_neon_auth_user_id_fkey;
ALTER TABLE financing.people DROP COLUMN neon_auth_user_id;
COMMIT;
