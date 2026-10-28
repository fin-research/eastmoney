BEGIN;

SET LOCAL search_path TO financing, public;

CREATE TABLE financing.debt_import_runs (
	id text PRIMARY KEY,
	workflow_instance_id text NOT NULL UNIQUE,
	source_file_name text NOT NULL,
	source_size_bytes bigint NOT NULL CHECK (source_size_bytes > 0 AND source_size_bytes <= 10485760),
	source_sha256 text CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
	status text NOT NULL CHECK (status IN ('parsing', 'queued', 'running', 'succeeded', 'failed')),
	stage text NOT NULL CHECK (stage IN ('parsing', 'queued', 'importing', 'refreshing', 'finalizing', 'completed')),
	progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
	message text NOT NULL,
	source_as_of_date date,
	source_total_yi numeric,
	source_debt_count integer CHECK (source_debt_count IS NULL OR source_debt_count >= 0),
	source_cashflow_count integer CHECK (source_cashflow_count IS NULL OR source_cashflow_count >= 0),
	source_balance_count integer CHECK (source_balance_count IS NULL OR source_balance_count >= 0),
	inserted_debt_count integer CHECK (inserted_debt_count IS NULL OR inserted_debt_count >= 0),
	updated_debt_count integer CHECK (updated_debt_count IS NULL OR updated_debt_count >= 0),
	inserted_cashflow_count integer CHECK (inserted_cashflow_count IS NULL OR inserted_cashflow_count >= 0),
	updated_cashflow_count integer CHECK (updated_cashflow_count IS NULL OR updated_cashflow_count >= 0),
	database_debt_count integer CHECK (database_debt_count IS NULL OR database_debt_count >= 0),
	database_cashflow_count integer CHECK (database_cashflow_count IS NULL OR database_cashflow_count >= 0),
	history_date_count integer CHECK (history_date_count IS NULL OR history_date_count >= 0),
	derived_metric_count integer CHECK (derived_metric_count IS NULL OR derived_metric_count >= 0),
	error_message text,
	created_by_person_id text REFERENCES financing.people(id) ON DELETE SET NULL,
	started_at timestamptz,
	completed_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE financing.debt_import_payloads (
	run_id text PRIMARY KEY REFERENCES financing.debt_import_runs(id) ON DELETE CASCADE,
	payload jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX debt_import_runs_single_active_idx
	ON financing.debt_import_runs ((true))
	WHERE status IN ('parsing', 'queued', 'running');

CREATE INDEX debt_import_runs_created_idx
	ON financing.debt_import_runs (created_at DESC, id DESC);

CREATE TRIGGER touch_updated_at
	BEFORE UPDATE ON financing.debt_import_runs
	FOR EACH ROW EXECUTE FUNCTION financing.touch_updated_at();

REVOKE ALL ON TABLE financing.debt_import_runs, financing.debt_import_payloads FROM PUBLIC;
REVOKE ALL ON TABLE financing.debt_import_runs, financing.debt_import_payloads FROM authenticated;

ALTER TABLE financing.audit_logs
	DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;

ALTER TABLE financing.audit_logs
	ADD CONSTRAINT audit_logs_entity_type_check CHECK (entity_type IN (
		'project', 'sop', 'person', 'reminder_rule', 'auth', 'finance_parameter',
		'debt_limit', 'debt', 'cashflow', 'balance_snapshot', 'liability_weekly_report',
		'debt_import'
	));

COMMENT ON TABLE financing.debt_import_runs IS
	'Admin-triggered online debt-ledger import status and verified result. Raw workbooks are never persisted.';
COMMENT ON TABLE financing.debt_import_payloads IS
	'Temporary parsed workbook payload consumed and deleted by the debt import Workflow.';
COMMENT ON COLUMN financing.debt_import_runs.progress IS
	'User-facing progress percentage maintained at durable Workflow stage boundaries.';

COMMIT;
