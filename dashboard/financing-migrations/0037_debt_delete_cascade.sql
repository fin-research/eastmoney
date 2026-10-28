BEGIN;

-- The existing trigger only deletes cashflows for OLD.id. Run its cleanup as
-- the existing owner without granting direct cashflow access to data editors.
ALTER FUNCTION financing.cascade_debt_delete() SECURITY DEFINER;
ALTER FUNCTION financing.cascade_debt_delete() SET search_path = pg_catalog;
REVOKE ALL ON FUNCTION financing.cascade_debt_delete() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION financing.cascade_debt_delete() FROM authenticated;

COMMIT;
