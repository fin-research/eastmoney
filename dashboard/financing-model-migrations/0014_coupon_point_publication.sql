-- Three declared coupon horizons carry no timing recommendation or savings.
-- Keep historical path publication and all value/additive checks unchanged.
DO $migration$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('financing_model.publish_online_result(jsonb,text)'::regprocedure)
    INTO definition;
  IF strpos(definition, '  narrative text;')=0 OR
     strpos(definition, $$IF jsonb_array_length(payload->'forecast')>0 THEN$$)=0 THEN
    RAISE EXCEPTION 'Unexpected coupon point validator; inspect prior migrations';
  END IF;
  definition := replace(definition, '  narrative text;', $patch$  narrative text;
  coupon_points boolean := payload #> '{validation,forecast_horizons}' = '[1,14,30]'::jsonb
    AND payload #> '{validation,expected_savings_supported}' = 'false'::jsonb;$patch$);
  definition := replace(definition,
    $$IF jsonb_array_length(payload->'forecast')>0 THEN$$,
    $patch$IF coupon_points THEN
    IF (SELECT jsonb_agg((f->>'lead_days')::integer ORDER BY n)
        FROM jsonb_array_elements(payload->'forecast') WITH ORDINALITY e(f,n)) IS DISTINCT FROM '[1,14,30]'::jsonb
      OR action IS DISTINCT FROM '仅预测票面'
      OR payload #>> '{decision,reason}' IS DISTINCT FROM 'coupon_prediction_only'
      OR payload #> '{decision,low_rate_dates}' IS DISTINCT FROM '[]'::jsonb
      OR payload #> '{decision,low_rate_windows}' IS DISTINCT FROM '[]'::jsonb
      OR EXISTS (SELECT 1 FROM unnest(ARRAY['first_issuance_date','lowest_expected_cost_date',
        'expected_net_saving_bp','annual_saving_wan','saving_probability','saving_p10_bp','joint_error_pairs']) k
        WHERE payload->'decision'->>k IS NOT NULL)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'forecast') f,
        unnest(ARRAY['coupon_low_percent','coupon_high_percent','net_saving_bp','expected_saving_bp',
          'waiting_cost_bp','annual_saving_wan','saving_probability','saving_p10_bp','pair_samples']) k
        WHERE f->>k IS NOT NULL)
    THEN RAISE EXCEPTION 'Invalid coupon point forecast'; END IF;
  END IF;
  IF jsonb_array_length(payload->'forecast')>0 AND NOT COALESCE(coupon_points,false) THEN$patch$);
  EXECUTE definition;
END;
$migration$;
