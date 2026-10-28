BEGIN;

DROP POLICY IF EXISTS data_api_editor ON financing.cashflow;
DROP POLICY IF EXISTS data_api_editor ON financing.balance_snapshot;
DROP POLICY IF EXISTS data_api_audit_reader ON financing.audit_logs;

REVOKE ALL PRIVILEGES ON TABLE
	financing.cashflow,
	financing.balance_snapshot,
	financing.audit_logs
FROM authenticated;

COMMIT;
