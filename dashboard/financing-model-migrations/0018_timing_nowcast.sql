-- Directional timing contract timing-advice-v2: forecast of the sector-curve move and an action from a fixed bp threshold. v1 rows and publisher stay unchanged.
CREATE TABLE financing_model.timing_nowcast_run (
 run_id uuid PRIMARY KEY REFERENCES financing_model.model_run(id),
 scope text NOT NULL CHECK(scope='AAA证券公司债3Y'),
 wait_quotes integer NOT NULL CHECK(wait_quotes=3),
 threshold_bp double precision NOT NULL CHECK(threshold_bp>0 AND threshold_bp<'Infinity'::double precision),
 training_label_cutoff date NOT NULL,
 action text NOT NULL CHECK(action IN ('尽快','等待','暂缓')),
 forecast_catch_up_bp double precision NOT NULL CHECK(forecast_catch_up_bp>'-Infinity'::double precision AND forecast_catch_up_bp<'Infinity'::double precision),
 forecast_wait_bp double precision NOT NULL CHECK(forecast_wait_bp>'-Infinity'::double precision AND forecast_wait_bp<'Infinity'::double precision),
 probability_defer double precision NOT NULL CHECK(probability_defer BETWEEN 0 AND 1),
 probability_wait double precision NOT NULL CHECK(probability_wait BETWEEN 0 AND 1),
 probability_issue double precision NOT NULL CHECK(probability_issue BETWEEN 0 AND 1),
 validation_scope text NOT NULL CHECK(validation_scope='walk_forward'),
 validation_status text NOT NULL CHECK(validation_status='post_hoc_selected'),
 sample_count integer NOT NULL CHECK(sample_count>0),
 prediction_start date NOT NULL,
 prediction_end date NOT NULL,
 catch_up_corr double precision NOT NULL CHECK(catch_up_corr BETWEEN -1 AND 1),
 catch_up_r2 double precision NOT NULL CHECK(catch_up_r2<=1 AND catch_up_r2>'-Infinity'::double precision),
 wait_corr double precision NOT NULL CHECK(wait_corr BETWEEN -1 AND 1),
 spread_bp double precision NOT NULL CHECK(spread_bp>'-Infinity'::double precision AND spread_bp<'Infinity'::double precision),
 spread_ci_low_bp double precision NOT NULL CHECK(spread_ci_low_bp>'-Infinity'::double precision),
 spread_ci_high_bp double precision NOT NULL CHECK(spread_ci_high_bp<'Infinity'::double precision),
 CHECK(abs(probability_defer+probability_wait+probability_issue-1)<1e-8),
 CHECK(prediction_start<=prediction_end),
 CHECK(spread_ci_low_bp<=spread_bp AND spread_bp<=spread_ci_high_bp),
 CHECK(action=CASE WHEN forecast_wait_bp>threshold_bp THEN '尽快' WHEN forecast_wait_bp<-threshold_bp THEN '暂缓' ELSE '等待' END)
);
ALTER FUNCTION financing_model.publish_online_result(jsonb,text) RENAME TO publish_timing_v1_result;
CREATE FUNCTION financing_model.publish_timing_nowcast_result(payload jsonb,result_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
 stored_id uuid;
 model_date date := (payload->>'as_of_date')::date;
 action text := payload #>> '{decision,action}';
 training_date date := (payload #>> '{online_run,training_as_of}')::date;
 expiry date := (payload #>> '{online_run,retrain_after}')::date;
BEGIN
 PERFORM 1 FROM financing_model.model_eligibility WHERE model_version=payload->>'model_version' AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Model is not active: quality review required'; END IF;
 IF (payload #>> '{online_run,runtime}') IS DISTINCT FROM 'cloudflare-workflow'
 OR (payload #>> '{online_run,feature_version}') IS DISTINCT FROM 'timing-advice-v2'
 OR COALESCE(payload->>'model_version','') !~ '^[a-f0-9]{20}$'
 OR (payload #>> '{online_run,model_version}') IS DISTINCT FROM payload->>'model_version'
 OR (payload #>> '{online_run,input_prefix}') IS DISTINCT FROM 'quant-trial/runs/'||model_date||'/'||(payload #>> '{online_run,workflow_id}')
 OR COALESCE(payload #>> '{online_run,workflow_id}','') !~ '^[A-Za-z0-9_-]{1,100}$'
 OR result_key IS DISTINCT FROM (payload #>> '{online_run,input_prefix}')||'/result.json'
 OR training_date IS NULL OR expiry IS NULL OR model_date IS NULL
 OR model_date<training_date OR model_date>expiry OR training_date>expiry
 OR (payload->>'market_source_date')::date IS NULL OR (payload->>'market_source_date')::date>=model_date
 OR (payload->>'training_label_cutoff')::date IS NULL OR (payload->>'training_label_cutoff')::date>=training_date
 OR (payload #>> '{validation,prediction_end}')::date>=training_date
 OR model_date>(now() AT TIME ZONE 'Asia/Shanghai')::date
 OR jsonb_typeof(payload #> '{probabilities,defer}') IS DISTINCT FROM 'number'
 OR jsonb_typeof(payload #> '{probabilities,wait}') IS DISTINCT FROM 'number'
 OR jsonb_typeof(payload #> '{probabilities,issue}') IS DISTINCT FROM 'number'
 OR jsonb_typeof(payload #> '{forecast,catch_up_bp}') IS DISTINCT FROM 'number'
 OR jsonb_typeof(payload #> '{forecast,wait_bp}') IS DISTINCT FROM 'number'
 OR jsonb_typeof(payload #> '{forecast,threshold_bp}') IS DISTINCT FROM 'number'
 OR jsonb_typeof(payload #> '{forecast,wait_quotes}') IS DISTINCT FROM 'number'
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['sample_count','catch_up_corr','catch_up_r2','wait_corr','spread_bp','spread_ci_low_bp','spread_ci_high_bp']) k WHERE jsonb_typeof(payload #> ARRAY['validation',k]) IS DISTINCT FROM 'number')
 OR action NOT IN ('尽快','等待','暂缓') OR action IS NULL
 OR payload #>> '{base_conclusion,verdict}' IS DISTINCT FROM action
 OR COALESCE(payload #>> '{base_conclusion,preferred_window}','')<>''
 OR COALESCE(btrim(payload #>> '{base_conclusion,narrative}'),'')=''
 OR payload ?| ARRAY['market_forecast','product_scenarios','explanation','terms','issue_size_yi','window_days','deadline','market_model','waiting_cost_bp_day']
 THEN RAISE EXCEPTION 'Invalid timing nowcast result'; END IF;
 INSERT INTO financing_model.model_run(id,schema_version,model_name,generated_at,as_of_date,market_data_date,
 recommendation,recommendation_label,decision,base_conclusion_verdict,base_conclusion_preferred_window,base_conclusion_narrative,base_conclusion_preferred_dates,
 source_market_data_date,conclusion_verdict,conclusion_preferred_window,conclusion_narrative,
 online_model_version,online_feature_version,online_training_as_of,online_retrain_after,online_result_key)
 VALUES((payload->>'run_id')::uuid,5,'timing-advice-v2',(payload->>'generated_at')::timestamptz,model_date,(payload->>'market_source_date')::date,
 CASE action WHEN '尽快' THEN 'strong_buy' WHEN '等待' THEN 'neutral' ELSE 'wait' END,action,action,
 action,'',payload #>> '{base_conclusion,narrative}',ARRAY[]::date[],(payload->>'market_source_date')::date,
 action,'',payload #>> '{base_conclusion,narrative}',payload->>'model_version','timing-advice-v2',training_date,expiry,result_key)
 ON CONFLICT(as_of_date) DO UPDATE SET schema_version=5,model_name=EXCLUDED.model_name,generated_at=EXCLUDED.generated_at,
 market_data_date=EXCLUDED.market_data_date,issue_size_billion_yuan=NULL,tenor_years=NULL,rating=NULL,bond_type=NULL,
 predicted_deviation_bp=NULL,peer_spread_median_bp=NULL,historical_percentile=NULL,
 recommendation=EXCLUDED.recommendation,recommendation_label=EXCLUDED.recommendation_label,decision=EXCLUDED.decision,
 base_conclusion_verdict=EXCLUDED.base_conclusion_verdict,base_conclusion_preferred_window='',base_conclusion_narrative=EXCLUDED.base_conclusion_narrative,base_conclusion_preferred_dates=ARRAY[]::date[],source_market_data_date=EXCLUDED.source_market_data_date,
 conclusion_verdict=CASE WHEN model_run.conclusion_updated_at IS NULL THEN EXCLUDED.conclusion_verdict ELSE model_run.conclusion_verdict END,
 conclusion_preferred_window=CASE WHEN model_run.conclusion_updated_at IS NULL THEN '' ELSE model_run.conclusion_preferred_window END,
 conclusion_narrative=CASE WHEN model_run.conclusion_updated_at IS NULL THEN EXCLUDED.conclusion_narrative ELSE model_run.conclusion_narrative END,
 online_model_version=EXCLUDED.online_model_version,online_feature_version=EXCLUDED.online_feature_version,online_training_as_of=EXCLUDED.online_training_as_of,online_retrain_after=EXCLUDED.online_retrain_after,online_result_key=EXCLUDED.online_result_key
 WHERE EXCLUDED.generated_at>model_run.generated_at RETURNING id INTO stored_id;
 IF stored_id IS NULL THEN SELECT id INTO stored_id FROM financing_model.model_run WHERE as_of_date=model_date; RETURN stored_id; END IF;
 DELETE FROM financing_model.timing_run WHERE run_id=stored_id;
 DELETE FROM financing_model.timing_nowcast_run WHERE run_id=stored_id;
 INSERT INTO financing_model.timing_nowcast_run(run_id,scope,wait_quotes,threshold_bp,training_label_cutoff,action,forecast_catch_up_bp,forecast_wait_bp,probability_defer,probability_wait,probability_issue,validation_scope,validation_status,sample_count,prediction_start,prediction_end,catch_up_corr,catch_up_r2,wait_corr,spread_bp,spread_ci_low_bp,spread_ci_high_bp) VALUES(stored_id,(payload->>'scope')::text,(payload #>> '{forecast,wait_quotes}')::integer,(payload #>> '{forecast,threshold_bp}')::double precision,(payload->>'training_label_cutoff')::date,action,(payload #>> '{forecast,catch_up_bp}')::double precision,(payload #>> '{forecast,wait_bp}')::double precision,(payload #>> '{probabilities,defer}')::double precision,(payload #>> '{probabilities,wait}')::double precision,(payload #>> '{probabilities,issue}')::double precision,(payload #>> '{validation,validation_scope}')::text,(payload #>> '{validation,status}')::text,(payload #>> '{validation,sample_count}')::integer,(payload #>> '{validation,prediction_start}')::date,(payload #>> '{validation,prediction_end}')::date,(payload #>> '{validation,catch_up_corr}')::double precision,(payload #>> '{validation,catch_up_r2}')::double precision,(payload #>> '{validation,wait_corr}')::double precision,(payload #>> '{validation,spread_bp}')::double precision,(payload #>> '{validation,spread_ci_low_bp}')::double precision,(payload #>> '{validation,spread_ci_high_bp}')::double precision);
 RETURN stored_id;
END;
$$;
CREATE FUNCTION financing_model.publish_online_result(payload jsonb,result_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE stored_id uuid;
BEGIN
 IF payload->>'schema_version'='timing-advice-v2' THEN
   RETURN financing_model.publish_timing_nowcast_result(payload,result_key);
 END IF;
 stored_id := financing_model.publish_timing_v1_result(payload,result_key);
 -- A same-day return to v1 must not leave the v2 detail row behind.
 DELETE FROM financing_model.timing_nowcast_run n USING financing_model.model_run r
  WHERE n.run_id=stored_id AND r.id=stored_id AND r.online_feature_version<>'timing-advice-v2';
 RETURN stored_id;
END;
$$;
