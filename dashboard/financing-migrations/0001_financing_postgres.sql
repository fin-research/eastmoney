BEGIN;

CREATE SCHEMA IF NOT EXISTS financing;

CREATE SEQUENCE IF NOT EXISTS financing.debt_id_seq AS bigint START WITH 1;

CREATE OR REPLACE FUNCTION financing.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	NEW.updated_at = CURRENT_TIMESTAMP;
	RETURN NEW;
END;
$$;

CREATE TABLE financing.people (
	id text PRIMARY KEY,
	name text NOT NULL UNIQUE,
	email text,
	role text CHECK (role IN ('admin', 'handler', 'reviewer')),
	active boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE financing.auth_users (
	id text PRIMARY KEY,
	person_id text NOT NULL UNIQUE REFERENCES financing.people(id) ON DELETE CASCADE,
	password_hash text NOT NULL,
	role text NOT NULL CHECK (role IN ('admin', 'handler', 'reviewer')),
	active boolean NOT NULL DEFAULT true,
	failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
	locked_until timestamptz,
	last_login_at timestamptz,
	avatar_data_url text,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE financing.auth_sessions (
	id text PRIMARY KEY,
	token_hash text NOT NULL UNIQUE,
	user_id text NOT NULL REFERENCES financing.auth_users(id) ON DELETE CASCADE,
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE financing.sop_templates (
	id text PRIMARY KEY,
	name text NOT NULL,
	debt_type text NOT NULL,
	description text,
	is_active boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (name, debt_type)
);

CREATE TABLE financing.sop_nodes (
	id text PRIMARY KEY,
	template_id text NOT NULL REFERENCES financing.sop_templates(id) ON DELETE CASCADE,
	name text NOT NULL,
	description text,
	sort_order integer NOT NULL,
	default_offset_days integer NOT NULL DEFAULT 0,
	default_owner_role text CHECK (default_owner_role IS NULL OR default_owner_role IN ('handler', 'reviewer')),
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (template_id, sort_order)
);

CREATE TABLE financing.projects (
	id text PRIMARY KEY,
	code text NOT NULL UNIQUE,
	name text NOT NULL,
	debt_type text NOT NULL,
	borrower text,
	amount numeric(20, 2) CHECK (amount IS NULL OR amount >= 0),
	currency text NOT NULL DEFAULT 'CNY',
	status text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'in_progress', 'at_risk', 'completed', 'cancelled')),
	planned_start_date date,
	planned_issue_date date,
	planned_maturity_date date,
	sop_template_id text REFERENCES financing.sop_templates(id) ON DELETE SET NULL,
	owner_id text REFERENCES financing.people(id) ON DELETE SET NULL,
	notes text,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CHECK (planned_maturity_date IS NULL OR planned_issue_date IS NULL OR planned_maturity_date >= planned_issue_date)
);

CREATE TABLE financing.project_tasks (
	id text PRIMARY KEY,
	project_id text NOT NULL REFERENCES financing.projects(id) ON DELETE CASCADE,
	sop_node_id text REFERENCES financing.sop_nodes(id) ON DELETE SET NULL,
	name text NOT NULL,
	status text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'blocked', 'completed')),
	assignee_id text REFERENCES financing.people(id) ON DELETE SET NULL,
	planned_start_date date,
	due_date date,
	completed_at timestamptz,
	sort_order integer NOT NULL DEFAULT 0,
	notes text,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The parent is intentionally queryable: SELECT FROM financing.debt includes every child table.
CREATE TABLE financing.debt (
	id bigint NOT NULL DEFAULT nextval('financing.debt_id_seq'),
	project_id text,
	debt_type text NOT NULL,
	subtype text,
	name text NOT NULL,
	counterparty text,
	amount numeric(20, 2) NOT NULL CHECK (amount >= 0),
	interest_payable numeric(20, 2) NOT NULL DEFAULT 0 CHECK (interest_payable >= 0),
	total_amount numeric(20, 2) GENERATED ALWAYS AS (amount + interest_payable) STORED,
	annual_rate numeric(12, 10) CHECK (annual_rate IS NULL OR (annual_rate >= 0 AND annual_rate <= 1)),
	issue_date date,
	maturity_date date,
	term_days integer GENERATED ALWAYS AS (
		CASE WHEN issue_date IS NOT NULL AND maturity_date IS NOT NULL THEN maturity_date - issue_date END
	) STORED,
	activated_at date,
	settled_at date,
	closed_at date,
	status text GENERATED ALWAYS AS (
		CASE
			WHEN closed_at IS NOT NULL THEN 'closed'
			WHEN settled_at IS NOT NULL THEN 'matured'
			WHEN activated_at IS NULL THEN 'planned'
			ELSE 'active'
		END
	) STORED,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id),
	CHECK (maturity_date IS NULL OR issue_date IS NULL OR maturity_date >= issue_date),
	CHECK (activated_at IS NULL OR issue_date IS NULL OR activated_at >= issue_date),
	CHECK (settled_at IS NULL OR issue_date IS NULL OR settled_at >= issue_date),
	CHECK (closed_at IS NULL OR issue_date IS NULL OR closed_at >= issue_date)
);

CREATE TABLE financing.bond (
	issuance_method text,
	bookbuilding_date date,
	interest_basis text,
	issuance_target text,
	market text,
	receiving_account text,
	trustee text,
	bookrunner text,
	PRIMARY KEY (id),
	CHECK (debt_type = '债券'),
	CHECK (subtype IS NOT NULL)
) INHERITS (financing.debt);

CREATE TABLE financing.income_certificate (
	liquidation_submission_status text,
	liquidation_registration_status text,
	return_type text,
	receiving_account text,
	early_maturity boolean,
	PRIMARY KEY (id),
	CHECK (debt_type = '收益凭证')
) INHERITS (financing.debt);

CREATE TABLE financing.income_right (
	interest_basis_days integer CHECK (interest_basis_days IS NULL OR interest_basis_days > 0),
	PRIMARY KEY (id),
	CHECK (debt_type = '收益权转让')
) INHERITS (financing.debt);

CREATE TABLE financing.refinancing (
	interest_basis_days integer CHECK (interest_basis_days IS NULL OR interest_basis_days > 0),
	market text,
	is_extended boolean,
	receiving_account text,
	repayment_account text,
	PRIMARY KEY (id),
	CHECK (debt_type = '转融资')
) INHERITS (financing.debt);

CREATE TABLE financing.swap_facility (
	average_repo_balance_description text,
	repo_weighted_average_rate numeric(12, 10)
		CHECK (repo_weighted_average_rate IS NULL OR (repo_weighted_average_rate >= 0 AND repo_weighted_average_rate <= 1)),
	PRIMARY KEY (id),
	CHECK (debt_type = '互换便利')
) INHERITS (financing.debt);

CREATE OR REPLACE FUNCTION financing.guard_debt_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND NEW.id <> OLD.id THEN
		RAISE EXCEPTION 'debt id is immutable';
	END IF;
	IF TG_OP = 'INSERT' THEN
		PERFORM pg_advisory_xact_lock(NEW.id);
		IF EXISTS (SELECT 1 FROM financing.debt existing WHERE existing.id = NEW.id) THEN
			RAISE EXCEPTION 'duplicate debt id: %', NEW.id;
		END IF;
	END IF;
	RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION financing.validate_debt_project()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.project_id IS NOT NULL
		AND NOT EXISTS (SELECT 1 FROM financing.projects WHERE id = NEW.project_id) THEN
		RAISE EXCEPTION 'project does not exist: %', NEW.project_id;
	END IF;
	RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION financing.detach_project_debts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	UPDATE financing.debt SET project_id = NULL WHERE project_id = OLD.id;
	RETURN OLD;
END;
$$;

CREATE TABLE financing.cashflow (
	debt_id bigint NOT NULL,
	sequence integer NOT NULL,
	cashflow_type text NOT NULL CHECK (cashflow_type IN ('interest', 'principal', 'fee', 'supplemental')),
	due_date date NOT NULL,
	amount numeric(20, 2) CHECK (amount IS NULL OR amount >= 0),
	paid_amount numeric(20, 2) CHECK (paid_amount IS NULL OR paid_amount >= 0),
	paid_at date,
	accrual_start_date date,
	accrual_end_date date,
	note text,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (debt_id, sequence),
	CHECK (accrual_end_date IS NULL OR accrual_start_date IS NULL OR accrual_end_date >= accrual_start_date)
);

CREATE OR REPLACE FUNCTION financing.validate_cashflow_debt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM financing.debt WHERE id = NEW.debt_id) THEN
		RAISE EXCEPTION 'debt does not exist: %', NEW.debt_id;
	END IF;
	IF NEW.sequence IS NULL THEN
		PERFORM pg_advisory_xact_lock(NEW.debt_id);
		SELECT COALESCE(MAX(sequence), 0) + 1 INTO NEW.sequence
		FROM financing.cashflow WHERE debt_id = NEW.debt_id;
	END IF;
	RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION financing.cascade_debt_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	DELETE FROM financing.cashflow WHERE debt_id = OLD.id;
	RETURN OLD;
END;
$$;

DO $$
DECLARE
	table_name text;
BEGIN
	FOREACH table_name IN ARRAY ARRAY['debt', 'bond', 'income_certificate', 'income_right', 'refinancing', 'swap_facility']
	LOOP
		EXECUTE format('DROP TRIGGER IF EXISTS guard_debt_identity ON financing.%I', table_name);
		EXECUTE format('CREATE TRIGGER guard_debt_identity BEFORE INSERT OR UPDATE OF id ON financing.%I FOR EACH ROW EXECUTE FUNCTION financing.guard_debt_identity()', table_name);
		EXECUTE format('DROP TRIGGER IF EXISTS validate_debt_project ON financing.%I', table_name);
		EXECUTE format('CREATE TRIGGER validate_debt_project BEFORE INSERT OR UPDATE OF project_id ON financing.%I FOR EACH ROW EXECUTE FUNCTION financing.validate_debt_project()', table_name);
		EXECUTE format('DROP TRIGGER IF EXISTS touch_updated_at ON financing.%I', table_name);
		EXECUTE format('CREATE TRIGGER touch_updated_at BEFORE UPDATE ON financing.%I FOR EACH ROW EXECUTE FUNCTION financing.touch_updated_at()', table_name);
		EXECUTE format('DROP TRIGGER IF EXISTS cascade_debt_delete ON financing.%I', table_name);
		EXECUTE format('CREATE TRIGGER cascade_debt_delete BEFORE DELETE ON financing.%I FOR EACH ROW EXECUTE FUNCTION financing.cascade_debt_delete()', table_name);
	END LOOP;
END;
$$;

CREATE TRIGGER validate_cashflow_debt
BEFORE INSERT OR UPDATE OF debt_id, sequence ON financing.cashflow
FOR EACH ROW EXECUTE FUNCTION financing.validate_cashflow_debt();

CREATE TRIGGER touch_updated_at
BEFORE UPDATE ON financing.cashflow
FOR EACH ROW EXECUTE FUNCTION financing.touch_updated_at();

CREATE TRIGGER detach_project_debts
BEFORE DELETE ON financing.projects
FOR EACH ROW EXECUTE FUNCTION financing.detach_project_debts();

CREATE TABLE financing.balance_snapshot (
	as_of_date date NOT NULL,
	debt_type text NOT NULL,
	subtype text NOT NULL DEFAULT '',
	amount numeric(20, 2) NOT NULL CHECK (amount >= 0),
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (as_of_date, debt_type, subtype)
);

CREATE TABLE financing.reminder_rules (
	id text PRIMARY KEY,
	name text NOT NULL,
	target_type text NOT NULL DEFAULT 'project_task' CHECK (target_type IN ('project_task', 'project', 'debt')),
	debt_type text,
	trigger_field text NOT NULL,
	offset_days integer NOT NULL DEFAULT 1,
	frequency text NOT NULL DEFAULT 'once' CHECK (frequency IN ('once', 'daily', 'weekly')),
	channel text NOT NULL DEFAULT 'email' CHECK (channel = 'email'),
	recipient_mode text NOT NULL DEFAULT 'assignee' CHECK (recipient_mode IN ('assignee', 'owner', 'custom')),
	recipients jsonb,
	is_active boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE financing.reminder_deliveries (
	id text PRIMARY KEY,
	rule_id text NOT NULL REFERENCES financing.reminder_rules(id) ON DELETE CASCADE,
	target_type text NOT NULL,
	target_id text NOT NULL,
	delivery_date date NOT NULL,
	recipients jsonb NOT NULL,
	status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
	provider_message_id text,
	error_message text,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	sent_at timestamptz,
	UNIQUE (rule_id, target_id, delivery_date)
);

CREATE TABLE financing.finance_parameters (
	code text PRIMARY KEY,
	label text NOT NULL,
	value_yi numeric(20, 4),
	period_end date,
	notes text,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE financing.debt_limit_configs (
	debt_type text PRIMARY KEY,
	limit_yi numeric(20, 4) NOT NULL CHECK (limit_yi >= 0),
	usage_basis text NOT NULL DEFAULT 'outstanding' CHECK (usage_basis IN ('outstanding', 'since_approval')),
	approved_date date,
	expiry_date date,
	calculation_mode text NOT NULL DEFAULT 'manual' CHECK (calculation_mode IN ('manual', 'net_capital_60')),
	sort_order integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE financing.audit_logs (
	id text PRIMARY KEY,
	actor_user_id text REFERENCES financing.auth_users(id) ON DELETE SET NULL,
	actor_email text,
	action text NOT NULL,
	entity_type text NOT NULL CHECK (entity_type IN ('project', 'sop', 'person', 'reminder_rule', 'auth', 'finance_parameter', 'debt_limit', 'debt')),
	entity_id text,
	summary text NOT NULL,
	before_json jsonb,
	after_json jsonb,
	request_ip inet,
	user_agent text,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
DECLARE
	table_name text;
BEGIN
	FOREACH table_name IN ARRAY ARRAY[
		'people', 'auth_users', 'sop_templates', 'sop_nodes', 'projects', 'project_tasks',
		'balance_snapshot', 'reminder_rules', 'finance_parameters', 'debt_limit_configs'
	]
	LOOP
		EXECUTE format('CREATE TRIGGER touch_updated_at BEFORE UPDATE ON financing.%I FOR EACH ROW EXECUTE FUNCTION financing.touch_updated_at()', table_name);
	END LOOP;
END;
$$;

CREATE INDEX projects_status_type_idx ON financing.projects(status, debt_type);
CREATE UNIQUE INDEX idx_people_email_unique ON financing.people(lower(email)) WHERE email IS NOT NULL;
CREATE INDEX project_tasks_project_due_idx ON financing.project_tasks(project_id, due_date);
CREATE INDEX project_tasks_assignee_due_idx ON financing.project_tasks(assignee_id, due_date) WHERE status <> 'completed';
CREATE INDEX auth_sessions_expiry_idx ON financing.auth_sessions(expires_at);
CREATE INDEX reminder_rules_active_idx ON financing.reminder_rules(is_active, target_type);
CREATE INDEX reminder_deliveries_status_idx ON financing.reminder_deliveries(status, delivery_date);
CREATE INDEX audit_logs_entity_idx ON financing.audit_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx ON financing.audit_logs(actor_user_id, created_at DESC);
CREATE INDEX debt_type_status_idx ON financing.debt(debt_type, subtype, status);
CREATE INDEX debt_maturity_idx ON financing.debt(maturity_date) WHERE closed_at IS NULL;
CREATE INDEX debt_project_idx ON financing.debt(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX bond_type_status_idx ON financing.bond(debt_type, subtype, status);
CREATE INDEX bond_maturity_idx ON financing.bond(maturity_date) WHERE closed_at IS NULL;
CREATE INDEX bond_project_idx ON financing.bond(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX income_certificate_type_status_idx ON financing.income_certificate(debt_type, subtype, status);
CREATE INDEX income_certificate_maturity_idx ON financing.income_certificate(maturity_date) WHERE closed_at IS NULL;
CREATE INDEX income_certificate_project_idx ON financing.income_certificate(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX income_right_maturity_idx ON financing.income_right(maturity_date) WHERE closed_at IS NULL;
CREATE INDEX income_right_project_idx ON financing.income_right(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX refinancing_maturity_idx ON financing.refinancing(maturity_date) WHERE closed_at IS NULL;
CREATE INDEX refinancing_project_idx ON financing.refinancing(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX swap_facility_maturity_idx ON financing.swap_facility(maturity_date) WHERE closed_at IS NULL;
CREATE INDEX swap_facility_project_idx ON financing.swap_facility(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX cashflow_due_idx ON financing.cashflow(due_date, cashflow_type);
CREATE INDEX cashflow_debt_due_idx ON financing.cashflow(debt_id, due_date);
CREATE INDEX balance_snapshot_date_idx ON financing.balance_snapshot(as_of_date DESC);

CREATE VIEW financing.debt_overview AS
SELECT
	d.*,
	COALESCE(NULLIF(d.subtype, ''), d.debt_type) AS reporting_type
FROM financing.debt d;

CREATE VIEW financing.cashflow_overview AS
SELECT
	c.*,
	CASE
		WHEN c.paid_at IS NOT NULL OR (c.amount IS NOT NULL AND COALESCE(c.paid_amount, 0) >= c.amount) THEN 'paid'
		WHEN c.due_date < CURRENT_DATE THEN 'overdue'
		WHEN c.due_date = CURRENT_DATE THEN 'due'
		ELSE 'planned'
	END AS status
FROM financing.cashflow c;

CREATE VIEW financing.data_overview AS
WITH latest_snapshot AS (
	SELECT MAX(as_of_date) AS as_of_date FROM financing.balance_snapshot
), snapshot_total AS (
	SELECT b.as_of_date, SUM(b.amount) AS amount
	FROM financing.balance_snapshot b
	JOIN latest_snapshot latest ON latest.as_of_date = b.as_of_date
	GROUP BY b.as_of_date
)
SELECT
	(SELECT COUNT(*) FROM financing.debt) AS debt_count,
	(SELECT COUNT(*) FROM financing.cashflow) AS cashflow_count,
	(SELECT COUNT(DISTINCT as_of_date) FROM financing.balance_snapshot) AS history_date_count,
	(SELECT MIN(as_of_date) FROM financing.balance_snapshot) AS history_start_date,
	(SELECT MAX(as_of_date) FROM financing.balance_snapshot) AS history_end_date,
	snapshot_total.as_of_date,
	snapshot_total.amount
FROM snapshot_total
UNION ALL
SELECT 0, 0, 0, NULL, NULL, NULL, NULL
WHERE NOT EXISTS (SELECT 1 FROM snapshot_total);

COMMENT ON TABLE financing.debt IS 'Liability base table. Native PostgreSQL inheritance stores specialized liabilities in child tables.';
COMMENT ON COLUMN financing.debt.name IS 'Short liability name suitable for UI display.';
COMMENT ON COLUMN financing.debt.amount IS 'Current outstanding principal amount in CNY.';
COMMENT ON COLUMN financing.debt.status IS 'Generated from activation, settlement and closure lifecycle dates.';
COMMENT ON TABLE financing.cashflow IS 'Unified principal, interest, fee and supplemental cash-flow schedule.';
COMMENT ON COLUMN financing.cashflow.debt_id IS 'Validated against the inherited debt hierarchy by trigger because PostgreSQL foreign keys do not span inheritance children.';

COMMIT;
