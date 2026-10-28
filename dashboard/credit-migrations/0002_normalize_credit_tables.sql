DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = 'credit' AND type.typname = 'credit_status'
  ) THEN
    CREATE TYPE credit.credit_status AS ENUM ('approved', 'applying', 'revoked');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = 'credit' AND type.typname = 'confidentiality_status'
  ) THEN
    CREATE TYPE credit.confidentiality_status AS ENUM ('signed', 'not_signed', 'unknown');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = 'credit' AND type.typname = 'item_type'
  ) THEN
    CREATE TYPE credit.item_type AS ENUM (
      'bond_investment',
      'yield_certificate',
      'legal_overdraft',
      'margin_income_rights',
      'interbank_lending',
      'other'
    );
  END IF;
END
$$;

ALTER TABLE credit.institution_daily RENAME TO institution;
ALTER TABLE credit.item_daily RENAME TO item;

ALTER TABLE credit.institution
  DROP CONSTRAINT institution_daily_report_date_fkey,
  DROP CONSTRAINT institution_daily_status_check,
  DROP CONSTRAINT institution_daily_confidentiality_status_check;
ALTER TABLE credit.item
  DROP CONSTRAINT item_daily_item_type_check;

DROP INDEX credit.credit_institution_daily_expiry_idx;

UPDATE credit.institution SET status = 'revoked' WHERE status = 'unknown';

ALTER TABLE credit.institution
  ALTER COLUMN status TYPE credit.credit_status
    USING status::credit.credit_status,
  ALTER COLUMN confidentiality_status TYPE credit.confidentiality_status
    USING confidentiality_status::credit.confidentiality_status,
  DROP COLUMN total_remaining,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE credit.item
  ALTER COLUMN item_type TYPE credit.item_type
    USING item_type::credit.item_type,
  DROP COLUMN remaining_amount,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE credit.institution RENAME CONSTRAINT institution_daily_pkey TO institution_pkey;
ALTER TABLE credit.item RENAME CONSTRAINT item_daily_pkey TO item_pkey;
ALTER TABLE credit.item
  RENAME CONSTRAINT item_daily_report_date_institution_name_fkey TO item_institution_fkey;

ALTER INDEX credit.credit_institution_daily_status_idx
  RENAME TO credit_institution_status_idx;
ALTER INDEX credit.credit_item_daily_type_idx
  RENAME TO credit_item_type_idx;

CREATE INDEX credit_institution_expiry_idx
  ON credit.institution (expiry_date)
  WHERE status = 'approved'::credit.credit_status;

DROP TABLE credit.daily_summary;

COMMENT ON TABLE credit.institution IS '按报表日和机构保存的授信主体记录';
COMMENT ON TABLE credit.item IS '授信主体的标准化分项额度和已使用金额';
