BEGIN;

SET LOCAL search_path TO financing, public;

CREATE TABLE financing.role_permissions (
	role text NOT NULL CHECK (role IN ('admin', 'handler', 'reviewer')),
	permission_code text NOT NULL CHECK (permission_code IN (
		'project_manage', 'own_task_update', 'sop_manage', 'people_manage',
		'data_manage', 'report_generate', 'permission_manage'
	)),
	granted boolean NOT NULL DEFAULT TRUE,
	updated_by_person_id text REFERENCES financing.people(id) ON DELETE SET NULL,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (role, permission_code)
);

CREATE TRIGGER touch_updated_at
BEFORE UPDATE ON financing.role_permissions
FOR EACH ROW EXECUTE FUNCTION financing.touch_updated_at();

INSERT INTO financing.role_permissions (role, permission_code, granted)
SELECT role, permission_code, TRUE
FROM unnest(ARRAY['admin', 'handler', 'reviewer']) AS roles(role)
CROSS JOIN unnest(ARRAY[
	'project_manage', 'own_task_update', 'sop_manage', 'people_manage',
	'data_manage', 'report_generate', 'permission_manage'
]) AS permissions(permission_code);

REVOKE ALL ON TABLE financing.role_permissions FROM PUBLIC, authenticated;

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
		JOIN financing.role_permissions permission ON permission.role = person.role
		WHERE person.neon_auth_user_id::text = auth.user_id()
			AND person.active = TRUE
			AND permission.permission_code = 'data_manage'
			AND permission.granted = TRUE
	);
$$;

REVOKE ALL ON FUNCTION financing.current_app_user_can_edit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION financing.current_app_user_can_edit() TO authenticated;

ALTER TABLE financing.audit_logs
	DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;

ALTER TABLE financing.audit_logs
	ADD CONSTRAINT audit_logs_entity_type_check CHECK (entity_type IN (
		'project', 'sop', 'person', 'reminder_rule', 'auth', 'finance_parameter',
		'debt_limit', 'debt', 'cashflow', 'balance_snapshot', 'liability_weekly_report',
		'role_permission'
	));

COMMIT;
