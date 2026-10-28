-- Run only after the new Worker is verified at 100% traffic. The migration runner
-- requires an explicit --finalize flag. The shared lock drains old writers.
SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import',0));
LOCK TABLE credit.diff IN ACCESS EXCLUSIVE MODE;
-- Verify the final old-worker facts under the writer lock.
SELECT credit.verify_entry_migration();
DROP FUNCTION credit.verify_entry_migration();
DROP TRIGGER a_mirror_legacy_diff ON credit.diff;
DROP FUNCTION credit.mirror_legacy_diff();
DROP FUNCTION credit.append_diff(date,text,jsonb,text);
DROP FUNCTION credit.append_diff(date,text,jsonb,text,text);
DROP FUNCTION credit.state_as_of(date);
DROP FUNCTION credit.state_as_of(date,text[]);
DROP TRIGGER link_institution_clients ON credit.diff;
DROP TRIGGER guard_institution_rename ON credit.institution;
DROP FUNCTION credit.guard_institution_rename();
ALTER TABLE credit.diff RENAME TO legacy_diff;
COMMENT ON TABLE credit.legacy_diff IS '授信长表迁移前历史证据；运行时不得读写';
CREATE OR REPLACE FUNCTION credit.guard_diff_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Legacy credit history is read only'; END $$;
CREATE TRIGGER freeze_legacy_insert BEFORE INSERT ON credit.legacy_diff FOR EACH ROW EXECUTE FUNCTION credit.guard_diff_history();
REVOKE INSERT,UPDATE,DELETE ON credit.legacy_diff FROM PUBLIC;
