-- Requires financing migration 0034 (bond investor allocations).
SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));
ALTER TABLE credit.diff ADD COLUMN bond_investment_secondary_used numeric(20,6);
COMMENT ON COLUMN credit.diff.bond_investment_secondary_used IS '债券投资二级买卖净余额，亿元；正数净买入，负数净卖出；与线上一级发行存续额相加为实际已用';
COMMENT ON COLUMN credit.diff.bond_investment_used IS '原台账债券投资真实值，仅保留历史及导入对账证据；运行时已用由一级存续加二级买卖派生';

CREATE FUNCTION credit.bond_primary_usage_as_of(as_of date)
RETURNS TABLE(institution_name text, amount numeric) LANGUAGE sql STABLE AS $$
  SELECT m.institution_name, sum(i.amount)
  FROM financing.bond_investors i JOIN financing.bond b ON b.id=i.bond_id
  JOIN credit.institution_client m ON m.client_id=i.investor_id
  WHERE b.issue_date<=as_of AND b.maturity_date>as_of
    AND (b.settled_at IS NULL OR b.settled_at>as_of)
    AND (b.closed_at IS NULL OR b.closed_at>as_of)
  GROUP BY m.institution_name
$$;
REVOKE ALL ON FUNCTION credit.bond_primary_usage_as_of(date) FROM PUBLIC;

CREATE OR REPLACE FUNCTION credit.append_diff(on_date date, name text, patch jsonb, actor text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE previous jsonb; changes jsonb; cleared text[]; inserted_id bigint; result credit.diff; allowed text[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));
  IF on_date IS NULL OR name IS NULL OR btrim(name)='' OR jsonb_typeof(patch) <> 'object' THEN
    RAISE EXCEPTION 'Invalid credit diff input';
  END IF;
  -- jsonb_populate_record supplies typed NULL fields without allowing audit/identity changes.
  SELECT array_agg(key) INTO allowed FROM jsonb_object_keys(to_jsonb(jsonb_populate_record(NULL::credit.diff,'{}')) - '{id,institution_name,effective_on,created_at,created_by,updated_at,cleared_fields}'::text[]) key;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(patch) key WHERE NOT key=ANY(allowed)) THEN
    RAISE EXCEPTION 'Unknown credit diff field';
  END IF;
  -- Compare typed values so numeric(20,6) rounding cannot create repeated false diffs.
  SELECT jsonb_object_agg(e.key,typed.data->e.key) INTO patch
    FROM jsonb_each(patch) e CROSS JOIN LATERAL
      (SELECT to_jsonb(r) AS data FROM jsonb_populate_record(NULL::credit.diff,patch) r) typed;
  SELECT to_jsonb(s) INTO previous FROM credit.state_as_of(on_date) s WHERE institution_name=name;
  SELECT jsonb_object_agg(key,value) INTO changes FROM jsonb_each(patch)
    WHERE value IS DISTINCT FROM coalesce(previous->key,'null'::jsonb);
  IF changes IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(array_agg(key),'{}') INTO cleared FROM jsonb_each(changes) WHERE value='null'::jsonb;
  INSERT INTO credit.diff(institution_name,effective_on,created_by,cleared_fields,institution_type,confidentiality_status,status,total,effective_date,expiry_date,bank_office,applying_department,handler,detail,bond_preference,notes,bond_investment_limit,bond_investment_detail,yield_certificate_limit,yield_certificate_detail,legal_overdraft_limit,legal_overdraft_detail,margin_income_rights_limit,margin_income_rights_detail,interbank_lending_limit,interbank_lending_detail,other_limit,other_detail,bond_investment_used,legal_overdraft_used,margin_income_rights_used,other_used,bond_investment_secondary_used)
  SELECT name,on_date,actor,cleared,r.institution_type,r.confidentiality_status,r.status,r.total,r.effective_date,r.expiry_date,r.bank_office,r.applying_department,r.handler,r.detail,r.bond_preference,r.notes,r.bond_investment_limit,r.bond_investment_detail,r.yield_certificate_limit,r.yield_certificate_detail,r.legal_overdraft_limit,r.legal_overdraft_detail,r.margin_income_rights_limit,r.margin_income_rights_detail,r.interbank_lending_limit,r.interbank_lending_detail,r.other_limit,r.other_detail,r.bond_investment_used,r.legal_overdraft_used,r.margin_income_rights_used,r.other_used,r.bond_investment_secondary_used FROM jsonb_populate_record(NULL::credit.diff,changes) r
  RETURNING id INTO inserted_id;
  SELECT * INTO result FROM credit.state_as_of(on_date) WHERE institution_name=name;
  IF result.institution_type IS NULL OR result.status IS NULL OR result.confidentiality_status IS NULL THEN
    RAISE EXCEPTION 'Institution type, status and confidentiality are required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT effective_on FROM credit.diff WHERE institution_name=name AND effective_on>=on_date) dates
    CROSS JOIN LATERAL credit.state_as_of(dates.effective_on) s
    WHERE s.institution_name=name AND s.effective_date>s.expiry_date
  ) THEN RAISE EXCEPTION 'Credit expiry precedes effective date'; END IF;
  RETURN inserted_id;
END $$;

-- Freeze every existing observation before appending conversions. Even an unchanged
-- ledger balance can require a different residual when a primary bond matures.
CREATE TEMP TABLE credit_bond_conversion ON COMMIT DROP AS
SELECT d.effective_on AS observation_date,s.*,
  EXISTS(SELECT 1 FROM credit.institution_client m WHERE m.institution_name=s.institution_name) AS linked,
  coalesce(p.amount,0)/100000000 AS primary_used
FROM (SELECT DISTINCT effective_on FROM credit.diff) d
CROSS JOIN LATERAL credit.state_as_of(d.effective_on) s
LEFT JOIN LATERAL (SELECT amount FROM credit.bond_primary_usage_as_of(d.effective_on) p
  WHERE p.institution_name=s.institution_name) p ON true;

DO $$
DECLARE r record; patch jsonb;
BEGIN
  IF EXISTS(SELECT 1 FROM credit_bond_conversion WHERE NOT linked AND coalesce(bond_investment_used,0)<>0) THEN
    RAISE EXCEPTION 'Cannot reconcile bond usage without client associations';
  END IF;
  FOR r IN SELECT * FROM credit_bond_conversion ORDER BY observation_date,institution_name LOOP
    patch:=jsonb_build_object(
      'other_limit',CASE WHEN r.other_limit IS NULL AND r.margin_income_rights_limit IS NULL THEN NULL
        ELSE coalesce(r.other_limit,0)+coalesce(r.margin_income_rights_limit,0) END,
      'other_used',CASE WHEN r.other_used IS NULL AND r.margin_income_rights_used IS NULL THEN NULL
        ELSE coalesce(r.other_used,0)+coalesce(r.margin_income_rights_used,0) END,
      'other_detail',nullif(concat_ws('；',nullif(r.other_detail,''),
        CASE WHEN nullif(r.margin_income_rights_detail,'') IS NOT NULL THEN '两融收益权转让：'||r.margin_income_rights_detail END),''),
      'margin_income_rights_limit',NULL,'margin_income_rights_used',NULL,'margin_income_rights_detail',NULL);
    IF r.linked THEN
      patch:=patch||jsonb_build_object('bond_investment_secondary_used',coalesce(r.bond_investment_used,0)-r.primary_used);
    END IF;
    PERFORM credit.append_diff(r.observation_date,r.institution_name,patch,NULL);
  END LOOP;
END $$;
-- No original diff is updated or deleted; migrated authors remain unknown.
