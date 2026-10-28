BEGIN;

DROP INDEX IF EXISTS financing.audit_logs_actor_idx;
ALTER TABLE financing.audit_logs DROP COLUMN actor_user_id;

DROP TABLE financing.auth_sessions;
DROP TABLE financing.auth_users;

COMMIT;
