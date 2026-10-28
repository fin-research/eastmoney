-- Qualification is bound to the immutable model identity, including maintenance publication.
CREATE TABLE financing_model.model_eligibility (
  model_version text PRIMARY KEY CHECK (model_version ~ '^[a-f0-9]{20}$'),
  status text NOT NULL CHECK (status IN ('active','suspended')),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO financing_model.model_eligibility(model_version,status,reason)
VALUES ('61492e3527e1ae367475','suspended','data_quality');

DO $migration$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('financing_model.publish_online_result(jsonb,text)'::regprocedure) INTO definition;
  IF strpos(definition, E'BEGIN\n')=0 THEN
    RAISE EXCEPTION 'Unexpected publication function body';
  END IF;
  definition := regexp_replace(definition, E'BEGIN\n', $patch$BEGIN
  PERFORM 1 FROM financing_model.model_eligibility
    WHERE model_version=payload #>> '{online_run,model_version}' AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Model is not active: quality review required'; END IF;
$patch$);
  EXECUTE definition;
END;
$migration$;
