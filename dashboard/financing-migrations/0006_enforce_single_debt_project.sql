BEGIN;

DO $$
BEGIN
	IF EXISTS (
		SELECT project_id
		FROM financing.debt
		WHERE project_id IS NOT NULL
		GROUP BY project_id
		HAVING COUNT(*) > 1
	) THEN
		RAISE EXCEPTION 'a financing project is already linked to more than one debt';
	END IF;
END;
$$;

CREATE OR REPLACE FUNCTION financing.validate_debt_project()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.project_id IS NULL THEN
		RETURN NEW;
	END IF;

	PERFORM pg_advisory_xact_lock(hashtext(NEW.project_id));

	IF NOT EXISTS (SELECT 1 FROM financing.projects WHERE id = NEW.project_id) THEN
		RAISE EXCEPTION 'project does not exist: %', NEW.project_id;
	END IF;

	IF EXISTS (
		SELECT 1
		FROM financing.debt existing
		WHERE existing.project_id = NEW.project_id
			AND existing.id <> NEW.id
	) THEN
		RAISE EXCEPTION 'project is already linked to another debt: %', NEW.project_id;
	END IF;

	RETURN NEW;
END;
$$;

COMMIT;
