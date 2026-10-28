BEGIN;

-- NULL retains the existing point-in-time SOP contract; offset_days is the end.
ALTER TABLE financing.sop_nodes
	ADD COLUMN default_start_offset_days integer,
	ADD CONSTRAINT sop_nodes_schedule_period_check CHECK (
		default_start_offset_days IS NULL OR (
			default_start_offset_days BETWEEN -3650 AND 3650
			AND default_offset_days BETWEEN -3650 AND 3650
			AND default_start_offset_days <= default_offset_days
		)
	);

-- Old tasks inherited the project start, not an independently planned start.
-- Preserve those stored dates, while explicitly treating old tasks as points.
ALTER TABLE financing.project_tasks
	ADD COLUMN schedule_type text NOT NULL DEFAULT 'point',
	ADD CONSTRAINT project_tasks_schedule_type_check CHECK (schedule_type IN ('point', 'period')),
	ADD CONSTRAINT project_tasks_schedule_period_check CHECK (
		schedule_type = 'point' OR (
			planned_start_date IS NOT NULL AND due_date IS NOT NULL
			AND planned_start_date <= due_date
		)
	);

COMMIT;
