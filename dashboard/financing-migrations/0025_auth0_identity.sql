BEGIN;
ALTER TABLE financing.people
  ADD COLUMN auth0_user_id text UNIQUE,
  ADD COLUMN auth0_account_active boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN auth0_permissions text[] NOT NULL DEFAULT '{}',
  ADD COLUMN auth0_authorized_until timestamptz,
  ADD COLUMN auth0_last_login_at timestamptz;

-- Stable IDs come from the Auth0 custom database migration, never email matching.
UPDATE financing.people p SET auth0_user_id = 'auth0|' || p.neon_auth_user_id::text,
  auth0_account_active = NOT COALESCE(u.banned, FALSE)
FROM neon_auth."user" u WHERE u.id = p.neon_auth_user_id;

CREATE OR REPLACE FUNCTION financing.current_app_user_can_edit()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, financing AS $$
  SELECT EXISTS (
    SELECT 1 FROM financing.people person
    WHERE person.active = TRUE AND (
      (person.neon_auth_user_id::text = auth.user_id() AND EXISTS (
        SELECT 1 FROM financing.role_permissions permission
        WHERE permission.role = person.role AND permission.permission_code = 'data_manage' AND permission.granted
      )) OR (
        person.auth0_user_id = auth.user_id() AND person.auth0_account_active
        AND person.auth0_authorized_until > CURRENT_TIMESTAMP
        AND 'data_manage' = ANY(person.auth0_permissions)
      )
    )
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
	WHERE (person.neon_auth_user_id::text = auth_user_id OR person.auth0_user_id = auth_user_id)
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


COMMIT;
