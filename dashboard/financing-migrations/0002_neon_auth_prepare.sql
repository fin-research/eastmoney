BEGIN;

DO $$
BEGIN
	IF to_regclass('neon_auth.user') IS NULL THEN
		RAISE EXCEPTION 'Managed Better Auth is not provisioned for this Neon branch';
	END IF;
END;
$$;

ALTER TABLE financing.people
	ADD COLUMN neon_auth_user_id uuid,
	ADD COLUMN avatar_data_url text;

UPDATE financing.people person
SET avatar_data_url = account.avatar_data_url
FROM financing.auth_users account
WHERE account.person_id = person.id
	AND account.avatar_data_url IS NOT NULL;

UPDATE financing.people person
SET neon_auth_user_id = auth_user.id
FROM neon_auth."user" auth_user
WHERE person.email IS NOT NULL
	AND lower(person.email) = lower(auth_user.email);

ALTER TABLE financing.people
	ADD CONSTRAINT people_neon_auth_user_id_unique UNIQUE (neon_auth_user_id),
	ADD CONSTRAINT people_neon_auth_user_id_fkey
		FOREIGN KEY (neon_auth_user_id) REFERENCES neon_auth."user"(id) ON DELETE SET NULL;

ALTER TABLE financing.audit_logs
	ADD COLUMN actor_person_id text REFERENCES financing.people(id) ON DELETE SET NULL;

UPDATE financing.audit_logs audit
SET actor_person_id = account.person_id
FROM financing.auth_users account
WHERE account.id = audit.actor_user_id;

CREATE INDEX audit_logs_actor_person_idx
	ON financing.audit_logs(actor_person_id, created_at DESC);

COMMIT;
