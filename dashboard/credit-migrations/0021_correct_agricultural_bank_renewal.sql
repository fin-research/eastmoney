-- Existing 120亿元 line renewed in August; the institution was not newly added.
SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));
SET LOCAL credit.correct_history='on';

DO $$
DECLARE iid bigint; baseline credit.entry_state;
BEGIN
  SELECT id INTO iid FROM credit.institution WHERE name='农业银行&农银理财';
  IF iid IS NULL THEN RETURN; END IF;
  SELECT * INTO baseline FROM credit.entry_as_of('2026-08-21',ARRAY['农业银行&农银理财']);
  IF baseline.total IS DISTINCT FROM 120::numeric
    OR baseline.status IS DISTINCT FROM 'applying'
    OR baseline.effective_date IS DISTINCT FROM DATE '2025-07-31'
    OR baseline.expiry_date IS DISTINCT FROM DATE '2026-07-23' THEN
    RAISE EXCEPTION 'Unexpected Agricultural Bank baseline; renewal correction requires review';
  END IF;
  IF (SELECT count(*) FROM credit.entry WHERE institution_id=iid AND report_date='2026-08-28')<>3
    OR (SELECT count(*) FROM credit.entry WHERE institution_id=iid AND report_date='2026-08-28'
      AND event IN ('new','renewal') AND (
        field_id='status' AND v_text='approved'
        OR field_id='effective_date' AND v_date='2026-08-25'
        OR field_id='expiry_date' AND v_date='2027-08-25'))<>3 THEN
    RAISE EXCEPTION 'Unexpected Agricultural Bank renewal entries; correction requires review';
  END IF;
  UPDATE credit.entry SET event='renewal'
    WHERE institution_id=iid AND report_date='2026-08-28' AND event='new';
END $$;
SET LOCAL credit.correct_history='off';
