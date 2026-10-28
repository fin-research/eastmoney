BEGIN;

-- This migration is applied by scripts/apply-unified-permissions.mjs after live
-- Auth0 IDs are verified. An explicit person mapping is required for replaced accounts.
LOCK TABLE financing.people, financing.projects, financing.project_tasks, financing.liability_weekly_report_runs IN ACCESS EXCLUSIVE MODE;
CREATE TEMP TABLE permission_identity_migration ON COMMIT DROP AS
SELECT person.id AS old_id,
  COALESCE(NULLIF(current_setting('migration.person_mapping', true), '')::jsonb ->> person.id, person.auth0_user_id) AS auth0_id
FROM financing.people person;
DO $$
DECLARE missing_count integer;
BEGIN
  SELECT count(*) INTO missing_count FROM permission_identity_migration person
    WHERE person.auth0_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(NULLIF(current_setting('migration.auth0_users', true), '')::jsonb, '[]')) account
      WHERE account ->> 'user_id' = person.auth0_id
    );
  IF missing_count > 0 THEN RAISE EXCEPTION 'Unverified Auth0 identity mappings: %', missing_count; END IF;
  IF EXISTS (SELECT auth0_id FROM permission_identity_migration GROUP BY auth0_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Multiple financing people map to the same Auth0 account';
  END IF;
END $$;

-- Detach only the known references; unexpected dependencies fail instead of cascading.
ALTER TABLE financing.projects DROP CONSTRAINT projects_owner_id_fkey;
ALTER TABLE financing.project_tasks DROP CONSTRAINT project_tasks_assignee_id_fkey;
ALTER TABLE financing.liability_weekly_report_runs DROP CONSTRAINT liability_weekly_report_runs_generated_by_person_id_fkey;
UPDATE financing.projects target SET owner_id = source.auth0_id FROM permission_identity_migration source WHERE target.owner_id = source.old_id;
UPDATE financing.project_tasks target SET assignee_id = source.auth0_id FROM permission_identity_migration source WHERE target.assignee_id = source.old_id;
UPDATE financing.liability_weekly_report_runs target SET generated_by_person_id = source.auth0_id FROM permission_identity_migration source WHERE target.generated_by_person_id = source.old_id;
ALTER TABLE financing.liability_weekly_report_runs RENAME COLUMN generated_by_person_id TO generated_by;
ALTER TABLE financing.projects ADD CONSTRAINT projects_owner_auth0_id CHECK (owner_id IS NULL OR owner_id ~ '^auth0\|[^[:space:]]+$');
ALTER TABLE financing.project_tasks ADD CONSTRAINT project_tasks_assignee_auth0_id CHECK (assignee_id IS NULL OR assignee_id ~ '^auth0\|[^[:space:]]+$');
ALTER TABLE financing.liability_weekly_report_runs ADD CONSTRAINT report_generated_by_auth0_id CHECK (generated_by IS NULL OR generated_by ~ '^auth0\|[^[:space:]]+$');

-- SOP default responsibility now refers directly to Auth0 role IDs, not local role codes.
ALTER TABLE financing.sop_nodes DROP CONSTRAINT IF EXISTS sop_nodes_default_owner_role_check;
UPDATE financing.sop_nodes node SET default_owner_role = role ->> 'id'
FROM jsonb_array_elements(COALESCE(NULLIF(current_setting('migration.auth0_roles', true), '')::jsonb, '[]')) role
WHERE role ->> 'name' = 'financing:' || node.default_owner_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM financing.sop_nodes WHERE default_owner_role IS NOT NULL AND default_owner_role !~ '^rol_[A-Za-z0-9]+$') THEN
    RAISE EXCEPTION 'SOP default role has no verified Auth0 mapping';
  END IF;
END $$;
ALTER TABLE financing.sop_nodes ADD CONSTRAINT sop_default_auth0_role CHECK (default_owner_role IS NULL OR default_owner_role ~ '^rol_[A-Za-z0-9]+$');

-- Preserve the report's business calculation; resolve owner names from Auth0 at the application boundary.
DO $$ DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('financing.liability_weekly_report_data(date)'::regprocedure) INTO definition;
  IF position('owner.name AS owner_name' IN definition) = 0 OR position('LEFT JOIN people owner ON owner.id = project.owner_id' IN definition) = 0 THEN
    RAISE EXCEPTION 'Unexpected report function; review its owner lookup before migrating';
  END IF;
  definition := replace(definition, 'owner.name AS owner_name', 'project.owner_id AS owner_id');
  definition := replace(definition, 'LEFT JOIN people owner ON owner.id = project.owner_id', '');
  definition := replace(definition, '''ownerName'', owner_name', '''ownerId'', owner_id');
  EXECUTE definition;
END $$;

-- Command-specific RLS, including SELECT needed by mutation RETURNING.
DO $$ DECLARE item record; table_name text;
BEGIN
  FOR item IN SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE t.tgfoid = 'financing.audit_data_api_write()'::regprocedure LOOP
    EXECUTE format('DROP TRIGGER %I ON financing.%I', item.tgname, item.relname);
  END LOOP;
  FOR item IN SELECT tablename, policyname FROM pg_policies WHERE schemaname='financing' AND (qual LIKE '%current_app_user_can_edit%' OR with_check LIKE '%current_app_user_can_edit%') LOOP
    EXECUTE format('DROP POLICY %I ON financing.%I', item.policyname, item.tablename);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['debt','bond','income_certificate','income_right','refinancing','swap_facility','cashflow','balance_snapshot','finance_parameters','financial_monthly_data','debt_limit_configs'] LOOP
    -- The replaced scalar finance-parameter table may already have been retired.
    IF table_name = 'finance_parameters' AND to_regclass('financing.finance_parameters') IS NULL THEN CONTINUE; END IF;
    EXECUTE format('CREATE POLICY permission_read ON financing.%I FOR SELECT TO authenticated USING (
      "authorization".has_permission(''financing.data:read'') OR
      (current_setting(''request.auth.operation'',true) = ''POST'' AND "authorization".has_permission(''financing.data:create'')) OR
      (current_setting(''request.auth.operation'',true) = ''PATCH'' AND "authorization".has_permission(''financing.data:update'')) OR
      (current_setting(''request.auth.operation'',true) = ''DELETE'' AND "authorization".has_permission(''financing.data:delete'')))', table_name);
    EXECUTE format('CREATE POLICY permission_create ON financing.%I FOR INSERT TO authenticated WITH CHECK ("authorization".has_permission(''financing.data:create''))', table_name);
    EXECUTE format('CREATE POLICY permission_update ON financing.%I FOR UPDATE TO authenticated USING ("authorization".has_permission(''financing.data:update'')) WITH CHECK ("authorization".has_permission(''financing.data:update''))', table_name);
    EXECUTE format('CREATE POLICY permission_delete ON financing.%I FOR DELETE TO authenticated USING ("authorization".has_permission(''financing.data:delete''))', table_name);
  END LOOP;
END $$;
DROP FUNCTION financing.audit_data_api_write();
DROP FUNCTION financing.current_app_user_can_edit();
DROP TABLE financing.audit_logs;
DROP TABLE financing.role_permissions;
DROP TABLE financing.people;

-- Seed all roles existing at migration time. Newly created roles start unconfigured;
-- beta-open mode still grants every verified logged-in account every registered permission.
INSERT INTO "authorization".role_permission (auth0_role_id, permission_code, granted)
SELECT role ->> 'id', permission.code, true FROM "authorization".permission permission
CROSS JOIN jsonb_array_elements(COALESCE(NULLIF(current_setting('migration.auth0_roles', true), '')::jsonb, '[]')) role
ON CONFLICT DO NOTHING;
COMMIT;
