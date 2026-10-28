-- New absolute-coupon contract; historical relative-spread rows and manual content remain intact.
ALTER TABLE financing_model.model_run
  ALTER COLUMN predicted_deviation_bp DROP NOT NULL,
  ALTER COLUMN peer_spread_median_bp DROP NOT NULL,
  ALTER COLUMN historical_percentile DROP NOT NULL,
  ALTER COLUMN recommendation DROP NOT NULL,
  ALTER COLUMN cv_folds DROP NOT NULL,
  ALTER COLUMN cv_validation_samples DROP NOT NULL,
  ALTER COLUMN cv_rmse DROP NOT NULL,
  ALTER COLUMN cv_ic DROP NOT NULL,
  ALTER COLUMN cv_best_iter_median DROP NOT NULL,
  ALTER COLUMN cv_best_iters DROP NOT NULL,
  ALTER COLUMN timing_n_total DROP NOT NULL,
  ALTER COLUMN timing_n_recommended DROP NOT NULL,
  ALTER COLUMN timing_cost_saving_bp DROP NOT NULL,
  ALTER COLUMN timing_recommended_mean_bp DROP NOT NULL,
  ALTER COLUMN timing_baseline_mean_bp DROP NOT NULL,
  ALTER COLUMN timing_win_rate DROP NOT NULL,
  ALTER COLUMN timing_ic DROP NOT NULL,
  ALTER COLUMN timing_group_means DROP NOT NULL,
  ALTER COLUMN timing_monotonic DROP NOT NULL;

CREATE TABLE financing_model.issuance_run (
  run_id uuid PRIMARY KEY REFERENCES financing_model.model_run(id),
  issuer text NOT NULL,
  deadline date NOT NULL,
  window_days integer NOT NULL CHECK (window_days BETWEEN 1 AND 30),
  market_model text NOT NULL CHECK (market_model='lgb_anchor_drift'),
  waiting_cost_bp_day double precision NOT NULL CHECK (waiting_cost_bp_day>=0),
  action text NOT NULL,
  reason text NOT NULL,
  first_issuance_date date,
  lowest_expected_cost_date date,
  expected_net_saving_bp double precision,
  annual_saving_wan double precision,
  saving_probability double precision CHECK (saving_probability BETWEEN 0 AND 1),
  saving_p10_bp double precision,
  joint_error_pairs integer,
  decision_scope text NOT NULL,
  validation_status text NOT NULL,
  base_coupon_bp double precision,
  prediction_coupon_bp double precision,
  market_anchor_bp double precision,
  issuer_premium_bp double precision,
  horizon_drift_bp double precision,
  tree_expected_change_bp double precision,
  sample_count integer NOT NULL,
  prediction_start date NOT NULL,
  prediction_end date NOT NULL,
  calendar_year integer NOT NULL,
  calendar_source text NOT NULL
);
CREATE TABLE financing_model.issuance_forecast (
  run_id uuid NOT NULL REFERENCES financing_model.model_run(id), ordinal integer NOT NULL CHECK(ordinal>0),
  date date NOT NULL, lead_days integer NOT NULL CHECK(lead_days BETWEEN 0 AND 30),
  forecast_origin date NOT NULL, effective_horizon integer NOT NULL,
  market_change_bp double precision NOT NULL, market_level_percent double precision NOT NULL,
  market_volatility_bp double precision, market_source_date date NOT NULL,
  market_train_label_end date NOT NULL, market_training_samples integer NOT NULL,
  issuer_premium_bp double precision, coupon_percent double precision,
  own_observations integer NOT NULL, peer_observations integer NOT NULL,
  primary_history_latest_date date, status text NOT NULL,
  coupon_low_percent double precision, coupon_high_percent double precision,
  interval_samples integer NOT NULL, calibration_latest_label date,
  expected_saving_bp double precision, waiting_cost_bp double precision, net_saving_bp double precision,
  annual_saving_wan double precision, saving_probability double precision CHECK(saving_probability BETWEEN 0 AND 1),
  saving_p10_bp double precision, pair_samples integer,
  PRIMARY KEY(run_id,ordinal), UNIQUE(run_id,date),
  CHECK(coupon_low_percent IS NULL OR coupon_low_percent<=coupon_high_percent)
);
CREATE TABLE financing_model.issuance_market_path (
  run_id uuid NOT NULL REFERENCES financing_model.model_run(id), ordinal integer NOT NULL CHECK(ordinal>0),
  date date NOT NULL, market_level_percent double precision NOT NULL, quote_day boolean NOT NULL,
  issuance_day boolean NOT NULL, value_date date NOT NULL, status text NOT NULL,
  PRIMARY KEY(run_id,ordinal), UNIQUE(run_id,date)
);
CREATE TABLE financing_model.issuance_shap (
  run_id uuid NOT NULL REFERENCES financing_model.model_run(id), ordinal integer NOT NULL CHECK(ordinal>0),
  feature text NOT NULL, value double precision, shap_bp double precision NOT NULL,
  PRIMARY KEY(run_id,ordinal), UNIQUE(run_id,feature)
);
CREATE TABLE financing_model.issuance_validation (
  run_id uuid NOT NULL REFERENCES financing_model.model_run(id),
  lead_days integer NOT NULL, year integer NOT NULL, samples integer NOT NULL,
  mae_bp double precision NOT NULL, rmse_bp double precision NOT NULL, flat_market_mae_bp double precision NOT NULL,
  mae_skill_vs_flat_market double precision,
  PRIMARY KEY(run_id,lead_days,year)
);

CREATE OR REPLACE FUNCTION financing_model.publish_online_result(payload jsonb, result_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  stored_id uuid;
  row_value jsonb;
  model_date date := (payload->>'as_of_date')::date;
  action text := payload #>> '{decision,action}';
  deadline date := (payload->>'deadline')::date;
  narrative text;
BEGIN
  IF payload->>'schema_version' IS DISTINCT FROM 'issuance-forecast-v1'
    OR payload #>> '{online_run,runtime}' IS DISTINCT FROM 'cloudflare-workflow'
    OR payload #>> '{online_run,feature_version}' IS DISTINCT FROM 'issuance-lgb-v1'
    OR COALESCE(payload #>> '{online_run,model_version}','') !~ '^[a-f0-9]{20}$'
    OR COALESCE(payload #>> '{online_run,workflow_id}','') !~ '^[A-Za-z0-9_-]{1,100}$'
    OR result_key IS DISTINCT FROM 'quant-trial/runs/'||(payload->>'as_of_date')||'/'||(payload #>> '{online_run,workflow_id}')||'/result.json'
    OR result_key IS DISTINCT FROM (payload #>> '{online_run,input_prefix}')||'/result.json'
    OR model_date IS NULL OR model_date > (now() AT TIME ZONE 'Asia/Shanghai')::date
    OR (payload->>'market_source_date')::date >= model_date
    OR (payload #>> '{online_run,training_as_of}')::date > model_date
    OR (payload #>> '{online_run,retrain_after}')::date < model_date
    OR deadline IS DISTINCT FROM model_date+(payload->>'window_days')::integer
    OR jsonb_typeof(payload->'forecast') IS DISTINCT FROM 'array'
    OR jsonb_array_length(payload->'market_forecast') IS DISTINCT FROM (payload->>'window_days')::integer+1
    OR COALESCE(btrim(action),'')=''
    OR payload #>> '{online_run,training_as_of}' IS NULL
    OR payload #>> '{online_run,retrain_after}' IS NULL
    OR payload->>'market_source_date' IS NULL
  THEN RAISE EXCEPTION 'Invalid issuance forecast publication'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'forecast') r WHERE
    (r->>'date')::date NOT BETWEEN model_date AND deadline OR (r->>'lead_days')::integer IS DISTINCT FROM (r->>'date')::date-model_date
    OR (r->>'forecast_origin')::date NOT BETWEEN model_date AND (r->>'date')::date
    OR (r->>'effective_horizon')::integer IS DISTINCT FROM (r->>'date')::date-(r->>'forecast_origin')::date
    OR (r->>'market_source_date')::date>=model_date OR (r->>'market_train_label_end')::date>=model_date
    OR (r->>'primary_history_latest_date')::date>=model_date OR (r->>'calibration_latest_label')::date>=model_date)
  THEN RAISE EXCEPTION 'Unavailable forecast information'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'market_forecast') WITH ORDINALITY e(r,n) WHERE
    (r->>'date')::date IS DISTINCT FROM model_date+(n-1)::integer
    OR (r->>'value_date')::date>(r->>'date')::date)
  THEN RAISE EXCEPTION 'Invalid market path dates'; END IF;
  IF payload #>> '{forecast,0,coupon_percent}' IS NOT NULL AND
    (payload->'explanation' IS NULL OR payload->'explanation'='null'::jsonb)
  THEN RAISE EXCEPTION 'Missing coupon SHAP decomposition'; END IF;
  IF payload->'explanation' IS NOT NULL AND payload->'explanation' <> 'null'::jsonb AND (
    payload #>> '{explanation,method}' IS DISTINCT FROM 'tree_path_dependent'
    OR COALESCE(jsonb_array_length(payload #> '{explanation,features}'),0)=0
    OR payload #>> '{explanation,base_coupon_bp}' IS NULL
    OR payload #>> '{explanation,prediction_coupon_bp}' IS NULL
    OR payload #>> '{forecast,0,coupon_percent}' IS NULL
    OR abs((payload #>> '{explanation,prediction_coupon_bp}')::double precision
      -100*(payload #>> '{forecast,0,coupon_percent}')::double precision)>1e-7
    OR abs((payload #>> '{explanation,base_coupon_bp}')::double precision +
      (SELECT sum((v->>'shap_bp')::double precision) FROM jsonb_array_elements(payload #> '{explanation,features}') v)
      -(payload #>> '{explanation,prediction_coupon_bp}')::double precision)>1e-7)
  THEN RAISE EXCEPTION 'Invalid coupon SHAP decomposition'; END IF;
  narrative := CASE WHEN payload #>> '{decision,expected_net_saving_bp}' IS NULL THEN action
    ELSE '窗口预期净节约 ' || round((payload #>> '{decision,expected_net_saving_bp}')::numeric,2)::text || 'bp。' ||
      CASE WHEN payload #>> '{decision,saving_probability}' IS NULL THEN '历史配对样本不足。'
      ELSE '等待省钱概率 '|| round(100*(payload #>> '{decision,saving_probability}')::numeric)::text || '%。' END || action || '。' END;
  INSERT INTO financing_model.model_run (
    id,schema_version,model_name,generated_at,as_of_date,market_data_date,issue_size_billion_yuan,tenor_years,rating,bond_type,
    recommendation_label,decision,base_conclusion_verdict,base_conclusion_preferred_window,base_conclusion_narrative,base_conclusion_preferred_dates,
    source_market_data_date,conclusion_verdict,conclusion_preferred_window,conclusion_narrative,
    online_model_version,online_feature_version,online_training_as_of,online_retrain_after,online_result_key)
  VALUES ((payload->>'run_id')::uuid,4,'issuance-lgb-v1',(payload->>'generated_at')::timestamptz,model_date,
    (payload->>'market_source_date')::date,(payload->>'issue_size_yi')::numeric,(payload #>> '{terms,tenor}')::numeric,
    payload #>> '{terms,rating}',payload #>> '{terms,bond_type}',action,action,action,
    COALESCE(payload #>> '{decision,lowest_expected_cost_date}',''),narrative,
    CASE WHEN payload #>> '{decision,lowest_expected_cost_date}' IS NULL THEN ARRAY[]::date[] ELSE ARRAY[(payload #>> '{decision,lowest_expected_cost_date}')::date] END,
    (payload->>'market_source_date')::date,action,COALESCE(payload #>> '{decision,lowest_expected_cost_date}',''),narrative,
    payload #>> '{online_run,model_version}',payload #>> '{online_run,feature_version}',
    (payload #>> '{online_run,training_as_of}')::date,(payload #>> '{online_run,retrain_after}')::date,result_key)
  ON CONFLICT(as_of_date) DO UPDATE SET
    schema_version=4,model_name=EXCLUDED.model_name,generated_at=EXCLUDED.generated_at,market_data_date=EXCLUDED.market_data_date,
    issue_size_billion_yuan=EXCLUDED.issue_size_billion_yuan,tenor_years=EXCLUDED.tenor_years,rating=EXCLUDED.rating,bond_type=EXCLUDED.bond_type,
    predicted_deviation_bp=NULL,peer_spread_median_bp=NULL,historical_percentile=NULL,recommendation=NULL,
    recommendation_label=EXCLUDED.recommendation_label,decision=EXCLUDED.decision,
    base_conclusion_verdict=EXCLUDED.base_conclusion_verdict,base_conclusion_preferred_window=EXCLUDED.base_conclusion_preferred_window,
    base_conclusion_narrative=EXCLUDED.base_conclusion_narrative,base_conclusion_preferred_dates=EXCLUDED.base_conclusion_preferred_dates,
    source_market_data_date=EXCLUDED.source_market_data_date,
    conclusion_verdict=CASE WHEN model_run.conclusion_updated_at IS NULL THEN EXCLUDED.conclusion_verdict ELSE model_run.conclusion_verdict END,
    conclusion_preferred_window=CASE WHEN model_run.conclusion_updated_at IS NULL THEN EXCLUDED.conclusion_preferred_window ELSE model_run.conclusion_preferred_window END,
    conclusion_narrative=CASE WHEN model_run.conclusion_updated_at IS NULL THEN EXCLUDED.conclusion_narrative ELSE model_run.conclusion_narrative END,
    online_model_version=EXCLUDED.online_model_version,online_feature_version=EXCLUDED.online_feature_version,
    online_training_as_of=EXCLUDED.online_training_as_of,online_retrain_after=EXCLUDED.online_retrain_after,online_result_key=EXCLUDED.online_result_key
  WHERE model_run.schema_version<4 OR EXCLUDED.generated_at>model_run.generated_at RETURNING id INTO stored_id;
  IF stored_id IS NULL THEN
    SELECT id INTO stored_id FROM financing_model.model_run WHERE as_of_date=model_date;
    RETURN stored_id;
  END IF;
  row_value := jsonb_build_object('run_id',stored_id,'issuer',payload #> '{terms,issuer}','deadline',payload->'deadline',
    'window_days',payload->'window_days','market_model',payload->'market_model','waiting_cost_bp_day',payload->'waiting_cost_bp_day',
    'decision_scope',COALESCE(payload #> '{decision,scope}','"funding-cost comparison"'::jsonb),
    'validation_status',COALESCE(payload #> '{decision,validation_status}','"insufficient history"'::jsonb),
    'sample_count',payload #> '{validation,sample_count}','prediction_start',payload #> '{validation,prediction_start}',
    'prediction_end',payload #> '{validation,prediction_end}','calendar_year',payload #> '{calendar_audit,calendar,year}',
    'calendar_source',payload #> '{calendar_audit,calendar,issuance_source}') || (payload->'decision') || COALESCE(NULLIF(payload->'explanation','null'::jsonb),'{}'::jsonb);
  DELETE FROM financing_model.issuance_run WHERE run_id=stored_id;
  INSERT INTO financing_model.issuance_run SELECT * FROM jsonb_populate_record(NULL::financing_model.issuance_run,row_value);
  DELETE FROM financing_model.issuance_forecast WHERE run_id=stored_id;
  INSERT INTO financing_model.issuance_forecast SELECT r.* FROM jsonb_array_elements(payload->'forecast') WITH ORDINALITY e(value,ordinal)
    CROSS JOIN LATERAL jsonb_populate_record(NULL::financing_model.issuance_forecast,e.value||jsonb_build_object('run_id',stored_id,'ordinal',e.ordinal)) r;
  DELETE FROM financing_model.issuance_market_path WHERE run_id=stored_id;
  INSERT INTO financing_model.issuance_market_path SELECT r.* FROM jsonb_array_elements(payload->'market_forecast') WITH ORDINALITY e(value,ordinal)
    CROSS JOIN LATERAL jsonb_populate_record(NULL::financing_model.issuance_market_path,e.value||jsonb_build_object('run_id',stored_id,'ordinal',e.ordinal)) r;
  DELETE FROM financing_model.issuance_shap WHERE run_id=stored_id;
  INSERT INTO financing_model.issuance_shap SELECT r.* FROM jsonb_array_elements(payload #> '{explanation,features}') WITH ORDINALITY e(value,ordinal)
    CROSS JOIN LATERAL jsonb_populate_record(NULL::financing_model.issuance_shap,e.value||jsonb_build_object('run_id',stored_id,'ordinal',e.ordinal)) r;
  DELETE FROM financing_model.issuance_validation WHERE run_id=stored_id;
  INSERT INTO financing_model.issuance_validation SELECT r.* FROM jsonb_array_elements(payload #> '{validation,metrics}') e(value)
    CROSS JOIN LATERAL jsonb_populate_record(NULL::financing_model.issuance_validation,e.value||jsonb_build_object('run_id',stored_id)) r;
  RETURN stored_id;
END;
$$;
