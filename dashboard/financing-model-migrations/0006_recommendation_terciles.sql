-- Reclassify existing model outputs from their stored historical percentiles.
-- Validation metrics remain the actual historical run's measured results.
UPDATE financing_model.model_run
SET recommendation = CASE
      WHEN historical_percentile <= 100.0 / 3 THEN 'strong_buy'
      WHEN historical_percentile <= 200.0 / 3 THEN 'neutral'
      ELSE 'wait' END,
    recommendation_label = CASE
      WHEN historical_percentile <= 100.0 / 3 THEN '建议发行'
      WHEN historical_percentile <= 200.0 / 3 THEN '建议等待'
      ELSE '暂缓发行' END;

UPDATE financing_model.model_run
SET decision = recommendation_label,
    base_conclusion_verdict = recommendation_label,
    conclusion_verdict = CASE WHEN conclusion_updated_at IS NULL
      THEN recommendation_label ELSE conclusion_verdict END;

UPDATE financing_model.model_run_product_scenario
SET recommendation = CASE
      WHEN historical_percentile <= 100.0 / 3 THEN 'strong_buy'
      WHEN historical_percentile <= 200.0 / 3 THEN 'neutral'
      ELSE 'wait' END,
    recommendation_label = CASE
      WHEN historical_percentile <= 100.0 / 3 THEN '建议发行'
      WHEN historical_percentile <= 200.0 / 3 THEN '建议等待'
      ELSE '暂缓发行' END;

UPDATE financing_model.model_run_forecast_window
SET label = CASE
      WHEN percentile <= 100.0 / 3 THEN '建议发行'
      WHEN percentile <= 200.0 / 3 THEN '建议等待'
      ELSE '暂缓发行' END;
