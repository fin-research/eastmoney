-- Historical entry corrections remain explicit and transaction-local. Normal
-- application writes cannot delete credit facts.
CREATE OR REPLACE FUNCTION credit.guard_entry_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF current_setting('credit.correct_history',true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'Credit entries cannot be deleted';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));
    RETURN OLD;
  END IF;
  IF (NEW.report_date,NEW.field_id,NEW.institution_id,NEW.created_at,NEW.created_by)
    IS DISTINCT FROM (OLD.report_date,OLD.field_id,OLD.institution_id,OLD.created_at,OLD.created_by) THEN
    RAISE EXCEPTION 'Credit entry identity and creation fields are immutable';
  END IF;
  IF current_setting('credit.entry_write',true) IS DISTINCT FROM 'on'
    AND current_setting('credit.correct_history',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Credit entries are append only';
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;

CREATE FUNCTION credit.validate_corrected_entry_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT OLD.report_date AS report_date
      UNION SELECT report_date FROM credit.entry
        WHERE institution_id=OLD.institution_id AND report_date>OLD.report_date
    ) dates
    CROSS JOIN LATERAL (
      SELECT max(v_date) FILTER(WHERE field_id='effective_date') AS effective_date,
        max(v_date) FILTER(WHERE field_id='expiry_date') AS expiry_date
      FROM (SELECT DISTINCT ON(field_id) field_id,v_date FROM credit.entry
        WHERE institution_id=OLD.institution_id AND report_date<=dates.report_date
          AND field_id IN ('effective_date','expiry_date')
        ORDER BY field_id,report_date DESC) latest
    ) state
    WHERE state.expiry_date IS NOT NULL AND state.expiry_date<>DATE '1970-01-01'
      AND state.effective_date>state.expiry_date
  ) THEN
    RAISE EXCEPTION 'Credit entry historical correction creates an invalid term';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION credit.validate_corrected_entry_history() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER validate_corrected_entry_history
  AFTER DELETE ON credit.entry DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION credit.validate_corrected_entry_history();

-- These two rows record an existing line's October 2026 renewal as new.
-- Verify the exact source state before changing only their event classification.
SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));
SET LOCAL credit.correct_history='on';
DO $$
DECLARE iid bigint; baseline credit.entry_state;
BEGIN
  SELECT id INTO iid FROM credit.institution WHERE name='中山农商行';
  IF iid IS NULL THEN RETURN; END IF;
  SELECT * INTO baseline FROM credit.entry_as_of('2026-08-21',ARRAY['中山农商行']);
  IF baseline.total IS DISTINCT FROM 9::numeric
    OR baseline.effective_date IS DISTINCT FROM DATE '2025-10-21'
    OR baseline.expiry_date IS DISTINCT FROM DATE '2026-10-21'
    OR baseline.status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'Unexpected Zhongshan Rural Commercial Bank baseline; renewal correction requires review';
  END IF;
  IF (SELECT count(*) FROM credit.entry WHERE institution_id=iid AND report_date='2026-10-30')<>2
    OR (SELECT count(*) FROM credit.entry WHERE institution_id=iid AND report_date='2026-10-30'
      AND field_id IN ('effective_date','expiry_date') AND event='new' AND (
        field_id='effective_date' AND v_date='2026-10-21'
        OR field_id='expiry_date' AND v_date='2027-10-21'))<>2 THEN
    RAISE EXCEPTION 'Unexpected Zhongshan Rural Commercial Bank renewal entries; correction requires review';
  END IF;
  UPDATE credit.entry SET event='renewal'
    WHERE institution_id=iid AND report_date='2026-10-30' AND event='new';
END $$;
SET LOCAL credit.correct_history='off';
