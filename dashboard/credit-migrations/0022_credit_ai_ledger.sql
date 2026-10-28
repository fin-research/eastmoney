-- AI reads a separate, explicit projection. Never join institution or client names.
CREATE FUNCTION credit.ai_ledger_as_of(as_of date)
RETURNS TABLE (
  institution_id bigint, status text, effective_date date, expiry_date date,
  total_limit numeric, total_used numeric, total_available numeric, utilization_pct numeric,
  bond_investment_limit numeric, bond_primary_used numeric, bond_secondary_used numeric, bond_investment_used numeric,
  yield_certificate_limit numeric, yield_certificate_used numeric,
  interbank_lending_limit numeric, interbank_lending_used numeric,
  legal_overdraft_limit numeric, legal_overdraft_used numeric, other_used numeric, verified boolean
) LANGUAGE sql STABLE AS $$
  WITH latest AS (
    SELECT DISTINCT ON(e.institution_id,e.field_id)
      e.institution_id,e.field_id,e.v_num,e.v_date,CASE WHEN e.field_id='status' THEN e.v_text END AS status
    FROM credit.entry e
    WHERE e.report_date<=as_of AND e.field_id IN (
      'status','effective_date','expiry_date','total','bond_investment_limit','bond_investment_secondary_used',
      'yield_certificate_limit','interbank_lending_limit','legal_overdraft_limit','legal_overdraft_used','other_used')
    ORDER BY e.institution_id,e.field_id,e.report_date DESC
  ), states AS (
    SELECT e.institution_id,
      max(e.status) AS status,
      max(e.v_date) FILTER(WHERE e.field_id='effective_date') AS effective_date,
      max(e.v_date) FILTER(WHERE e.field_id='expiry_date') AS expiry_date,
      max(e.v_num) FILTER(WHERE e.field_id='total') AS total_limit,
      max(e.v_num) FILTER(WHERE e.field_id='bond_investment_limit') AS bond_investment_limit,
      max(e.v_num) FILTER(WHERE e.field_id='bond_investment_secondary_used') AS bond_secondary_used,
      max(e.v_num) FILTER(WHERE e.field_id='yield_certificate_limit') AS yield_certificate_limit,
      max(e.v_num) FILTER(WHERE e.field_id='interbank_lending_limit') AS interbank_lending_limit,
      max(e.v_num) FILTER(WHERE e.field_id='legal_overdraft_limit') AS legal_overdraft_limit,
      max(e.v_num) FILTER(WHERE e.field_id='legal_overdraft_used') AS legal_overdraft_used,
      max(e.v_num) FILTER(WHERE e.field_id='other_used') AS other_used
    FROM latest e GROUP BY e.institution_id
  ), links AS (
    SELECT DISTINCT m.institution_id FROM credit.institution_client m
  ), financing_usage AS (
    SELECT m.institution_id,
      sum(u.amount) FILTER(WHERE u.debt_type='收益凭证')/100000000 AS yield_used,
      sum(u.amount) FILTER(WHERE u.debt_type='同业拆借')/100000000 AS lending_used
    FROM financing.credit_usage_as_of(as_of) u JOIN credit.institution_client m ON m.client_id=u.client_id
    GROUP BY m.institution_id
  ), bonds AS (
    SELECT m.institution_id,sum(i.amount)/100000000 AS amount
    FROM financing.bond_investors i JOIN financing.bond b ON b.id=i.bond_id
    JOIN credit.institution_client m ON m.client_id=i.investor_id
    WHERE b.issue_date<=as_of AND b.maturity_date>as_of
      AND (b.settled_at IS NULL OR b.settled_at>as_of) AND (b.closed_at IS NULL OR b.closed_at>as_of)
    GROUP BY m.institution_id
  ), amounts AS (
    SELECT s.*,l.institution_id IS NOT NULL AS linked,
      CASE WHEN l.institution_id IS NOT NULL THEN coalesce(b.amount,0) END AS primary_used,
      CASE WHEN l.institution_id IS NOT NULL THEN round(coalesce(b.amount,0)+coalesce(s.bond_secondary_used,0),6) END AS bond_used,
      CASE WHEN l.institution_id IS NOT NULL THEN round(coalesce(f.yield_used,0),6) END AS yield_used,
      CASE WHEN l.institution_id IS NOT NULL THEN round(coalesce(f.lending_used,0),6) END AS lending_used
    FROM states s LEFT JOIN links l USING(institution_id)
    LEFT JOIN financing_usage f USING(institution_id) LEFT JOIN bonds b USING(institution_id)
  ), totals AS (
    SELECT a.*,CASE WHEN a.linked THEN round(a.bond_used+a.yield_used+a.lending_used+
      coalesce(a.legal_overdraft_used,0)+coalesce(a.other_used,0),6) END AS used
    FROM amounts a
  )
  SELECT t.institution_id,CASE WHEN t.expiry_date>=as_of THEN 'approved'
      WHEN t.expiry_date IS NOT NULL THEN 'applying' ELSE coalesce(t.status,'applying') END,
    t.effective_date,t.expiry_date,t.total_limit,t.used,round(t.total_limit-t.used,6),t.used/nullif(t.total_limit,0)*100,
    t.bond_investment_limit,t.primary_used,coalesce(t.bond_secondary_used,0),t.bond_used,
    t.yield_certificate_limit,t.yield_used,t.interbank_lending_limit,t.lending_used,
    t.legal_overdraft_limit,t.legal_overdraft_used,t.other_used,
    coalesce((SELECT bool_or(e.verified) FROM credit.entry e WHERE e.institution_id=t.institution_id AND e.report_date=as_of),false)
  FROM totals t WHERE t.expiry_date IS DISTINCT FROM DATE '1970-01-01'
    AND (t.expiry_date IS NOT NULL OR coalesce(t.status,'applying')<>'revoked')
$$;

CREATE VIEW credit.ai_ledger AS
  SELECT * FROM credit.ai_ledger_as_of((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date);
REVOKE ALL ON credit.ai_ledger FROM PUBLIC;
REVOKE ALL ON FUNCTION credit.ai_ledger_as_of(date) FROM PUBLIC;
-- Preserve the existing report reader grants without broadening public access.
DO $$ DECLARE g record; BEGIN
  FOR g IN SELECT DISTINCT a.grantee FROM pg_proc p,
    LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='credit.entry_as_of(date,text[])'::regprocedure AND a.grantee<>0 AND a.privilege_type='EXECUTE'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION credit.ai_ledger_as_of(date) TO %I',pg_get_userbyid(g.grantee));
    EXECUTE format('GRANT SELECT ON credit.ai_ledger TO %I',pg_get_userbyid(g.grantee));
  END LOOP;
END $$;
