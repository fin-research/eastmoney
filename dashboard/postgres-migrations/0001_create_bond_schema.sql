CREATE SCHEMA IF NOT EXISTS bond;

CREATE TABLE IF NOT EXISTS bond.ledger_upload (
  id uuid PRIMARY KEY,
  workflow_instance_id text NOT NULL UNIQUE,
  r2_key text NOT NULL UNIQUE,
  r2_etag text,
  original_name text NOT NULL,
  file_size bigint NOT NULL CHECK (file_size > 0),
  expected_date date,
  report_date date,
  status text NOT NULL CHECK (
    status IN ('processing', 'succeeded', 'failed', 'superseded', 'deleted')
  ),
  error_message text,
  statistics_count integer NOT NULL DEFAULT 0 CHECK (statistics_count >= 0),
  position_count integer NOT NULL DEFAULT 0 CHECK (position_count >= 0),
  transaction_count integer NOT NULL DEFAULT 0 CHECK (transaction_count >= 0),
  uploaded_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ledger_upload_one_succeeded_per_date
  ON bond.ledger_upload (report_date)
  WHERE status = 'succeeded';

CREATE INDEX IF NOT EXISTS ledger_upload_status_date_idx
  ON bond.ledger_upload (status, report_date DESC, completed_at DESC);

CREATE TABLE IF NOT EXISTS bond.daily_statistics (
  stat_date date PRIMARY KEY,
  principal numeric(30, 10) NOT NULL,
  time_weighted_principal numeric(30, 10) NOT NULL,
  market_value numeric(30, 10) NOT NULL,
  leverage numeric(20, 10) NOT NULL,
  modified_duration numeric(20, 10) NOT NULL,
  daily_revenue numeric(30, 10) NOT NULL,
  cumulative_profit numeric(30, 10) NOT NULL,
  ytd_annualized_return numeric(20, 12),
  ytd_ex_tax_annualized_return numeric(20, 12),
  source_report_date date NOT NULL,
  source_upload_id uuid REFERENCES bond.ledger_upload(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS daily_statistics_source_report_date_idx
  ON bond.daily_statistics (source_report_date DESC);

CREATE TABLE IF NOT EXISTS bond.daily_position (
  report_date date NOT NULL,
  row_number integer NOT NULL CHECK (row_number > 0),
  team text NOT NULL DEFAULT '',
  investment_manager text NOT NULL DEFAULT '',
  account text NOT NULL DEFAULT '',
  code text NOT NULL DEFAULT '',
  market text NOT NULL DEFAULT '',
  name text NOT NULL,
  category text NOT NULL,
  yield_change_bp numeric(20, 10),
  remaining_years numeric(20, 10),
  interest_start_date date,
  maturity_date date,
  current_quantity numeric(30, 10) NOT NULL,
  previous_quantity numeric(30, 10) NOT NULL,
  buy_quantity numeric(30, 10) NOT NULL,
  sell_quantity numeric(30, 10) NOT NULL,
  maturity_quantity numeric(30, 10) NOT NULL,
  coupon_rate numeric(20, 10),
  valuation_yield numeric(20, 10),
  report_yield numeric(20, 10),
  full_price numeric(20, 10),
  dv01 numeric(30, 10) NOT NULL,
  market_value numeric(30, 10) NOT NULL,
  coupon_income numeric(30, 10) NOT NULL,
  tax_exempt_income numeric(30, 10) NOT NULL,
  realized_profit numeric(30, 10),
  daily_profit numeric(30, 10) NOT NULL,
  ytd_profit numeric(30, 10) NOT NULL,
  full_price_cost numeric(20, 10) NOT NULL,
  source_upload_id uuid NOT NULL REFERENCES bond.ledger_upload(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_date, row_number)
);

CREATE INDEX IF NOT EXISTS daily_position_report_code_idx
  ON bond.daily_position (report_date DESC, code);

CREATE INDEX IF NOT EXISTS daily_position_report_category_idx
  ON bond.daily_position (report_date DESC, category);

CREATE TABLE IF NOT EXISTS bond.transaction_record (
  report_date date NOT NULL,
  position_row_number integer NOT NULL,
  side text NOT NULL CHECK (side IN ('买入', '卖出', '到期')),
  code text NOT NULL DEFAULT '',
  name text NOT NULL,
  category text NOT NULL,
  quantity numeric(30, 10) NOT NULL CHECK (quantity > 0),
  face_amount numeric(30, 10) NOT NULL CHECK (face_amount > 0),
  realized_profit numeric(30, 10),
  source_upload_id uuid NOT NULL REFERENCES bond.ledger_upload(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_date, position_row_number, side),
  FOREIGN KEY (report_date, position_row_number)
    REFERENCES bond.daily_position(report_date, row_number)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS transaction_record_report_date_idx
  ON bond.transaction_record (report_date DESC, side);

COMMENT ON SCHEMA bond IS '二级资金池周报及 Excel 台账数据';
COMMENT ON TABLE bond.daily_statistics IS 'Excel Sheet1 二级池累计收益的逐日统计数据';
COMMENT ON TABLE bond.daily_position IS 'Excel Sheet2 当日交易户数据的每日持仓明细';
COMMENT ON TABLE bond.transaction_record IS '由每日持仓明细中的买量、卖量和到期量派生的成交记录';
COMMENT ON TABLE bond.ledger_upload IS 'R2 原始 Excel 与 Cloudflare Workflow 导入状态及审计信息';
