CREATE SCHEMA IF NOT EXISTS credit;

CREATE TABLE IF NOT EXISTS credit.daily_summary (
  report_date date PRIMARY KEY,
  source_file_name text NOT NULL CHECK (btrim(source_file_name) <> ''),
  source_sheet text NOT NULL DEFAULT '授信一览表',
  institution_count integer NOT NULL CHECK (institution_count >= 0),
  approved_count integer NOT NULL CHECK (approved_count >= 0),
  total_limit numeric(20, 6) NOT NULL,
  total_used numeric(20, 6) NOT NULL,
  total_available numeric(20, 6) NOT NULL,
  weekly_approved_count integer NOT NULL CHECK (weekly_approved_count >= 0),
  weekly_total_limit numeric(20, 6) NOT NULL,
  weekly_total_used numeric(20, 6) NOT NULL,
  weekly_total_available numeric(20, 6) NOT NULL,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings) = 'array'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit.institution_daily (
  report_date date NOT NULL REFERENCES credit.daily_summary(report_date) ON DELETE CASCADE,
  institution_name text NOT NULL CHECK (btrim(institution_name) <> ''),
  source_row integer NOT NULL CHECK (source_row >= 4),
  institution_type text NOT NULL CHECK (btrim(institution_type) <> ''),
  confidentiality_status text NOT NULL CHECK (
    confidentiality_status IN ('signed', 'not_signed', 'unknown')
  ),
  status text NOT NULL CHECK (status IN ('approved', 'applying', 'revoked', 'unknown')),
  included_in_weekly_report boolean NOT NULL,
  total_limit numeric(20, 6),
  total_used numeric(20, 6),
  total_remaining numeric(20, 6),
  effective_date date,
  expiry_date date,
  bank_office text,
  applying_department text,
  handler text,
  notes text,
  bond_preference text,
  usage_details text,
  PRIMARY KEY (report_date, institution_name)
);

CREATE INDEX IF NOT EXISTS credit_institution_daily_status_idx
  ON credit.institution_daily (report_date DESC, status, institution_type);
CREATE INDEX IF NOT EXISTS credit_institution_daily_expiry_idx
  ON credit.institution_daily (expiry_date)
  WHERE status = 'approved';

CREATE TABLE IF NOT EXISTS credit.item_daily (
  report_date date NOT NULL,
  institution_name text NOT NULL,
  item_type text NOT NULL CHECK (item_type IN (
    'bond_investment',
    'yield_certificate',
    'legal_overdraft',
    'margin_income_rights',
    'interbank_lending',
    'other'
  )),
  limit_amount numeric(20, 6),
  used_amount numeric(20, 6),
  remaining_amount numeric(20, 6),
  details text,
  PRIMARY KEY (report_date, institution_name, item_type),
  FOREIGN KEY (report_date, institution_name)
    REFERENCES credit.institution_daily(report_date, institution_name)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS credit_item_daily_type_idx
  ON credit.item_daily (report_date DESC, item_type);

COMMENT ON SCHEMA credit IS '授信一览表逐日记录与周度比较';
COMMENT ON TABLE credit.daily_summary IS '每个报表日唯一的授信汇总；同日报表重导时直接替换';
COMMENT ON TABLE credit.institution_daily IS '授信一览表按报表日和机构保存的主体级记录';
COMMENT ON TABLE credit.item_daily IS '授信主体在债券投资、收益凭证、法透、两融收益权转让、同业拆借及其它分项上的逐日记录';
