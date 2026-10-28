BEGIN;

SET LOCAL search_path TO financing, public;

CREATE OR REPLACE FUNCTION normalize_refinancing_name()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	NEW.name := '转融资';
	RETURN NEW;
END;
$$;

UPDATE ONLY refinancing
SET name = '转融资'
WHERE name IS DISTINCT FROM '转融资';

DROP TRIGGER IF EXISTS normalize_refinancing_name ON refinancing;
CREATE TRIGGER normalize_refinancing_name
	BEFORE INSERT OR UPDATE OF name ON refinancing
	FOR EACH ROW EXECUTE FUNCTION normalize_refinancing_name();

ALTER TABLE ONLY refinancing
	DROP CONSTRAINT IF EXISTS refinancing_name_canonical;
ALTER TABLE ONLY refinancing
	ADD CONSTRAINT refinancing_name_canonical CHECK (name = '转融资');

COMMENT ON COLUMN refinancing.name IS '转融资负债统一展示简称，固定为“转融资”。';

COMMIT;
