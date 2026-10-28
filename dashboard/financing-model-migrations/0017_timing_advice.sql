-- Keep coupon history and its publisher unchanged; a separate typed timing contract.
ALTER TABLE financing_model.model_run
 ALTER COLUMN issue_size_billion_yuan DROP NOT NULL,
 ALTER COLUMN tenor_years DROP NOT NULL,
 ALTER COLUMN rating DROP NOT NULL,
 ALTER COLUMN bond_type DROP NOT NULL;
ALTER TABLE financing_model.model_run ADD CONSTRAINT model_run_terms_contract CHECK (
 (schema_version=5 AND issue_size_billion_yuan IS NULL AND tenor_years IS NULL AND rating IS NULL AND bond_type IS NULL)
 OR (schema_version<>5 AND issue_size_billion_yuan IS NOT NULL AND tenor_years IS NOT NULL AND rating IS NOT NULL AND bond_type IS NOT NULL));
CREATE TABLE financing_model.timing_run (
 run_id uuid PRIMARY KEY REFERENCES financing_model.model_run(id),
 scope text NOT NULL CHECK(scope='AAA证券公司债3Y'),
 window_days integer NOT NULL CHECK(window_days=30),
 training_label_cutoff date NOT NULL,
 action text NOT NULL CHECK(action IN ('尽快','等待','暂缓')),
 probability_defer double precision NOT NULL CHECK(probability_defer BETWEEN 0 AND 1),
 probability_wait double precision NOT NULL CHECK(probability_wait BETWEEN 0 AND 1),
 probability_issue double precision NOT NULL CHECK(probability_issue BETWEEN 0 AND 1),
 validation_scope text NOT NULL CHECK(validation_scope='inner_development'),
 validation_status text NOT NULL CHECK(validation_status='user_selected_exploratory'),
 sample_count integer NOT NULL CHECK(sample_count>0),
 prediction_start date NOT NULL,
 prediction_end date NOT NULL,
 logloss double precision NOT NULL CHECK(logloss>=0 AND logloss<'Infinity'::double precision),
 brier double precision NOT NULL CHECK(brier>=0 AND brier<=2),
 immediate_tp integer NOT NULL CHECK(immediate_tp>=0),
 immediate_fp integer NOT NULL CHECK(immediate_fp>=0),
 immediate_target integer NOT NULL CHECK(immediate_target>0),
 immediate_precision double precision NOT NULL CHECK(immediate_precision BETWEEN 0 AND 1),
 immediate_recall double precision NOT NULL CHECK(immediate_recall BETWEEN 0 AND 1),
 selected_a_mean_bp double precision NOT NULL CHECK(selected_a_mean_bp>'-Infinity'::double precision AND selected_a_mean_bp<'Infinity'::double precision),
 CHECK(abs(probability_defer+probability_wait+probability_issue-1)<1e-8),
 CHECK(prediction_start<=prediction_end),
 CHECK(immediate_tp+immediate_fp>0 AND immediate_tp<=immediate_target AND immediate_tp+immediate_fp<=sample_count),
 CHECK(abs(immediate_precision-immediate_tp::double precision/NULLIF(immediate_tp+immediate_fp,0))<1e-8),
 CHECK(abs(immediate_recall-immediate_tp::double precision/immediate_target)<1e-8),
 CHECK(action=CASE WHEN probability_defer>=probability_wait AND probability_defer>=probability_issue THEN '暂缓' WHEN probability_wait>=probability_issue THEN '等待' ELSE '尽快' END)
);
ALTER FUNCTION financing_model.publish_online_result(jsonb,text) RENAME TO publish_coupon_result;
CREATE FUNCTION financing_model.publish_online_result(payload jsonb,result_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
 stored_id uuid;
 model_date date := (payload->>'as_of_date')::date;
 action text := payload #>> '{decision,action}';
 training_date date := (payload #>> '{online_run,training_as_of}')::date;
 expiry date := (payload #>> '{online_run,retrain_after}')::date;
BEGIN
 IF payload->>'schema_version' IS DISTINCT FROM 'timing-advice-v1' THEN
   RETURN financing_model.publish_coupon_result(payload,result_key);
 END IF;
 PERFORM 1 FROM financing_model.model_eligibility WHERE model_version=payload->>'model_version' AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Model is not active: quality review required'; END IF;
 IF (payload #>> '{online_run,runtime}') IS DISTINCT FROM 'cloudflare-workflow'
 OR (payload #>> '{online_run,feature_version}') IS DISTINCT FROM 'timing-advice-v1'
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
 OR action NOT IN ('尽快','等待','暂缓') OR action IS NULL
 OR payload #>> '{base_conclusion,verdict}' IS DISTINCT FROM action
 OR COALESCE(payload #>> '{base_conclusion,preferred_window}','')<>''
 OR COALESCE(btrim(payload #>> '{base_conclusion,narrative}'),'')=''
 OR payload ?| ARRAY['forecast','market_forecast','product_scenarios','explanation','terms','issue_size_yi']
 THEN RAISE EXCEPTION 'Invalid timing advice result'; END IF;
 INSERT INTO financing_model.model_run(id,schema_version,model_name,generated_at,as_of_date,market_data_date,
 recommendation,recommendation_label,decision,base_conclusion_verdict,base_conclusion_preferred_window,base_conclusion_narrative,base_conclusion_preferred_dates,
 source_market_data_date,conclusion_verdict,conclusion_preferred_window,conclusion_narrative,
 online_model_version,online_feature_version,online_training_as_of,online_retrain_after,online_result_key)
 VALUES((payload->>'run_id')::uuid,5,'timing-advice-v1',(payload->>'generated_at')::timestamptz,model_date,(payload->>'market_source_date')::date,
 CASE action WHEN '尽快' THEN 'strong_buy' WHEN '等待' THEN 'neutral' ELSE 'wait' END,action,action,
 action,'',payload #>> '{base_conclusion,narrative}',ARRAY[]::date[],(payload->>'market_source_date')::date,
 action,'',payload #>> '{base_conclusion,narrative}',payload->>'model_version','timing-advice-v1',training_date,expiry,result_key)
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
 INSERT INTO financing_model.timing_run(run_id,scope,window_days,training_label_cutoff,action,probability_defer,probability_wait,probability_issue,validation_scope,validation_status,sample_count,prediction_start,prediction_end,logloss,brier,immediate_tp,immediate_fp,immediate_target,immediate_precision,immediate_recall,selected_a_mean_bp) VALUES(stored_id,(payload->>'scope')::text,(payload->>'window_days')::integer,(payload->>'training_label_cutoff')::date,action,(payload #>> '{probabilities,defer}')::double precision,(payload #>> '{probabilities,wait}')::double precision,(payload #>> '{probabilities,issue}')::double precision,(payload #>> '{validation,validation_scope}')::text,(payload #>> '{validation,status}')::text,(payload #>> '{validation,sample_count}')::integer,(payload #>> '{validation,prediction_start}')::date,(payload #>> '{validation,prediction_end}')::date,(payload #>> '{validation,logloss}')::double precision,(payload #>> '{validation,brier}')::double precision,(payload #>> '{validation,immediate_tp}')::integer,(payload #>> '{validation,immediate_fp}')::integer,(payload #>> '{validation,immediate_target}')::integer,(payload #>> '{validation,immediate_precision}')::double precision,(payload #>> '{validation,immediate_recall}')::double precision,(payload #>> '{validation,selected_a_mean_bp}')::double precision);
 RETURN stored_id;
END;
$$;
