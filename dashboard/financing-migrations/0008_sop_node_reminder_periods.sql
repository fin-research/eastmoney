BEGIN;

SET LOCAL search_path TO financing, public;

-- The legacy reminder model cannot express SOP-node targeting or multiple
-- hour-level lead periods. Product has confirmed that legacy rules and their
-- delivery history may be discarded instead of migrated.
DELETE FROM reminder_rules;

DROP INDEX IF EXISTS reminder_rules_active_idx;

ALTER TABLE reminder_rules
	DROP COLUMN target_type,
	DROP COLUMN debt_type,
	DROP COLUMN trigger_field,
	DROP COLUMN offset_days,
	DROP COLUMN frequency;

CREATE TABLE reminder_rule_nodes (
	rule_id text NOT NULL REFERENCES reminder_rules(id) ON DELETE CASCADE,
	sop_node_id text NOT NULL REFERENCES sop_nodes(id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (rule_id, sop_node_id)
);

CREATE TABLE reminder_rule_periods (
	id text PRIMARY KEY,
	rule_id text NOT NULL REFERENCES reminder_rules(id) ON DELETE CASCADE,
	lead_hours integer NOT NULL CHECK (lead_hours BETWEEN 0 AND 87623),
	sort_order integer NOT NULL CHECK (sort_order > 0),
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (rule_id, lead_hours),
	UNIQUE (rule_id, id)
);

ALTER TABLE reminder_deliveries
	DROP CONSTRAINT reminder_deliveries_rule_id_target_id_delivery_date_key,
	ADD COLUMN period_id text NOT NULL,
	ADD COLUMN scheduled_for timestamptz NOT NULL,
	ADD CONSTRAINT reminder_deliveries_period_rule_fk
		FOREIGN KEY (rule_id, period_id)
		REFERENCES reminder_rule_periods(rule_id, id)
		ON DELETE CASCADE,
	ADD CONSTRAINT reminder_deliveries_rule_target_period_key
		UNIQUE (rule_id, target_id, period_id);

CREATE INDEX reminder_rules_active_idx ON reminder_rules(is_active);
CREATE INDEX reminder_rule_nodes_node_idx ON reminder_rule_nodes(sop_node_id, rule_id);
CREATE INDEX reminder_rule_periods_rule_idx ON reminder_rule_periods(rule_id, sort_order);
CREATE INDEX reminder_deliveries_scheduled_idx ON reminder_deliveries(scheduled_for DESC, created_at DESC);

COMMIT;
