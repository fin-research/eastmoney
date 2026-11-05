-- Forecast level, recent quotes and factor attribution of timing-advice-v2. Additive: rows published before this migration keep NULL detail.
ALTER TABLE financing_model.timing_nowcast_run
 ADD COLUMN source_yield_pct double precision CHECK(source_yield_pct>0 AND source_yield_pct<'Infinity'::double precision),
 ADD COLUMN decision_quote_date date,
 ADD COLUMN wait_quote_date date,
 ADD COLUMN catch_up_base_bp double precision CHECK(abs(catch_up_base_bp)<'Infinity'::double precision),
 ADD COLUMN wait_base_bp double precision CHECK(abs(wait_base_bp)<'Infinity'::double precision),
 ADD CONSTRAINT timing_nowcast_detail_complete CHECK((source_yield_pct IS NULL)=(decision_quote_date IS NULL) AND (source_yield_pct IS NULL)=(catch_up_base_bp IS NULL) AND (source_yield_pct IS NULL)=(wait_base_bp IS NULL)),
 ADD CONSTRAINT timing_nowcast_wait_date_order CHECK(wait_quote_date IS NULL OR (decision_quote_date IS NOT NULL AND wait_quote_date>decision_quote_date));
CREATE TABLE financing_model.timing_nowcast_history (
 run_id uuid NOT NULL REFERENCES financing_model.timing_nowcast_run(run_id) ON DELETE CASCADE,
 observation_date date NOT NULL,
 yield_pct double precision NOT NULL CHECK(yield_pct>0 AND yield_pct<'Infinity'::double precision),
 PRIMARY KEY(run_id,observation_date)
);
CREATE TABLE financing_model.timing_nowcast_attribution (
 run_id uuid NOT NULL REFERENCES financing_model.timing_nowcast_run(run_id) ON DELETE CASCADE,
 factor_group text NOT NULL CHECK(factor_group IN ('sector','cdb3','gov','aaa3','funding')),
 catch_up_bp double precision NOT NULL CHECK(abs(catch_up_bp)<'Infinity'::double precision),
 wait_bp double precision NOT NULL CHECK(abs(wait_bp)<'Infinity'::double precision),
 PRIMARY KEY(run_id,factor_group)
);
CREATE OR REPLACE FUNCTION financing_model.publish_timing_nowcast_result(payload jsonb,result_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
 stored_id uuid;
 model_date date := (payload->>'as_of_date')::date;
 action text := payload #>> '{decision,action}';
 training_date date := (payload #>> '{online_run,training_as_of}')::date;
 expiry date := (payload #>> '{online_run,retrain_after}')::date;
 has_detail boolean := payload #> '{forecast,source_yield_pct}' IS NOT NULL OR payload ? 'history' OR payload ? 'attribution';
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
 OR (has_detail AND (
  jsonb_typeof(payload #> '{forecast,source_yield_pct}') IS DISTINCT FROM 'number'
  OR (payload #>> '{forecast,source_yield_pct}')::double precision<=0
  OR jsonb_typeof(payload #> '{forecast,catch_up_base_bp}') IS DISTINCT FROM 'number'
  OR jsonb_typeof(payload #> '{forecast,wait_base_bp}') IS DISTINCT FROM 'number'
  OR (payload #>> '{forecast,decision_quote_date}')::date IS NULL
  OR (payload #>> '{forecast,decision_quote_date}')::date<=(payload->>'market_source_date')::date
  OR (jsonb_typeof(payload #> '{forecast,wait_quote_date}') IS DISTINCT FROM 'null' AND ((payload #>> '{forecast,wait_quote_date}')::date IS NULL OR (payload #>> '{forecast,wait_quote_date}')::date<=(payload #>> '{forecast,decision_quote_date}')::date))
  OR jsonb_typeof(payload->'history') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'history') NOT BETWEEN 1 AND 30
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'history') h WHERE jsonb_typeof(h->'yield_pct') IS DISTINCT FROM 'number' OR (h->>'yield_pct')::double precision<=0 OR (h->>'date')::date IS NULL OR (h->>'date')::date>(payload->>'market_source_date')::date)
  OR (SELECT count(DISTINCT h->>'date') FROM jsonb_array_elements(payload->'history') h)<>jsonb_array_length(payload->'history')
  OR (payload->'history'->(-1)->>'date')::date IS DISTINCT FROM (payload->>'market_source_date')::date
  OR (payload->'history'->(-1)->>'yield_pct')::double precision IS DISTINCT FROM (payload #>> '{forecast,source_yield_pct}')::double precision
  OR jsonb_typeof(payload->'attribution') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'attribution')<>5
  OR (SELECT count(DISTINCT a->>'group') FROM jsonb_array_elements(payload->'attribution') a WHERE a->>'group' IN ('sector','cdb3','gov','aaa3','funding'))<>5
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'attribution') a WHERE jsonb_typeof(a->'catch_up_bp') IS DISTINCT FROM 'number' OR jsonb_typeof(a->'wait_bp') IS DISTINCT FROM 'number')
  OR abs((payload #>> '{forecast,wait_base_bp}')::double precision+(SELECT sum((a->>'wait_bp')::double precision) FROM jsonb_array_elements(payload->'attribution') a)-(payload #>> '{forecast,wait_bp}')::double precision)>=1e-6
  OR abs((payload #>> '{forecast,catch_up_base_bp}')::double precision+(SELECT sum((a->>'catch_up_bp')::double precision) FROM jsonb_array_elements(payload->'attribution') a)-(payload #>> '{forecast,catch_up_bp}')::double precision)>=1e-6))
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
 INSERT INTO financing_model.timing_nowcast_run(run_id,scope,wait_quotes,threshold_bp,training_label_cutoff,action,forecast_catch_up_bp,forecast_wait_bp,probability_defer,probability_wait,probability_issue,validation_scope,validation_status,sample_count,prediction_start,prediction_end,catch_up_corr,catch_up_r2,wait_corr,spread_bp,spread_ci_low_bp,spread_ci_high_bp,source_yield_pct,decision_quote_date,wait_quote_date,catch_up_base_bp,wait_base_bp) VALUES(stored_id,(payload->>'scope')::text,(payload #>> '{forecast,wait_quotes}')::integer,(payload #>> '{forecast,threshold_bp}')::double precision,(payload->>'training_label_cutoff')::date,action,(payload #>> '{forecast,catch_up_bp}')::double precision,(payload #>> '{forecast,wait_bp}')::double precision,(payload #>> '{probabilities,defer}')::double precision,(payload #>> '{probabilities,wait}')::double precision,(payload #>> '{probabilities,issue}')::double precision,(payload #>> '{validation,validation_scope}')::text,(payload #>> '{validation,status}')::text,(payload #>> '{validation,sample_count}')::integer,(payload #>> '{validation,prediction_start}')::date,(payload #>> '{validation,prediction_end}')::date,(payload #>> '{validation,catch_up_corr}')::double precision,(payload #>> '{validation,catch_up_r2}')::double precision,(payload #>> '{validation,wait_corr}')::double precision,(payload #>> '{validation,spread_bp}')::double precision,(payload #>> '{validation,spread_ci_low_bp}')::double precision,(payload #>> '{validation,spread_ci_high_bp}')::double precision,(payload #>> '{forecast,source_yield_pct}')::double precision,(payload #>> '{forecast,decision_quote_date}')::date,(payload #>> '{forecast,wait_quote_date}')::date,(payload #>> '{forecast,catch_up_base_bp}')::double precision,(payload #>> '{forecast,wait_base_bp}')::double precision);
 IF has_detail THEN
  INSERT INTO financing_model.timing_nowcast_history(run_id,observation_date,yield_pct)
   SELECT stored_id,(h->>'date')::date,(h->>'yield_pct')::double precision FROM jsonb_array_elements(payload->'history') h;
  INSERT INTO financing_model.timing_nowcast_attribution(run_id,factor_group,catch_up_bp,wait_bp)
   SELECT stored_id,a->>'group',(a->>'catch_up_bp')::double precision,(a->>'wait_bp')::double precision FROM jsonb_array_elements(payload->'attribution') a;
 END IF;

 RETURN stored_id;
END;
$$;
