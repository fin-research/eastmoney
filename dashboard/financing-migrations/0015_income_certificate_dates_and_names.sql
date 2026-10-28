BEGIN;

SET LOCAL search_path TO financing, public;

ALTER TABLE ONLY income_certificate
	ADD COLUMN IF NOT EXISTS subscription_date date,
	ADD COLUMN IF NOT EXISTS redemption_date date;

CREATE OR REPLACE FUNCTION previous_working_day(value date)
RETURNS date
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
	SELECT value - CASE EXTRACT(ISODOW FROM value)::integer
		WHEN 1 THEN 3
		WHEN 7 THEN 2
		ELSE 1
	END;
$$;

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
		'^(东方财富证券股份有限公司|东方财富证券|西藏同信证券股份有限公司|西藏同信证券)',
		''
	);
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

CREATE OR REPLACE FUNCTION normalize_income_certificate_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	NEW.name := financing.normalize_income_certificate_name(NEW.name);
	IF NEW.maturity_date IS NULL AND NEW.redemption_date IS NOT NULL THEN
		NEW.maturity_date := financing.previous_working_day(NEW.redemption_date);
	END IF;
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS normalize_income_certificate_fields ON income_certificate;
CREATE TRIGGER normalize_income_certificate_fields
	BEFORE INSERT OR UPDATE OF name, maturity_date, redemption_date ON income_certificate
	FOR EACH ROW EXECUTE FUNCTION normalize_income_certificate_fields();

-- 2026-08-31 source workbook contains one 吉祥239号 record. A previous import
-- created id 9854 when its blank 到期日 failed to match the already-correct
-- canonical row id 3436 (兑付日 2026-04-14 -> 到期日 2026-04-13).
DELETE FROM ONLY income_certificate duplicate
WHERE duplicate.id = 9854
	AND duplicate.name = '吉祥'
	AND duplicate.issue_date = DATE '2025-10-15'
	AND duplicate.maturity_date IS NULL
	AND duplicate.amount = 70000000
	AND NOT EXISTS (SELECT 1 FROM cashflow WHERE debt_id = duplicate.id)
	AND EXISTS (
		SELECT 1 FROM ONLY income_certificate canonical
		WHERE canonical.id = 3436
			AND canonical.name = duplicate.name
			AND canonical.subtype IS NOT DISTINCT FROM duplicate.subtype
			AND canonical.counterparty IS NOT DISTINCT FROM duplicate.counterparty
			AND canonical.amount = duplicate.amount
			AND canonical.annual_rate IS NOT DISTINCT FROM duplicate.annual_rate
			AND canonical.issue_date = duplicate.issue_date
			AND canonical.maturity_date = financing.previous_working_day(DATE '2026-04-14')
	);

COMMENT ON COLUMN income_certificate.subscription_date IS '收益凭证认购日；周报发行动态优先使用该日期。';
COMMENT ON COLUMN income_certificate.redemption_date IS '收益凭证兑付日；到期日缺失时默认取其前一工作日（周一至周五口径）。';

COMMIT;
