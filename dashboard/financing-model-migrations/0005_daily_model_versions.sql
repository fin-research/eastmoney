-- Serialize against uploads while consolidating existing daily versions.
LOCK TABLE financing_model.model_run IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE financing_model_daily_map ON COMMIT DROP AS
SELECT id AS old_id,
       first_value(id) OVER (
         PARTITION BY as_of_date ORDER BY generated_at DESC, created_at DESC, id DESC
       ) AS keep_id
FROM financing_model.model_run;

-- Never silently discard multiple independent manual decisions or conclusions.
DO $$
BEGIN
  IF EXISTS (
    SELECT map.keep_id FROM financing_model.timing_decision_record AS decision
    JOIN financing_model_daily_map AS map ON map.old_id = decision.run_id
    GROUP BY map.keep_id HAVING count(*) > 1
  ) OR EXISTS (
    SELECT map.keep_id FROM financing_model.model_run AS run
    JOIN financing_model_daily_map AS map ON map.old_id = run.id
    WHERE run.conclusion_updated_at IS NOT NULL
    GROUP BY map.keep_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Multiple manual entries for one model date require reconciliation';
  END IF;
END $$;

UPDATE financing_model.model_run AS target
SET conclusion_verdict = source.conclusion_verdict,
    conclusion_preferred_window = source.conclusion_preferred_window,
    conclusion_narrative = source.conclusion_narrative,
    conclusion_updated_at = source.conclusion_updated_at
FROM financing_model.model_run AS source
JOIN financing_model_daily_map AS map ON map.old_id = source.id
WHERE target.id = map.keep_id AND source.id <> target.id
  AND source.conclusion_updated_at IS NOT NULL;

UPDATE financing_model.sell_side_snapshot AS snapshot
SET run_id = map.keep_id
FROM financing_model_daily_map AS map
WHERE snapshot.run_id = map.old_id AND map.old_id <> map.keep_id;

UPDATE financing_model.timing_decision_record AS decision
SET run_id = map.keep_id
FROM financing_model_daily_map AS map
WHERE decision.run_id = map.old_id AND map.old_id <> map.keep_id;

DELETE FROM financing_model.model_run AS run
USING financing_model_daily_map AS map
WHERE run.id = map.old_id AND map.old_id <> map.keep_id;

ALTER TABLE financing_model.model_run
  ADD CONSTRAINT model_run_as_of_date_key UNIQUE (as_of_date);

COMMENT ON TABLE financing_model.model_run IS
  '按模型日期唯一；同日上传覆盖模型字段及明细，保留稳定 ID、人工结论、决策与研究快照';
