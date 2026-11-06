-- coupon-forecast-v3: issuance-coupon forecast of four products with exact factor attribution. Independent of model_run, so the
-- same-day timing forecast and this forecast never replace each other; the page joins them by as_of_date.
CREATE TABLE financing_model.coupon_forecast_run (
 run_id uuid PRIMARY KEY,
 as_of_date date NOT NULL UNIQUE,
 market_data_date date NOT NULL,
 generated_at timestamptz NOT NULL,
 model_version text NOT NULL CHECK(model_version ~ '^[a-f0-9]{20}$'),
 training_as_of date NOT NULL,
 retrain_after date NOT NULL,
 training_label_cutoff date NOT NULL,
 issuer text NOT NULL CHECK(btrim(issuer)<>''),
 timing_action text NOT NULL CHECK(timing_action IN ('尽快','等待','暂缓')),
 timing_catch_up_bp double precision NOT NULL CHECK(abs(timing_catch_up_bp)<'Infinity'::double precision),
 timing_wait_bp double precision NOT NULL CHECK(abs(timing_wait_bp)<'Infinity'::double precision),
 narrative text NOT NULL CHECK(btrim(narrative)<>''),
 training_events integer NOT NULL CHECK(training_events>0),
 first_training_event date NOT NULL,
 dev_start date NOT NULL, dev_end date NOT NULL, dev_samples integer NOT NULL CHECK(dev_samples>0),
 dev_mae_bp double precision NOT NULL CHECK(dev_mae_bp>=0 AND dev_mae_bp<'Infinity'::double precision),
 dev_hit_rate_5bp double precision NOT NULL CHECK(dev_hit_rate_5bp BETWEEN 0 AND 1),
 dev_win_rate double precision NOT NULL CHECK(dev_win_rate BETWEEN 0 AND 1),
 holdout_start date NOT NULL, holdout_end date NOT NULL, holdout_samples integer NOT NULL CHECK(holdout_samples>0),
 holdout_mae_bp double precision NOT NULL CHECK(holdout_mae_bp>=0 AND holdout_mae_bp<'Infinity'::double precision),
 holdout_hit_rate_5bp double precision NOT NULL CHECK(holdout_hit_rate_5bp BETWEEN 0 AND 1),
 holdout_win_rate double precision NOT NULL CHECK(holdout_win_rate BETWEEN 0 AND 1),
 online_result_key text NOT NULL,
 CHECK(market_data_date<as_of_date AND training_label_cutoff<training_as_of AND training_as_of<=retrain_after)
);
CREATE TABLE financing_model.coupon_forecast_product (
 run_id uuid NOT NULL REFERENCES financing_model.coupon_forecast_run(run_id) ON DELETE CASCADE,
 product_key text NOT NULL CHECK(product_key IN ('3y-public','3y-sub','5y-public','5y-sub')),
 label text NOT NULL, tenor double precision NOT NULL CHECK(tenor IN (3,5)),
 bond_type text NOT NULL CHECK(bond_type IN ('证券公司债','证券公司次级债')),
 anchor_pct double precision NOT NULL CHECK(anchor_pct>0 AND anchor_pct<'Infinity'::double precision),
 issuer_median_bp double precision NOT NULL CHECK(abs(issuer_median_bp)<'Infinity'::double precision),
 intercept_bp double precision NOT NULL CHECK(abs(intercept_bp)<'Infinity'::double precision),
 base_coupon_bp double precision NOT NULL CHECK(abs(base_coupon_bp)<'Infinity'::double precision),
 deviation_bp double precision NOT NULL CHECK(abs(deviation_bp)<'Infinity'::double precision),
 coupon_pct double precision NOT NULL CHECK(coupon_pct>0 AND coupon_pct<'Infinity'::double precision),
 n_prior integer NOT NULL CHECK(n_prior>=2),
 planned_amount_yi double precision NOT NULL CHECK(planned_amount_yi>0 AND planned_amount_yi<'Infinity'::double precision),
 CHECK((product_key,tenor,bond_type) IN (('3y-public',3,'证券公司债'),('3y-sub',3,'证券公司次级债'),('5y-public',5,'证券公司债'),('5y-sub',5,'证券公司次级债'))),
 PRIMARY KEY(run_id,product_key)
);
CREATE TABLE financing_model.coupon_forecast_group (
 run_id uuid NOT NULL, product_key text NOT NULL,
 group_name text NOT NULL CHECK(group_name IN ('利率','信用','资金面','基本面','一级发行','二级行情','发行条款')),
 net_bp double precision NOT NULL CHECK(abs(net_bp)<'Infinity'::double precision),
 PRIMARY KEY(run_id,product_key,group_name),
 FOREIGN KEY(run_id,product_key) REFERENCES financing_model.coupon_forecast_product(run_id,product_key) ON DELETE CASCADE
);
CREATE TABLE financing_model.coupon_forecast_contribution (
 run_id uuid NOT NULL, product_key text NOT NULL, ordinal integer NOT NULL CHECK(ordinal>=0),
 feature text NOT NULL, label text NOT NULL CHECK(btrim(label)<>''),
 group_name text NOT NULL CHECK(group_name IN ('利率','信用','资金面','基本面','一级发行','二级行情','发行条款')),
 value double precision NOT NULL CHECK(abs(value)<'Infinity'::double precision),
 contribution_bp double precision NOT NULL CHECK(abs(contribution_bp)<'Infinity'::double precision),
 PRIMARY KEY(run_id,product_key,ordinal),
 FOREIGN KEY(run_id,product_key) REFERENCES financing_model.coupon_forecast_product(run_id,product_key) ON DELETE CASCADE
);
CREATE TABLE financing_model.coupon_forecast_path (
 run_id uuid NOT NULL, product_key text NOT NULL, ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 9),
 observation_date date NOT NULL,
 coupon_percent double precision NOT NULL CHECK(coupon_percent>0 AND coupon_percent<'Infinity'::double precision),
 PRIMARY KEY(run_id,product_key,ordinal),
 FOREIGN KEY(run_id,product_key) REFERENCES financing_model.coupon_forecast_product(run_id,product_key) ON DELETE CASCADE
);

CREATE FUNCTION financing_model.publish_coupon_forecast(payload jsonb,result_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
 model_date date := (payload->>'as_of_date')::date;
 source_date date := (payload->>'market_source_date')::date;
 training_date date := (payload #>> '{online_run,training_as_of}')::date;
 expiry date := (payload #>> '{online_run,retrain_after}')::date;
 generated timestamptz := (payload->>'generated_at')::timestamptz;
 existing financing_model.coupon_forecast_run%ROWTYPE;
 stored uuid;
 item jsonb; entry jsonb; group_total double precision; contribution_total double precision;
 keys text[] := ARRAY['3y-public','3y-sub','5y-public','5y-sub'];
 groups text[] := ARRAY['利率','信用','资金面','基本面','一级发行','二级行情','发行条款'];
BEGIN
 PERFORM 1 FROM financing_model.model_eligibility WHERE model_version=payload->>'model_version' AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Model is not active: quality review required'; END IF;
 IF (payload #>> '{online_run,runtime}') IS DISTINCT FROM 'cloudflare-workflow'
  OR (payload #>> '{online_run,feature_version}') IS DISTINCT FROM 'coupon-forecast-v3'
  OR payload->>'schema_version' IS DISTINCT FROM 'coupon-forecast-v3'
  OR COALESCE(payload->>'model_version','') !~ '^[a-f0-9]{20}$'
  OR (payload #>> '{online_run,model_version}') IS DISTINCT FROM payload->>'model_version'
  OR COALESCE(payload #>> '{online_run,workflow_id}','') !~ '^[A-Za-z0-9_-]{1,100}$'
  OR (payload #>> '{online_run,input_prefix}') IS DISTINCT FROM 'quant-trial/runs/'||model_date||'/'||(payload #>> '{online_run,workflow_id}')
  OR result_key IS DISTINCT FROM (payload #>> '{online_run,input_prefix}')||'/result.json'
  OR model_date IS NULL OR source_date IS NULL OR training_date IS NULL OR expiry IS NULL OR generated IS NULL
  OR source_date>=model_date OR model_date<training_date OR model_date>expiry OR training_date>expiry
  OR model_date>(now() AT TIME ZONE 'Asia/Shanghai')::date
  OR (payload->>'training_label_cutoff')::date IS NULL OR (payload->>'training_label_cutoff')::date>=training_date
  OR COALESCE(btrim(payload->>'issuer'),'')=''
  OR payload #>> '{timing,action}' NOT IN ('尽快','等待','暂缓')
  OR jsonb_typeof(payload #> '{timing,catch_up_bp}') IS DISTINCT FROM 'number'
  OR jsonb_typeof(payload #> '{timing,wait_bp}') IS DISTINCT FROM 'number'
  OR COALESCE(btrim(payload #>> '{base_conclusion,narrative}'),'')=''
  OR payload #>> '{base_conclusion,verdict}' IS DISTINCT FROM payload #>> '{timing,action}'
  OR COALESCE(payload #>> '{base_conclusion,preferred_window}','')<>''
  OR jsonb_typeof(payload->'products') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'products')<>4
  OR (SELECT count(DISTINCT p->>'key') FROM jsonb_array_elements(payload->'products') p WHERE p->>'key'=ANY(keys))<>4
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['training_events','first_training_event']) k WHERE payload #> ARRAY['validation',k] IS NULL)
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['sample_count','mae_bp','hit_rate_5bp','win_rate_vs_issuer_median']) k, unnest(ARRAY['development','holdout']) w
    WHERE jsonb_typeof(payload #> ARRAY['validation',w,k]) IS DISTINCT FROM 'number')
  OR payload #>> '{validation,validation_scope}' IS DISTINCT FROM 'walk_forward'
  OR payload #>> '{validation,status}' IS DISTINCT FROM 'post_hoc_selected'
 THEN RAISE EXCEPTION 'Invalid coupon forecast result'; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(payload->'products') LOOP
  IF EXISTS(SELECT 1 FROM unnest(ARRAY['anchor_pct','issuer_median_bp','intercept_bp','base_coupon_bp','deviation_bp','coupon_pct','n_prior','planned_amount_yi','tenor']) k WHERE jsonb_typeof(item->k) IS DISTINCT FROM 'number')
   OR jsonb_typeof(item->'groups') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'groups')<>7
   OR (SELECT count(DISTINCT x->>'group') FROM jsonb_array_elements(item->'groups') x WHERE x->>'group'=ANY(groups))<>7
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(item->'groups') x WHERE jsonb_typeof(x->'net_bp') IS DISTINCT FROM 'number')
   OR jsonb_typeof(item->'contributions') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'contributions')<1
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(item->'contributions') x WHERE jsonb_typeof(x->'value') IS DISTINCT FROM 'number'
     OR jsonb_typeof(x->'contribution_bp') IS DISTINCT FROM 'number'
     OR (x->>'group') IS NULL OR NOT (x->>'group')=ANY(groups) OR COALESCE(btrim(x->>'label'),'')='' OR COALESCE(btrim(x->>'feature'),'')='')
   OR jsonb_typeof(item->'path') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'path') NOT BETWEEN 1 AND 10
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(item->'path') x WHERE jsonb_typeof(x->'coupon_percent') IS DISTINCT FROM 'number'
     OR (x->>'coupon_percent')::double precision<=0 OR (x->>'date')::date IS NULL OR (x->>'date')::date<=source_date)
  THEN RAISE EXCEPTION 'Invalid coupon forecast product'; END IF;
  SELECT sum((x->>'net_bp')::double precision) INTO group_total FROM jsonb_array_elements(item->'groups') x;
  SELECT sum((x->>'contribution_bp')::double precision) INTO contribution_total FROM jsonb_array_elements(item->'contributions') x;
  IF abs((item->>'base_coupon_bp')::double precision+group_total-(item->>'coupon_pct')::double precision*100)>=1e-6
   OR abs(group_total-contribution_total)>=1e-6
   OR abs((item->>'anchor_pct')::double precision*100+(item->>'deviation_bp')::double precision-(item->>'coupon_pct')::double precision*100)>=1e-6
  THEN RAISE EXCEPTION 'Coupon contributions do not reconcile'; END IF;
 END LOOP;
 SELECT * INTO existing FROM financing_model.coupon_forecast_run WHERE as_of_date=model_date FOR UPDATE;
 IF FOUND THEN
  IF generated<=existing.generated_at THEN RETURN existing.run_id; END IF;
  DELETE FROM financing_model.coupon_forecast_product WHERE run_id=existing.run_id;
  stored := existing.run_id;
  UPDATE financing_model.coupon_forecast_run SET market_data_date=source_date,generated_at=generated,model_version=payload->>'model_version',
   training_as_of=training_date,retrain_after=expiry,training_label_cutoff=(payload->>'training_label_cutoff')::date,issuer=payload->>'issuer',
   timing_action=payload #>> '{timing,action}',timing_catch_up_bp=(payload #>> '{timing,catch_up_bp}')::double precision,
   timing_wait_bp=(payload #>> '{timing,wait_bp}')::double precision,narrative=payload #>> '{base_conclusion,narrative}',
   training_events=(payload #>> '{validation,training_events}')::integer,first_training_event=(payload #>> '{validation,first_training_event}')::date,
   dev_start=(payload #>> '{validation,development,start}')::date,dev_end=(payload #>> '{validation,development,end}')::date,
   dev_samples=(payload #>> '{validation,development,sample_count}')::integer,dev_mae_bp=(payload #>> '{validation,development,mae_bp}')::double precision,
   dev_hit_rate_5bp=(payload #>> '{validation,development,hit_rate_5bp}')::double precision,dev_win_rate=(payload #>> '{validation,development,win_rate_vs_issuer_median}')::double precision,
   holdout_start=(payload #>> '{validation,holdout,start}')::date,holdout_end=(payload #>> '{validation,holdout,end}')::date,
   holdout_samples=(payload #>> '{validation,holdout,sample_count}')::integer,holdout_mae_bp=(payload #>> '{validation,holdout,mae_bp}')::double precision,
   holdout_hit_rate_5bp=(payload #>> '{validation,holdout,hit_rate_5bp}')::double precision,holdout_win_rate=(payload #>> '{validation,holdout,win_rate_vs_issuer_median}')::double precision,
   online_result_key=result_key WHERE run_id=stored;
 ELSE
  stored := (payload->>'run_id')::uuid;
  INSERT INTO financing_model.coupon_forecast_run(run_id,as_of_date,market_data_date,generated_at,model_version,training_as_of,retrain_after,training_label_cutoff,issuer,
   timing_action,timing_catch_up_bp,timing_wait_bp,narrative,training_events,first_training_event,dev_start,dev_end,dev_samples,dev_mae_bp,dev_hit_rate_5bp,dev_win_rate,
   holdout_start,holdout_end,holdout_samples,holdout_mae_bp,holdout_hit_rate_5bp,holdout_win_rate,online_result_key)
  VALUES(stored,model_date,source_date,generated,payload->>'model_version',training_date,expiry,(payload->>'training_label_cutoff')::date,payload->>'issuer',
   payload #>> '{timing,action}',(payload #>> '{timing,catch_up_bp}')::double precision,(payload #>> '{timing,wait_bp}')::double precision,payload #>> '{base_conclusion,narrative}',
   (payload #>> '{validation,training_events}')::integer,(payload #>> '{validation,first_training_event}')::date,
   (payload #>> '{validation,development,start}')::date,(payload #>> '{validation,development,end}')::date,(payload #>> '{validation,development,sample_count}')::integer,
   (payload #>> '{validation,development,mae_bp}')::double precision,(payload #>> '{validation,development,hit_rate_5bp}')::double precision,(payload #>> '{validation,development,win_rate_vs_issuer_median}')::double precision,
   (payload #>> '{validation,holdout,start}')::date,(payload #>> '{validation,holdout,end}')::date,(payload #>> '{validation,holdout,sample_count}')::integer,
   (payload #>> '{validation,holdout,mae_bp}')::double precision,(payload #>> '{validation,holdout,hit_rate_5bp}')::double precision,(payload #>> '{validation,holdout,win_rate_vs_issuer_median}')::double precision,result_key);
 END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(payload->'products') LOOP
  INSERT INTO financing_model.coupon_forecast_product(run_id,product_key,label,tenor,bond_type,anchor_pct,issuer_median_bp,intercept_bp,base_coupon_bp,deviation_bp,coupon_pct,n_prior,planned_amount_yi)
  VALUES(stored,item->>'key',item->>'label',(item->>'tenor')::double precision,item->>'bond_type',(item->>'anchor_pct')::double precision,(item->>'issuer_median_bp')::double precision,
   (item->>'intercept_bp')::double precision,(item->>'base_coupon_bp')::double precision,(item->>'deviation_bp')::double precision,(item->>'coupon_pct')::double precision,
   (item->>'n_prior')::integer,(item->>'planned_amount_yi')::double precision);
  INSERT INTO financing_model.coupon_forecast_group(run_id,product_key,group_name,net_bp)
   SELECT stored,item->>'key',x->>'group',(x->>'net_bp')::double precision FROM jsonb_array_elements(item->'groups') x;
  INSERT INTO financing_model.coupon_forecast_contribution(run_id,product_key,ordinal,feature,label,group_name,value,contribution_bp)
   SELECT stored,item->>'key',(o-1)::integer,x->>'feature',x->>'label',x->>'group',(x->>'value')::double precision,(x->>'contribution_bp')::double precision
   FROM jsonb_array_elements(item->'contributions') WITH ORDINALITY AS t(x,o);
  INSERT INTO financing_model.coupon_forecast_path(run_id,product_key,ordinal,observation_date,coupon_percent)
   SELECT stored,item->>'key',(o-1)::integer,(x->>'date')::date,(x->>'coupon_percent')::double precision
   FROM jsonb_array_elements(item->'path') WITH ORDINALITY AS t(x,o);
 END LOOP;
 RETURN stored;
END;
$$;
CREATE OR REPLACE FUNCTION financing_model.publish_online_result(payload jsonb,result_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE stored_id uuid;
BEGIN
 IF payload->>'schema_version'='coupon-forecast-v3' THEN
   RETURN financing_model.publish_coupon_forecast(payload,result_key);
 END IF;
 IF payload->>'schema_version'='timing-advice-v2' THEN
   RETURN financing_model.publish_timing_nowcast_result(payload,result_key);
 END IF;
 stored_id := financing_model.publish_timing_v1_result(payload,result_key);
 DELETE FROM financing_model.timing_nowcast_run n USING financing_model.model_run r
  WHERE n.run_id=stored_id AND r.id=stored_id AND r.online_feature_version<>'timing-advice-v2';
 RETURN stored_id;
END;
$$;
