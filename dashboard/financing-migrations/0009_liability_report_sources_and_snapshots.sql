BEGIN;

SET LOCAL search_path TO financing, public;

ALTER TABLE projects
	ADD COLUMN IF NOT EXISTS expected_rate_min numeric(12, 10),
	ADD COLUMN IF NOT EXISTS expected_rate_max numeric(12, 10),
	ADD COLUMN IF NOT EXISTS funding_cost_rate numeric(12, 10),
	ADD COLUMN IF NOT EXISTS tenor_description text,
	ADD COLUMN IF NOT EXISTS amount_description text;

ALTER TABLE projects
	DROP CONSTRAINT IF EXISTS projects_expected_rate_min_check,
	DROP CONSTRAINT IF EXISTS projects_expected_rate_max_check,
	DROP CONSTRAINT IF EXISTS projects_expected_rate_order_check,
	DROP CONSTRAINT IF EXISTS projects_funding_cost_rate_check;

ALTER TABLE projects
	ADD CONSTRAINT projects_expected_rate_min_check CHECK (expected_rate_min IS NULL OR (expected_rate_min >= 0 AND expected_rate_min <= 1)),
	ADD CONSTRAINT projects_expected_rate_max_check CHECK (expected_rate_max IS NULL OR (expected_rate_max >= 0 AND expected_rate_max <= 1)),
	ADD CONSTRAINT projects_expected_rate_order_check CHECK (expected_rate_min IS NULL OR expected_rate_max IS NULL OR expected_rate_max >= expected_rate_min),
	ADD CONSTRAINT projects_funding_cost_rate_check CHECK (funding_cost_rate IS NULL OR (funding_cost_rate >= 0 AND funding_cost_rate <= 1));

CREATE TABLE liability_market_observations (
	series_id text NOT NULL,
	series_name text NOT NULL,
	category text NOT NULL,
	tenor text,
	observation_date date NOT NULL,
	value numeric(20, 8),
	unit text NOT NULL DEFAULT '%',
	source text NOT NULL,
	source_reference text,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (series_id, category, observation_date)
);

CREATE TABLE liability_peer_issuances (
	id text PRIMARY KEY,
	security_code text,
	bond_name text NOT NULL,
	issuer_name text,
	company_nature text,
	issue_date date,
	payment_date date,
	bond_type text,
	actual_issue_amount_yi numeric(20, 8),
	issue_amount_upper_yi numeric(20, 8),
	plan_issue_amount_yi numeric(20, 8),
	issue_tenor text,
	interest_start_date date,
	issue_notice_date date,
	issue_end_date date,
	maturity_date date,
	listed_date date,
	market text,
	coupon_rate_pct numeric(20, 8),
	source text NOT NULL,
	source_row_number integer,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX liability_peer_issuance_security_date_idx
	ON liability_peer_issuances(security_code, issue_date)
	WHERE security_code IS NOT NULL AND issue_date IS NOT NULL;

CREATE TABLE liability_registration_progress (
	id text PRIMARY KEY,
	project_name text NOT NULL,
	issuer_name text,
	status text,
	variety text,
	amount_yi numeric(20, 8),
	region text,
	industry text,
	lead_underwriter text,
	venue text,
	registration_or_filing text,
	update_date date NOT NULL,
	notice_number text,
	source text NOT NULL,
	source_row_number integer,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX liability_registration_natural_key_idx
	ON liability_registration_progress(project_name, status, update_date, COALESCE(notice_number, ''));

CREATE TABLE liability_weekly_report_runs (
	id text PRIMARY KEY,
	as_of_date date NOT NULL,
	generated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	generated_by_person_id text REFERENCES people(id) ON DELETE SET NULL,
	r2_key text NOT NULL UNIQUE,
	content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
	status text NOT NULL CHECK (status IN ('pending', 'complete', 'failed')),
	source_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
	missing_modules jsonb NOT NULL DEFAULT '[]'::jsonb,
	error_message text,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX liability_market_latest_idx ON liability_market_observations(observation_date DESC, category);
CREATE INDEX liability_peer_latest_idx ON liability_peer_issuances(issue_date DESC, issuer_name);
CREATE INDEX liability_registration_latest_idx ON liability_registration_progress(update_date DESC, status);
CREATE INDEX liability_weekly_report_history_idx ON liability_weekly_report_runs(as_of_date DESC, generated_at DESC);

DO $$
DECLARE table_name text;
BEGIN
	FOREACH table_name IN ARRAY ARRAY[
		'liability_market_observations', 'liability_peer_issuances',
		'liability_registration_progress', 'liability_weekly_report_runs'
	]
	LOOP
		EXECUTE format('CREATE TRIGGER touch_updated_at BEFORE UPDATE ON financing.%I FOR EACH ROW EXECUTE FUNCTION financing.touch_updated_at()', table_name);
	END LOOP;
END;
$$;

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_entity_type_check CHECK (entity_type IN (
	'project', 'sop', 'person', 'reminder_rule', 'auth', 'finance_parameter',
	'debt_limit', 'debt', 'cashflow', 'balance_snapshot', 'liability_weekly_report'
));

COMMENT ON TABLE liability_market_observations IS 'Imported or manually refreshed Choice/底稿 market series used by the liability weekly report.';
COMMENT ON TABLE liability_peer_issuances IS 'Comparable broker bond issuance detail imported from the weekly source workbook or a manually requested Choice CTR snapshot.';
COMMENT ON TABLE liability_registration_progress IS 'Comparable broker registration progress history; each update remains queryable for report replay.';
COMMENT ON TABLE liability_weekly_report_runs IS 'Report-run index. The corresponding JSON snapshot is stored under the eastmoney/liability-report/yyyy-mm-dd.json R2 key.';
COMMENT ON COLUMN liability_weekly_report_runs.source_manifest IS 'Records the exact source files, Choice calls, and missing-data statuses used for this manual generation.';

COMMIT;
