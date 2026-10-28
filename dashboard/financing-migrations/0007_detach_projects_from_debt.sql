BEGIN;

DROP TRIGGER IF EXISTS detach_project_debts ON financing.projects;

DO $$
DECLARE
	table_name text;
BEGIN
	FOREACH table_name IN ARRAY ARRAY['debt', 'bond', 'income_certificate', 'income_right', 'refinancing', 'swap_facility']
	LOOP
		EXECUTE format('DROP TRIGGER IF EXISTS validate_debt_project ON financing.%I', table_name);
	END LOOP;
END;
$$;

DROP INDEX IF EXISTS financing.debt_project_idx;
DROP INDEX IF EXISTS financing.bond_project_idx;
DROP INDEX IF EXISTS financing.income_certificate_project_idx;
DROP INDEX IF EXISTS financing.income_right_project_idx;
DROP INDEX IF EXISTS financing.refinancing_project_idx;
DROP INDEX IF EXISTS financing.swap_facility_project_idx;

DROP VIEW IF EXISTS financing.debt_overview;
ALTER TABLE financing.debt DROP COLUMN IF EXISTS project_id;

CREATE VIEW financing.debt_overview AS
SELECT
	d.*,
	COALESCE(NULLIF(d.subtype, ''), d.debt_type) AS reporting_type
FROM financing.debt d;

DROP FUNCTION IF EXISTS financing.validate_debt_project();
DROP FUNCTION IF EXISTS financing.detach_project_debts();

COMMENT ON TABLE financing.projects IS 'Standalone financing projects. Projects do not reference or mutate existing debt records.';

COMMIT;
