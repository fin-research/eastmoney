BEGIN;

SET LOCAL search_path TO financing, public;

-- The Data API already switches requests with a valid JWT to the
-- `authenticated` database role. Execution of this read-only report RPC is
-- therefore controlled by the function GRANT, without a second dependency on
-- the financing.people mapping used by editable-table RLS policies.
DO $migration$
DECLARE
	function_body text;
	person_guard constant text := E'\tIF NOT financing.current_app_user_can_edit() THEN\n\t\tRAISE EXCEPTION ''authenticated user is not an active financing person''\n\t\t\tUSING ERRCODE = ''42501'';\n\tEND IF;\n';
BEGIN
	SELECT procedure.prosrc
	INTO function_body
	FROM pg_catalog.pg_proc procedure
	JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
	WHERE namespace.nspname = 'financing'
		AND procedure.proname = 'liability_weekly_report_data'
		AND pg_catalog.pg_get_function_identity_arguments(procedure.oid) = 'p_report_date date';

	IF function_body IS NULL THEN
		RAISE EXCEPTION 'financing.liability_weekly_report_data(date) does not exist';
	END IF;
	IF pg_catalog.strpos(function_body, person_guard) = 0 THEN
		RAISE EXCEPTION 'expected liability report person guard was not found';
	END IF;

	function_body := pg_catalog.replace(function_body, person_guard, '');
	EXECUTE pg_catalog.format($definition$
		CREATE OR REPLACE FUNCTION financing.liability_weekly_report_data(p_report_date date)
		RETURNS jsonb
		LANGUAGE plpgsql
		STABLE
		SECURITY DEFINER
		SET search_path = pg_catalog, financing, public
		AS %L
	$definition$, function_body);
END;
$migration$;

REVOKE ALL ON FUNCTION liability_weekly_report_data(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION liability_weekly_report_data(date) TO authenticated;

COMMENT ON FUNCTION liability_weekly_report_data(date) IS
	'Authenticated Neon Data API RPC that aggregates financing-owned liability weekly report data for one report date; access is controlled by the authenticated role grant.';

COMMIT;
