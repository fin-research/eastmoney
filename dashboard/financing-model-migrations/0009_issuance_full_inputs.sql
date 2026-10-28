-- Accept the full-input issuer pricing bundle while retaining v1 run publication.
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
    OR payload #>> '{online_run,feature_version}' NOT IN ('issuance-lgb-v1','issuance-lgb-v2')
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
  narrative := action;
  INSERT INTO financing_model.model_run (
    id,schema_version,model_name,generated_at,as_of_date,market_data_date,issue_size_billion_yuan,tenor_years,rating,bond_type,
    recommendation_label,decision,base_conclusion_verdict,base_conclusion_preferred_window,base_conclusion_narrative,base_conclusion_preferred_dates,
    source_market_data_date,conclusion_verdict,conclusion_preferred_window,conclusion_narrative,
    online_model_version,online_feature_version,online_training_as_of,online_retrain_after,online_result_key)
  VALUES ((payload->>'run_id')::uuid,4,CASE WHEN payload #>> '{online_run,feature_version}'='issuance-lgb-v2' THEN 'issuance-lgb-v2' ELSE 'issuance-lgb-v1' END,(payload->>'generated_at')::timestamptz,model_date,
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
