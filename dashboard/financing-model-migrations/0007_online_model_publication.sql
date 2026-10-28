-- Quant publishes the frozen R2 result through this atomic, invoker-rights adapter.
-- Model values stay relational; raw inputs and result JSON remain in R2.
ALTER TABLE financing_model.model_run
  ADD COLUMN online_model_version text,
  ADD COLUMN online_feature_version text,
  ADD COLUMN online_training_as_of date,
  ADD COLUMN online_retrain_after date,
  ADD COLUMN online_excluded_groups text[],
  ADD COLUMN online_result_key text;

CREATE FUNCTION financing_model.publish_online_result(payload jsonb, result_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  incoming financing_model.model_run;
  stored_id uuid;
BEGIN
  IF (payload->>'schema_version') IS DISTINCT FROM '3'
    OR (payload #>> '{online_run,runtime}') IS DISTINCT FROM 'cloudflare-workflow'
    OR (payload #>> '{online_run,feature_version}') IS DISTINCT FROM 'online-market-v1'
    OR COALESCE(payload #>> '{online_run,model_version}', '') !~ '^[a-f0-9]{20}$'
    OR result_key IS DISTINCT FROM
       (payload #>> '{online_run,input_prefix}') || '/result.json'
    OR (payload #>> '{online_run,input_prefix}') IS DISTINCT FROM
       'quant-trial/runs/' || (payload->>'as_of_date') || '/' || (payload #>> '{online_run,workflow_id}')
    OR COALESCE(payload #>> '{online_run,workflow_id}', '') !~ '^[A-Za-z0-9_-]{1,100}$'
    OR payload->'company_metrics' IS DISTINCT FROM 'null'::jsonb
    OR jsonb_typeof(payload #> '{online_run,excluded_groups}') IS DISTINCT FROM 'array'
    OR COALESCE(jsonb_array_length(payload->'market_drivers'), 0) < 1
    OR COALESCE(jsonb_array_length(payload->'driver_structure'), 0) < 1
    OR COALESCE(jsonb_array_length(payload->'forecast_window'), 0) < 1
    OR jsonb_array_length(payload #> '{product_recommendation,scenarios}') IS DISTINCT FROM 4
  THEN
    RAISE EXCEPTION 'Invalid online financing model result';
  END IF;

  incoming := jsonb_populate_record(NULL::financing_model.model_run,
  jsonb_build_object(
    'id', payload #> '{run_id}',
    'schema_version', payload #> '{schema_version}',
    'model_name', payload #> '{model_name}',
    'generated_at', payload #> '{generated_at}',
    'as_of_date', payload #> '{as_of_date}',
    'market_data_date', payload #> '{market_data_date}',
    'issue_size_billion_yuan', payload #> '{issue_terms,issue_size_billion_yuan}',
    'tenor_years', payload #> '{issue_terms,tenor_years}',
    'rating', payload #> '{issue_terms,rating}',
    'bond_type', payload #> '{issue_terms,bond_type}',
    'predicted_deviation_bp', payload #> '{prediction,deviation_bp}',
    'peer_spread_median_bp', payload #> '{prediction,peer_spread_median_bp}',
    'historical_percentile', payload #> '{prediction,historical_percentile}',
    'recommendation', payload #> '{prediction,recommendation}',
    'recommendation_label', payload #> '{prediction,recommendation_label}',
    'decision', payload #> '{prediction,decision}',
    'company_metrics_date', payload #> '{company_metrics,date}',
    'lcr_value', payload #> '{company_metrics,ef_lcr}',
    'nsfr_value', payload #> '{company_metrics,ef_nsfr}',
    'lcr_percentile_60d', payload #> '{company_metrics,ef_lcr_pctile_60d}',
    'nsfr_percentile_60d', payload #> '{company_metrics,ef_nsfr_pctile_60d}',
    'funding_gap_yi_yuan', payload #> '{company_metrics,ef_funding_gap}',
    'company_margin_zscore_60d', payload #> '{company_metrics,ef_margin_zscore_60d}',
    'company_funding_pressure', payload #> '{company_metrics,ef_funding_pressure}',
    'subject_spread_bp', payload #> '{company_metrics,ef_subject_spread_bp}',
    'subject_spread_percentile', payload #> '{company_metrics,ef_subject_spread_pctile}',
    'subject_spread_date', payload #> '{company_metrics,ef_subject_spread_date}',
    'company_composite_score', payload #> '{company_metrics,composite_score}',
    'company_readiness_label', payload #> '{company_metrics,readiness_label}',
    'company_interpretation', payload #> '{company_metrics,interpretation}',
    'cv_folds', payload #> '{validation,tscv,folds}',
    'cv_validation_samples', payload #> '{validation,tscv,validation_samples}',
    'model_sample_count', payload #> '{validation,tscv,sample_count}',
    'model_sample_start_date', payload #> '{validation,tscv,sample_start_date}',
    'model_sample_end_date', payload #> '{validation,tscv,sample_end_date}'
  ) ||
  jsonb_build_object(
    'cv_rmse', payload #> '{validation,tscv,rmse}',
    'cv_mae', payload #> '{validation,tscv,mae}',
    'cv_ic', payload #> '{validation,tscv,ic}',
    'cv_best_iter_median', payload #> '{validation,tscv,best_iter_median}',
    'cv_best_iters', payload #> '{validation,tscv,best_iters}',
    'timing_n_total', payload #> '{validation,timing_value,n_total}',
    'timing_n_recommended', payload #> '{validation,timing_value,n_recommended}',
    'timing_recommended_share', payload #> '{validation,timing_value,recommended_share}',
    'timing_cost_saving_bp', payload #> '{validation,timing_value,cost_saving_bp}',
    'timing_recommended_mean_bp', payload #> '{validation,timing_value,recommended_mean_bp}',
    'timing_baseline_mean_bp', payload #> '{validation,timing_value,baseline_mean_bp}',
    'timing_win_rate', payload #> '{validation,timing_value,win_rate}',
    'timing_ic', payload #> '{validation,timing_value,ic}',
    'timing_group_means', payload #> '{validation,timing_value,group_means}',
    'timing_monotonic', payload #> '{validation,timing_value,monotonic}',
    'recommended_product', payload #> '{product_recommendation,recommended_product}',
    'recommended_tenor_years', payload #> '{product_recommendation,recommended_tenor_years}',
    'recommended_bond_type', payload #> '{product_recommendation,recommended_bond_type}',
    'base_conclusion_verdict', payload #> '{base_conclusion,verdict}',
    'base_conclusion_preferred_window', payload #> '{base_conclusion,preferred_window}',
    'base_conclusion_narrative', payload #> '{base_conclusion,narrative}',
    'base_conclusion_preferred_dates', payload #> '{base_conclusion,preferred_dates}',
    'source_market_data_date', payload #> '{source_freshness,market_data_date}',
    'source_company_metrics_date', payload #> '{source_freshness,company_metrics_date}',
    'source_subject_spread_date', payload #> '{source_freshness,subject_spread_date}',
    'conclusion_verdict', payload #> '{base_conclusion,verdict}',
    'conclusion_preferred_window', payload #> '{base_conclusion,preferred_window}',
    'conclusion_narrative', payload #> '{base_conclusion,narrative}',
    'online_model_version', payload #> '{online_run,model_version}',
    'online_feature_version', payload #> '{online_run,feature_version}',
    'online_training_as_of', payload #> '{online_run,training_as_of}',
    'online_retrain_after', payload #> '{online_run,retrain_after}',
    'online_excluded_groups', payload #> '{online_run,excluded_groups}'
  ) || jsonb_build_object('online_result_key', result_key));

  IF incoming.as_of_date < incoming.online_training_as_of
    OR incoming.as_of_date > incoming.online_retrain_after
    OR incoming.online_training_as_of IS NULL OR incoming.online_retrain_after IS NULL
    OR incoming.market_data_date >= incoming.as_of_date
    OR incoming.as_of_date > (now() AT TIME ZONE 'Asia/Shanghai')::date
  THEN
    RAISE EXCEPTION 'Invalid online financing model dates';
  END IF;

  INSERT INTO financing_model.model_run (
    id, schema_version, model_name, generated_at,
    as_of_date, market_data_date, issue_size_billion_yuan, tenor_years,
    rating, bond_type, predicted_deviation_bp, peer_spread_median_bp,
    historical_percentile, recommendation, recommendation_label, decision,
    company_metrics_date, lcr_value, nsfr_value, lcr_percentile_60d,
    nsfr_percentile_60d, funding_gap_yi_yuan, company_margin_zscore_60d, company_funding_pressure,
    subject_spread_bp, subject_spread_percentile, subject_spread_date, company_composite_score,
    company_readiness_label, company_interpretation, cv_folds, cv_validation_samples,
    model_sample_count, model_sample_start_date, model_sample_end_date, cv_rmse,
    cv_mae, cv_ic, cv_best_iter_median, cv_best_iters,
    timing_n_total, timing_n_recommended, timing_recommended_share, timing_cost_saving_bp,
    timing_recommended_mean_bp, timing_baseline_mean_bp, timing_win_rate, timing_ic,
    timing_group_means, timing_monotonic, recommended_product, recommended_tenor_years,
    recommended_bond_type, base_conclusion_verdict, base_conclusion_preferred_window, base_conclusion_narrative,
    base_conclusion_preferred_dates, source_market_data_date, source_company_metrics_date, source_subject_spread_date,
    conclusion_verdict, conclusion_preferred_window, conclusion_narrative, online_model_version,
    online_feature_version, online_training_as_of, online_retrain_after, online_excluded_groups,
    online_result_key
  ) VALUES (
    incoming.id, incoming.schema_version, incoming.model_name, incoming.generated_at,
    incoming.as_of_date, incoming.market_data_date, incoming.issue_size_billion_yuan, incoming.tenor_years,
    incoming.rating, incoming.bond_type, incoming.predicted_deviation_bp, incoming.peer_spread_median_bp,
    incoming.historical_percentile, incoming.recommendation, incoming.recommendation_label, incoming.decision,
    incoming.company_metrics_date, incoming.lcr_value, incoming.nsfr_value, incoming.lcr_percentile_60d,
    incoming.nsfr_percentile_60d, incoming.funding_gap_yi_yuan, incoming.company_margin_zscore_60d, incoming.company_funding_pressure,
    incoming.subject_spread_bp, incoming.subject_spread_percentile, incoming.subject_spread_date, incoming.company_composite_score,
    incoming.company_readiness_label, incoming.company_interpretation, incoming.cv_folds, incoming.cv_validation_samples,
    incoming.model_sample_count, incoming.model_sample_start_date, incoming.model_sample_end_date, incoming.cv_rmse,
    incoming.cv_mae, incoming.cv_ic, incoming.cv_best_iter_median, incoming.cv_best_iters,
    incoming.timing_n_total, incoming.timing_n_recommended, incoming.timing_recommended_share, incoming.timing_cost_saving_bp,
    incoming.timing_recommended_mean_bp, incoming.timing_baseline_mean_bp, incoming.timing_win_rate, incoming.timing_ic,
    incoming.timing_group_means, incoming.timing_monotonic, incoming.recommended_product, incoming.recommended_tenor_years,
    incoming.recommended_bond_type, incoming.base_conclusion_verdict, incoming.base_conclusion_preferred_window, incoming.base_conclusion_narrative,
    incoming.base_conclusion_preferred_dates, incoming.source_market_data_date, incoming.source_company_metrics_date, incoming.source_subject_spread_date,
    incoming.conclusion_verdict, incoming.conclusion_preferred_window, incoming.conclusion_narrative, incoming.online_model_version,
    incoming.online_feature_version, incoming.online_training_as_of, incoming.online_retrain_after, incoming.online_excluded_groups,
    incoming.online_result_key
  )
  ON CONFLICT (as_of_date) DO UPDATE SET
    schema_version = EXCLUDED.schema_version,
    model_name = EXCLUDED.model_name,
    generated_at = EXCLUDED.generated_at,
    market_data_date = EXCLUDED.market_data_date,
    issue_size_billion_yuan = EXCLUDED.issue_size_billion_yuan,
    tenor_years = EXCLUDED.tenor_years,
    rating = EXCLUDED.rating,
    bond_type = EXCLUDED.bond_type,
    predicted_deviation_bp = EXCLUDED.predicted_deviation_bp,
    peer_spread_median_bp = EXCLUDED.peer_spread_median_bp,
    historical_percentile = EXCLUDED.historical_percentile,
    recommendation = EXCLUDED.recommendation,
    recommendation_label = EXCLUDED.recommendation_label,
    decision = EXCLUDED.decision,
    company_metrics_date = EXCLUDED.company_metrics_date,
    lcr_value = EXCLUDED.lcr_value,
    nsfr_value = EXCLUDED.nsfr_value,
    lcr_percentile_60d = EXCLUDED.lcr_percentile_60d,
    nsfr_percentile_60d = EXCLUDED.nsfr_percentile_60d,
    funding_gap_yi_yuan = EXCLUDED.funding_gap_yi_yuan,
    company_margin_zscore_60d = EXCLUDED.company_margin_zscore_60d,
    company_funding_pressure = EXCLUDED.company_funding_pressure,
    subject_spread_bp = EXCLUDED.subject_spread_bp,
    subject_spread_percentile = EXCLUDED.subject_spread_percentile,
    subject_spread_date = EXCLUDED.subject_spread_date,
    company_composite_score = EXCLUDED.company_composite_score,
    company_readiness_label = EXCLUDED.company_readiness_label,
    company_interpretation = EXCLUDED.company_interpretation,
    cv_folds = EXCLUDED.cv_folds,
    cv_validation_samples = EXCLUDED.cv_validation_samples,
    model_sample_count = EXCLUDED.model_sample_count,
    model_sample_start_date = EXCLUDED.model_sample_start_date,
    model_sample_end_date = EXCLUDED.model_sample_end_date,
    cv_rmse = EXCLUDED.cv_rmse,
    cv_mae = EXCLUDED.cv_mae,
    cv_ic = EXCLUDED.cv_ic,
    cv_best_iter_median = EXCLUDED.cv_best_iter_median,
    cv_best_iters = EXCLUDED.cv_best_iters,
    timing_n_total = EXCLUDED.timing_n_total,
    timing_n_recommended = EXCLUDED.timing_n_recommended,
    timing_recommended_share = EXCLUDED.timing_recommended_share,
    timing_cost_saving_bp = EXCLUDED.timing_cost_saving_bp,
    timing_recommended_mean_bp = EXCLUDED.timing_recommended_mean_bp,
    timing_baseline_mean_bp = EXCLUDED.timing_baseline_mean_bp,
    timing_win_rate = EXCLUDED.timing_win_rate,
    timing_ic = EXCLUDED.timing_ic,
    timing_group_means = EXCLUDED.timing_group_means,
    timing_monotonic = EXCLUDED.timing_monotonic,
    recommended_product = EXCLUDED.recommended_product,
    recommended_tenor_years = EXCLUDED.recommended_tenor_years,
    recommended_bond_type = EXCLUDED.recommended_bond_type,
    base_conclusion_verdict = EXCLUDED.base_conclusion_verdict,
    base_conclusion_preferred_window = EXCLUDED.base_conclusion_preferred_window,
    base_conclusion_narrative = EXCLUDED.base_conclusion_narrative,
    base_conclusion_preferred_dates = EXCLUDED.base_conclusion_preferred_dates,
    source_market_data_date = EXCLUDED.source_market_data_date,
    source_company_metrics_date = EXCLUDED.source_company_metrics_date,
    source_subject_spread_date = EXCLUDED.source_subject_spread_date,
    conclusion_verdict = CASE WHEN model_run.conclusion_updated_at IS NULL THEN EXCLUDED.conclusion_verdict ELSE model_run.conclusion_verdict END,
    conclusion_preferred_window = CASE WHEN model_run.conclusion_updated_at IS NULL THEN EXCLUDED.conclusion_preferred_window ELSE model_run.conclusion_preferred_window END,
    conclusion_narrative = CASE WHEN model_run.conclusion_updated_at IS NULL THEN EXCLUDED.conclusion_narrative ELSE model_run.conclusion_narrative END,
    online_model_version = EXCLUDED.online_model_version,
    online_feature_version = EXCLUDED.online_feature_version,
    online_training_as_of = EXCLUDED.online_training_as_of,
    online_retrain_after = EXCLUDED.online_retrain_after,
    online_excluded_groups = EXCLUDED.online_excluded_groups,
    online_result_key = EXCLUDED.online_result_key
  WHERE model_run.online_model_version IS NULL OR EXCLUDED.generated_at > model_run.generated_at
  RETURNING id INTO stored_id;

  IF stored_id IS NULL THEN
    SELECT id INTO stored_id FROM financing_model.model_run WHERE as_of_date = incoming.as_of_date;
    RETURN stored_id;
  END IF;

  DELETE FROM financing_model.model_run_market_driver WHERE run_id = stored_id;
  INSERT INTO financing_model.model_run_market_driver
  SELECT detail.* FROM jsonb_array_elements(payload #> '{market_drivers}') WITH ORDINALITY AS entry(value, ordinal)
  CROSS JOIN LATERAL jsonb_populate_record(NULL::financing_model.model_run_market_driver,
    jsonb_build_object('run_id', stored_id, 'ordinal', entry.ordinal,
      'feature', entry.value->'feature',
      'display_name', entry.value->'display_name',
      'shap', entry.value->'shap',
      'value', entry.value->'value',
      'direction', entry.value->'direction',
      'impact', entry.value->'impact')) AS detail;

  DELETE FROM financing_model.model_run_forecast_window WHERE run_id = stored_id;
  INSERT INTO financing_model.model_run_forecast_window
  SELECT detail.* FROM jsonb_array_elements(payload #> '{forecast_window}') WITH ORDINALITY AS entry(value, ordinal)
  CROSS JOIN LATERAL jsonb_populate_record(NULL::financing_model.model_run_forecast_window,
    jsonb_build_object('run_id', stored_id, 'ordinal', entry.ordinal,
      'forecast_date', entry.value->'date',
      'weekday', entry.value->'weekday',
      'percentile', entry.value->'percentile',
      'label', entry.value->'label',
      'predicted_deviation_bp', entry.value->'pred_bp',
      'savings_bp_vs_window_median', entry.value->'savings_bp_vs_window_median',
      'savings_wan_yuan_per_year', entry.value->'savings_万元/年')) AS detail;

  DELETE FROM financing_model.model_run_driver_group WHERE run_id = stored_id;
  INSERT INTO financing_model.model_run_driver_group
  SELECT detail.* FROM jsonb_array_elements(payload #> '{driver_structure}') WITH ORDINALITY AS entry(value, ordinal)
  CROSS JOIN LATERAL jsonb_populate_record(NULL::financing_model.model_run_driver_group,
    jsonb_build_object('run_id', stored_id, 'ordinal', entry.ordinal,
      'category', entry.value->'category',
      'display_name', entry.value->'display_name',
      'support_score', entry.value->'support_score',
      'support_bp', entry.value->'support_bp',
      'importance_weight', entry.value->'importance_weight')) AS detail;

  DELETE FROM financing_model.model_run_product_scenario WHERE run_id = stored_id;
  INSERT INTO financing_model.model_run_product_scenario
  SELECT detail.* FROM jsonb_array_elements(payload #> '{product_recommendation,scenarios}') WITH ORDINALITY AS entry(value, ordinal)
  CROSS JOIN LATERAL jsonb_populate_record(NULL::financing_model.model_run_product_scenario,
    jsonb_build_object('run_id', stored_id, 'ordinal', entry.ordinal,
      'display_name', entry.value->'display_name',
      'tenor_years', entry.value->'tenor_years',
      'bond_type', entry.value->'bond_type',
      'predicted_deviation_bp', entry.value->'pred_bp',
      'peer_spread_median_bp', entry.value->'peer_spread_median_bp',
      'historical_percentile', entry.value->'historical_percentile',
      'recommendation', entry.value->'recommendation',
      'recommendation_label', entry.value->'recommendation_label',
      'rank', entry.value->'rank',
      'cost_vs_best_bp', entry.value->'cost_vs_best_bp',
      'is_recommended', entry.value->'is_recommended')) AS detail;

  RETURN stored_id;
END;
$$;

COMMENT ON FUNCTION financing_model.publish_online_result(jsonb, text) IS
  'Publish verified Quant Workflow results atomically; keep daily IDs and manual content, ignore stale replays';
