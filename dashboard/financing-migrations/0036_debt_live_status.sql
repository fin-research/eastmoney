BEGIN;

CREATE FUNCTION financing.debt_status_as_of(
  issue_date date, maturity_date date, activated_at date, settled_at date, closed_at date, as_of date
) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN closed_at <= as_of THEN 'closed'
    WHEN settled_at <= as_of OR maturity_date <= as_of THEN 'matured'
    WHEN COALESCE(activated_at, issue_date) IS NULL
      OR COALESCE(activated_at, issue_date) > as_of OR issue_date > as_of THEN 'planned'
    ELSE 'active'
  END
$$;
REVOKE ALL ON FUNCTION financing.debt_status_as_of(date,date,date,date,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION financing.debt_status_as_of(date,date,date,date,date,date) TO authenticated;

CREATE OR REPLACE VIEW financing.debt_overview AS
SELECT d.id, d.debt_type, d.subtype, d.name, d.counterparty, d.amount,
  d.interest_payable, d.total_amount, d.annual_rate, d.issue_date, d.maturity_date,
  d.term_days, d.activated_at, d.settled_at, d.closed_at,
  financing.debt_status_as_of(d.issue_date,d.maturity_date,d.activated_at,d.settled_at,d.closed_at,
    (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date) AS status,
  d.created_at, d.updated_at,
  COALESCE(NULLIF(d.subtype, ''), d.debt_type) AS reporting_type,
  d.client_id
FROM financing.debt d;

COMMIT;
