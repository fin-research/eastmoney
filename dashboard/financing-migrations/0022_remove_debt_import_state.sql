BEGIN;

SET LOCAL search_path TO financing, public;

DELETE FROM financing.audit_logs
WHERE entity_type = 'debt_import';

DROP TABLE IF EXISTS financing.debt_import_payloads;
DROP TABLE IF EXISTS financing.debt_import_runs;

ALTER TABLE financing.audit_logs
	DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;

ALTER TABLE financing.audit_logs
	ADD CONSTRAINT audit_logs_entity_type_check CHECK (entity_type IN (
		'project', 'sop', 'person', 'reminder_rule', 'auth', 'finance_parameter',
		'debt_limit', 'debt', 'cashflow', 'balance_snapshot', 'liability_weekly_report'
	));

COMMIT;
