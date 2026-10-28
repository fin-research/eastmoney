BEGIN;

SET LOCAL search_path TO financing, public;

-- A report date has one replayable snapshot. Regenerating that date replaces
-- the same R2 object and the same database index row instead of creating a
-- second historical entry for the day.
WITH ranked AS (
	SELECT id,
		ROW_NUMBER() OVER (
			PARTITION BY as_of_date
			ORDER BY (status = 'complete') DESC, generated_at DESC, id DESC
		) AS occurrence
	FROM liability_weekly_report_runs
)
DELETE FROM liability_weekly_report_runs report
USING ranked
WHERE report.id = ranked.id AND ranked.occurrence > 1;

CREATE UNIQUE INDEX IF NOT EXISTS liability_weekly_report_daily_idx
	ON liability_weekly_report_runs(as_of_date);

COMMENT ON TABLE liability_weekly_report_runs IS 'One replayable report snapshot per as-of date. Regeneration overwrites the same eastmoney/liability-report/yyyy-mm-dd.json R2 object.';

COMMIT;
