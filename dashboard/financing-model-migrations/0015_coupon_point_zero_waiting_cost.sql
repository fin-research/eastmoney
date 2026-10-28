-- Zero is the existing prediction contract for no added waiting cost.
-- Keep all intervals/savings null and reject any nonzero waiting cost.
DO $migration$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('financing_model.publish_online_result(jsonb,text)'::regprocedure)
    INTO definition;
  IF strpos(definition, $$'waiting_cost_bp','annual_saving_wan','saving_probability','saving_p10_bp','pair_samples'$$)=0 THEN
    RAISE EXCEPTION 'Unexpected coupon point waiting cost validator; inspect prior migrations';
  END IF;
  definition := replace(definition,
    $$'waiting_cost_bp','annual_saving_wan','saving_probability','saving_p10_bp','pair_samples'$$,
    $$'annual_saving_wan','saving_probability','saving_p10_bp','pair_samples'$$);
  definition := replace(definition,
    $$THEN RAISE EXCEPTION 'Invalid coupon point forecast'; END IF;$$,
    $patch$OR EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'forecast') f
        WHERE f->>'waiting_cost_bp' IS NOT NULL AND
          (jsonb_typeof(f->'waiting_cost_bp') IS DISTINCT FROM 'number'
           OR (f->>'waiting_cost_bp')::numeric <> 0))
    THEN RAISE EXCEPTION 'Invalid coupon point forecast'; END IF;$patch$);
  EXECUTE definition;
END;
$migration$;

-- An unavailable historical comparison is not a model prediction.
ALTER TABLE financing_model.issuance_validation ALTER COLUMN flat_market_mae_bp DROP NOT NULL;
