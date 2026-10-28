ALTER TABLE financing_model.model_run
  RENAME COLUMN funding_gap_billion_yuan TO funding_gap_yi_yuan;

ALTER TABLE financing_model.model_run
  ADD COLUMN recommendation_label text,
  ADD COLUMN company_margin_zscore_60d numeric(20, 10),
  ADD COLUMN company_funding_pressure numeric(20, 10),
  ADD COLUMN subject_spread_date date,
  ADD COLUMN company_composite_score numeric(20, 10),
  ADD COLUMN company_readiness_label text,
  ADD COLUMN company_interpretation text,
  ADD COLUMN cv_folds integer,
  ADD COLUMN cv_validation_samples integer,
  ADD COLUMN cv_best_iter_median integer,
  ADD COLUMN cv_best_iters integer[],
  ADD COLUMN timing_n_total integer,
  ADD COLUMN timing_n_recommended integer,
  ADD COLUMN timing_recommended_share numeric(12, 10),
  ADD COLUMN timing_recommended_mean_bp numeric(20, 10),
  ADD COLUMN timing_baseline_mean_bp numeric(20, 10),
  ADD COLUMN timing_ic numeric(20, 10),
  ADD COLUMN timing_group_means numeric(20, 10)[],
  ADD COLUMN timing_monotonic boolean,
  ADD COLUMN base_conclusion_verdict text,
  ADD COLUMN base_conclusion_preferred_window text,
  ADD COLUMN base_conclusion_narrative text,
  ADD COLUMN base_conclusion_preferred_dates date[],
  ADD COLUMN source_market_data_date date,
  ADD COLUMN source_company_metrics_date date,
  ADD COLUMN source_subject_spread_date date,
  ADD COLUMN conclusion_verdict text,
  ADD COLUMN conclusion_preferred_window text,
  ADD COLUMN conclusion_narrative text,
  ADD COLUMN conclusion_updated_at timestamptz;

CREATE TABLE financing_model.model_run_market_driver (
  run_id uuid NOT NULL REFERENCES financing_model.model_run(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  feature text NOT NULL,
  display_name text NOT NULL,
  shap numeric(20, 10) NOT NULL,
  value numeric(24, 10) NOT NULL,
  direction text,
  impact text NOT NULL CHECK (impact IN ('推高成本', '降低成本')),
  PRIMARY KEY (run_id, ordinal)
);

CREATE TABLE financing_model.model_run_forecast_window (
  run_id uuid NOT NULL REFERENCES financing_model.model_run(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  forecast_date date NOT NULL,
  weekday text NOT NULL,
  percentile numeric(10, 6) NOT NULL CHECK (percentile BETWEEN 0 AND 100),
  label text NOT NULL,
  predicted_deviation_bp numeric(20, 8) NOT NULL,
  savings_bp_vs_window_median numeric(20, 8) NOT NULL,
  savings_wan_yuan_per_year numeric(24, 8) NOT NULL,
  PRIMARY KEY (run_id, ordinal)
);

INSERT INTO financing_model.model_run_market_driver (
  run_id, ordinal, feature, display_name, shap, value, direction, impact
)
SELECT
  run.id,
  driver.ordinality::integer,
  driver.item ->> 'feature',
  driver.item ->> 'display_name',
  (driver.item ->> 'shap')::numeric,
  (driver.item ->> 'value')::numeric,
  driver.item ->> 'direction',
  driver.item ->> 'impact'
FROM financing_model.model_run AS run
CROSS JOIN LATERAL jsonb_array_elements(run.payload -> 'market_drivers')
  WITH ORDINALITY AS driver(item, ordinality);

INSERT INTO financing_model.model_run_forecast_window (
  run_id,
  ordinal,
  forecast_date,
  weekday,
  percentile,
  label,
  predicted_deviation_bp,
  savings_bp_vs_window_median,
  savings_wan_yuan_per_year
)
SELECT
  run.id,
  forecast.ordinality::integer,
  (forecast.item ->> 'date')::date,
  forecast.item ->> 'weekday',
  (forecast.item ->> 'percentile')::numeric,
  forecast.item ->> 'label',
  (forecast.item ->> 'pred_bp')::numeric,
  (forecast.item ->> 'savings_bp_vs_window_median')::numeric,
  (forecast.item ->> 'savings_万元/年')::numeric
FROM financing_model.model_run AS run
CROSS JOIN LATERAL jsonb_array_elements(run.payload -> 'forecast_window')
  WITH ORDINALITY AS forecast(item, ordinality);

UPDATE financing_model.model_run
SET
  recommendation_label = payload #>> '{prediction,recommendation_label}',
  company_margin_zscore_60d = (payload #>> '{company_metrics,ef_margin_zscore_60d}')::numeric,
  company_funding_pressure = (payload #>> '{company_metrics,ef_funding_pressure}')::numeric,
  subject_spread_date = (payload #>> '{company_metrics,ef_subject_spread_date}')::date,
  company_composite_score = (payload #>> '{company_metrics,composite_score}')::numeric,
  company_readiness_label = payload #>> '{company_metrics,readiness_label}',
  company_interpretation = payload #>> '{company_metrics,interpretation}',
  cv_folds = (payload #>> '{validation,tscv,folds}')::integer,
  cv_validation_samples = (payload #>> '{validation,tscv,validation_samples}')::integer,
  cv_best_iter_median = (payload #>> '{validation,tscv,best_iter_median}')::integer,
  cv_best_iters = ARRAY(
    SELECT value::integer
    FROM jsonb_array_elements_text(payload #> '{validation,tscv,best_iters}') AS value
  ),
  timing_n_total = (payload #>> '{validation,timing_value,n_total}')::integer,
  timing_n_recommended = (payload #>> '{validation,timing_value,n_recommended}')::integer,
  timing_recommended_share = (payload #>> '{validation,timing_value,recommended_share}')::numeric,
  timing_recommended_mean_bp = (payload #>> '{validation,timing_value,recommended_mean_bp}')::numeric,
  timing_baseline_mean_bp = (payload #>> '{validation,timing_value,baseline_mean_bp}')::numeric,
  timing_ic = (payload #>> '{validation,timing_value,ic}')::numeric,
  timing_group_means = ARRAY(
    SELECT value::numeric
    FROM jsonb_array_elements_text(payload #> '{validation,timing_value,group_means}') AS value
  ),
  timing_monotonic = (payload #>> '{validation,timing_value,monotonic}')::boolean,
  base_conclusion_verdict = payload #>> '{base_conclusion,verdict}',
  base_conclusion_preferred_window = payload #>> '{base_conclusion,preferred_window}',
  base_conclusion_narrative = payload #>> '{base_conclusion,narrative}',
  base_conclusion_preferred_dates = ARRAY(
    SELECT value::date
    FROM jsonb_array_elements_text(payload #> '{base_conclusion,preferred_dates}') AS value
  ),
  source_market_data_date = (payload #>> '{source_freshness,market_data_date}')::date,
  source_company_metrics_date = (payload #>> '{source_freshness,company_metrics_date}')::date,
  source_subject_spread_date = (payload #>> '{source_freshness,subject_spread_date}')::date,
  conclusion_verdict = payload #>> '{base_conclusion,verdict}',
  conclusion_preferred_window = payload #>> '{base_conclusion,preferred_window}',
  conclusion_narrative = payload #>> '{base_conclusion,narrative}';

UPDATE financing_model.model_run AS run
SET
  conclusion_verdict = revision.verdict,
  conclusion_preferred_window = revision.preferred_window,
  conclusion_narrative = revision.narrative,
  conclusion_updated_at = revision.created_at
FROM (
  SELECT DISTINCT ON (run_id)
    run_id,
    verdict,
    preferred_window,
    narrative,
    created_at
  FROM financing_model.conclusion_revision
  ORDER BY run_id, created_at DESC, id DESC
) AS revision
WHERE revision.run_id = run.id;

ALTER TABLE financing_model.model_run
  ALTER COLUMN recommendation_label SET NOT NULL,
  ALTER COLUMN cv_folds SET NOT NULL,
  ALTER COLUMN cv_validation_samples SET NOT NULL,
  ALTER COLUMN cv_rmse SET NOT NULL,
  ALTER COLUMN cv_ic SET NOT NULL,
  ALTER COLUMN cv_best_iter_median SET NOT NULL,
  ALTER COLUMN cv_best_iters SET NOT NULL,
  ALTER COLUMN timing_n_total SET NOT NULL,
  ALTER COLUMN timing_n_recommended SET NOT NULL,
  ALTER COLUMN timing_cost_saving_bp SET NOT NULL,
  ALTER COLUMN timing_recommended_mean_bp SET NOT NULL,
  ALTER COLUMN timing_baseline_mean_bp SET NOT NULL,
  ALTER COLUMN timing_win_rate SET NOT NULL,
  ALTER COLUMN timing_ic SET NOT NULL,
  ALTER COLUMN timing_group_means SET NOT NULL,
  ALTER COLUMN timing_monotonic SET NOT NULL,
  ALTER COLUMN base_conclusion_verdict SET NOT NULL,
  ALTER COLUMN base_conclusion_preferred_window SET NOT NULL,
  ALTER COLUMN base_conclusion_narrative SET NOT NULL,
  ALTER COLUMN base_conclusion_preferred_dates SET NOT NULL,
  ALTER COLUMN source_market_data_date SET NOT NULL,
  ALTER COLUMN conclusion_verdict SET NOT NULL,
  ALTER COLUMN conclusion_preferred_window SET NOT NULL,
  ALTER COLUMN conclusion_narrative SET NOT NULL;

ALTER TABLE financing_model.model_run
  ADD CONSTRAINT financing_model_company_contract_check CHECK (
    company_metrics_date IS NULL OR (
      company_readiness_label IS NOT NULL AND
      company_interpretation IS NOT NULL
    )
  ),
  ADD CONSTRAINT financing_model_conclusion_verdict_length_check CHECK (
    char_length(conclusion_verdict) BETWEEN 1 AND 120
  ),
  ADD CONSTRAINT financing_model_conclusion_window_length_check CHECK (
    char_length(conclusion_preferred_window) <= 160
  ),
  ADD CONSTRAINT financing_model_conclusion_narrative_length_check CHECK (
    char_length(conclusion_narrative) BETWEEN 1 AND 4000
  );

DROP TABLE financing_model.conclusion_revision;

ALTER TABLE financing_model.model_run
  DROP COLUMN payload;

COMMENT ON TABLE financing_model.model_run IS
  'quant 追加结构化模型运行，dashboard 仅增量更新同一行的当前整体结论';
COMMENT ON TABLE financing_model.model_run_market_driver IS
  '模型运行的有序市场驱动因子';
COMMENT ON TABLE financing_model.model_run_forecast_window IS
  '模型运行的有序未来发行窗口';
COMMENT ON SCHEMA financing_model IS
  '债券融资择时模型运行、当前人工结论及卖方观点';
