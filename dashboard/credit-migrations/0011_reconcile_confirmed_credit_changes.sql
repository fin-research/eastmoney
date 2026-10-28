-- User-confirmed reconciliation against the 2026-09-11 ledger.
-- Renewal facts belong to 08-31; Kunlun corrects stale baseline fields.
-- Postal's +3.2 secondary balance is explicitly effective on 09-11.
-- No human author is invented for this maintenance migration.
SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));
SET LOCAL credit.correct_history='on';

DO $$
DECLARE name text; current_state credit.diff;
BEGIN
  FOREACH name IN ARRAY ARRAY['上海农商行（金市）','上海农商行（资管）'] LOOP
    SELECT * INTO current_state FROM credit.state_as_of('2026-09-11') s WHERE s.institution_name=name;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF current_state.status NOT IN ('applying','approved')
      OR current_state.expiry_date NOT IN (DATE '2026-08-31',DATE '2027-08-31') THEN
      RAISE EXCEPTION 'Unexpected renewal state for %; reconciliation requires review',name;
    END IF;
    -- The old 09-04 import captured Excel's expired flag, not a new application.
    UPDATE credit.diff d SET status=NULL
      WHERE d.institution_name=name AND effective_on='2026-09-04'
        AND status='applying' AND created_by IS NULL;
    PERFORM credit.append_diff('2026-08-31',name,
      '{"status":"approved","effective_date":"2026-08-31","expiry_date":"2027-08-31"}',NULL);
  END LOOP;

  SELECT * INTO current_state FROM credit.state_as_of('2026-09-11') s WHERE s.institution_name='昆仑银行';
  IF FOUND THEN
    IF current_state.total IS DISTINCT FROM 8::numeric
      OR current_state.yield_certificate_limit NOT IN (0,5)
      OR current_state.interbank_lending_limit NOT IN (0,5) THEN
      RAISE EXCEPTION 'Unexpected Kunlun limits; reconciliation requires review';
    END IF;
    UPDATE credit.diff SET yield_certificate_limit=0,interbank_lending_limit=0,
      detail='8.11日授信扩额至8亿元，授信品种为债券投资，有效期至2027年7月底。'
      WHERE institution_name='昆仑银行' AND effective_on='2026-08-21'
        AND yield_certificate_limit=5 AND interbank_lending_limit=5
        AND detail='固定收益凭证、拆借、债券投资' AND created_by IS NULL;
    SELECT * INTO current_state FROM credit.state_as_of('2026-09-11') s WHERE s.institution_name='昆仑银行';
    IF current_state.yield_certificate_limit IS DISTINCT FROM 0::numeric
      OR current_state.interbank_lending_limit IS DISTINCT FROM 0::numeric
      OR current_state.detail IS DISTINCT FROM '8.11日授信扩额至8亿元，授信品种为债券投资，有效期至2027年7月底。' THEN
      RAISE EXCEPTION 'Kunlun baseline correction incomplete';
    END IF;
  END IF;

  SELECT * INTO current_state FROM credit.state_as_of('2026-09-11') s WHERE s.institution_name='邮储银行';
  IF FOUND THEN
    IF current_state.bond_investment_secondary_used IS DISTINCT FROM 7.3::numeric
      AND current_state.bond_investment_secondary_used IS DISTINCT FROM 10.5::numeric THEN
      RAISE EXCEPTION 'Unexpected Postal secondary balance; reconciliation requires review';
    END IF;
    PERFORM credit.append_diff('2026-09-11','邮储银行','{"bond_investment_secondary_used":10.5}',NULL);
  END IF;
END $$;
SET LOCAL credit.correct_history='off';
