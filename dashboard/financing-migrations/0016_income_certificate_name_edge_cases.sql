BEGIN;

SET LOCAL search_path TO financing, public;

CREATE OR REPLACE FUNCTION normalize_income_certificate_name(value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
	candidate text;
	serial_match text[];
BEGIN
	candidate := regexp_replace(BTRIM(value), '[[:space:]]+', '', 'g');
	candidate := regexp_replace(
		candidate,
		'^(东方财富证券股份有限公司|东方财富证券|西藏东方财富证券股份有限公司|西藏东方财富证券|西藏同信证券股份有限公司|西藏同信证券)',
		''
	);
	candidate := regexp_replace(candidate, '(（[^）]*）|\([^)]*\))$', '');
	serial_match := regexp_match(candidate, '([0-9]+)(号)?(收益凭证)?$');
	IF candidate LIKE '吉祥%' AND serial_match IS NOT NULL THEN
		RETURN '吉祥' || serial_match[1] || '号收益凭证';
	END IF;
	IF candidate LIKE '财气东来%' AND serial_match IS NOT NULL THEN
		RETURN '财气东来' || serial_match[1] || '号收益凭证';
	END IF;
	RETURN candidate;
END;
$$;

UPDATE ONLY income_certificate
SET name = financing.normalize_income_certificate_name(name)
WHERE name <> financing.normalize_income_certificate_name(name);

COMMIT;
