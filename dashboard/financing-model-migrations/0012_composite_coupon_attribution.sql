-- Preserve the verified publication function; allow the explicitly named
-- tree + linear market + reference-anchor additive decomposition.
DO $migration$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('financing_model.publish_online_result(jsonb,text)'::regprocedure)
    INTO definition;
  IF strpos(definition, $$NOT IN ('tree_path_dependent','linear')$$)=0 THEN
    RAISE EXCEPTION 'Unexpected coupon attribution validator; inspect prior migrations';
  END IF;
  definition := replace(definition,
    $$NOT IN ('tree_path_dependent','linear')$$,
    $$NOT IN ('tree_path_dependent','linear','additive_market_coupon')$$);
  EXECUTE definition;
END;
$migration$;
