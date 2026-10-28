-- Preserve the publication function and its additive validation.
-- The compatibility field shap_bp also stores explicitly named ReLU path attribution.
DO $migration$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('financing_model.publish_online_result(jsonb,text)'::regprocedure)
    INTO definition;
  IF strpos(definition, $$NOT IN ('tree_path_dependent','linear','additive_market_coupon')$$)=0 THEN
    RAISE EXCEPTION 'Unexpected coupon attribution validator; inspect prior migrations';
  END IF;
  definition := replace(definition,
    $$NOT IN ('tree_path_dependent','linear','additive_market_coupon')$$,
    $$NOT IN ('tree_path_dependent','linear','additive_market_coupon','relu_path_integrated_gradients')$$);
  EXECUTE definition;
END;
$migration$;
