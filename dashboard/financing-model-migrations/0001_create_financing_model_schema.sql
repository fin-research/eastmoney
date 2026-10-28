CREATE SCHEMA IF NOT EXISTS financing_model;

CREATE TABLE IF NOT EXISTS financing_model.model_run (
  id uuid PRIMARY KEY,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  model_name text NOT NULL,
  generated_at timestamptz NOT NULL,
  as_of_date date NOT NULL,
  market_data_date date NOT NULL CHECK (market_data_date <= as_of_date),
  issue_size_billion_yuan numeric(20, 6) NOT NULL CHECK (issue_size_billion_yuan > 0),
  tenor_years numeric(10, 4) NOT NULL CHECK (tenor_years > 0),
  rating text NOT NULL,
  bond_type text NOT NULL,
  predicted_deviation_bp numeric(20, 8) NOT NULL,
  peer_spread_median_bp numeric(20, 8) NOT NULL,
  historical_percentile numeric(10, 6) NOT NULL CHECK (
    historical_percentile BETWEEN 0 AND 100
  ),
  recommendation text NOT NULL CHECK (
    recommendation IN ('strong_buy', 'neutral', 'wait')
  ),
  decision text NOT NULL,
  company_metrics_date date,
  lcr_percentile_60d numeric(12, 10) CHECK (
    lcr_percentile_60d BETWEEN 0 AND 1
  ),
  nsfr_percentile_60d numeric(12, 10) CHECK (
    nsfr_percentile_60d BETWEEN 0 AND 1
  ),
  funding_gap_billion_yuan numeric(24, 8),
  subject_spread_bp numeric(20, 8),
  subject_spread_percentile numeric(12, 10) CHECK (
    subject_spread_percentile BETWEEN 0 AND 1
  ),
  cv_rmse numeric(20, 10),
  cv_ic numeric(20, 10),
  timing_cost_saving_bp numeric(20, 10),
  timing_win_rate numeric(12, 10) CHECK (timing_win_rate BETWEEN 0 AND 1),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS financing_model_run_latest_idx
  ON financing_model.model_run (as_of_date DESC, generated_at DESC);

CREATE TABLE IF NOT EXISTS financing_model.conclusion_revision (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES financing_model.model_run(id) ON DELETE CASCADE,
  verdict text NOT NULL CHECK (char_length(verdict) BETWEEN 1 AND 120),
  preferred_window text NOT NULL CHECK (char_length(preferred_window) <= 160),
  narrative text NOT NULL CHECK (char_length(narrative) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS financing_model_conclusion_latest_idx
  ON financing_model.conclusion_revision (run_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS financing_model.sell_side_snapshot (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES financing_model.model_run(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_start <= period_end),
  search_query text NOT NULL,
  model_name text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS financing_model_sell_side_latest_idx
  ON financing_model.sell_side_snapshot (run_id, generated_at DESC);

COMMENT ON SCHEMA financing_model IS '债券融资择时模型快照、人工结论修订及卖方观点';
COMMENT ON TABLE financing_model.model_run IS 'quant pipeline 每次运行追加的不可变结构化模型快照';
COMMENT ON TABLE financing_model.conclusion_revision IS 'dashboard 人工编辑的整体结论追加修订';
COMMENT ON TABLE financing_model.sell_side_snapshot IS 'dashboard 通过 AI Search 与 AI Gateway 生成的卖方观点快照';
