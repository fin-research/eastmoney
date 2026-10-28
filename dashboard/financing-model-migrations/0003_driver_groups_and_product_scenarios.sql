ALTER TABLE financing_model.model_run
  ADD COLUMN lcr_value numeric(20, 10),
  ADD COLUMN nsfr_value numeric(20, 10),
  ADD COLUMN cv_sample_start_date date,
  ADD COLUMN cv_sample_end_date date,
  ADD COLUMN cv_mae numeric(20, 10),
  ADD COLUMN recommended_product text,
  ADD COLUMN recommended_tenor_years numeric(10, 4),
  ADD COLUMN recommended_bond_type text;

ALTER TABLE financing_model.model_run
  ADD CONSTRAINT financing_model_liquidity_values_check CHECK (
    (lcr_value IS NULL OR lcr_value >= 0) AND
    (nsfr_value IS NULL OR nsfr_value >= 0)
  ),
  ADD CONSTRAINT financing_model_cv_sample_range_check CHECK (
    (cv_sample_start_date IS NULL AND cv_sample_end_date IS NULL) OR
    (
      cv_sample_start_date IS NOT NULL AND
      cv_sample_end_date IS NOT NULL AND
      cv_sample_start_date <= cv_sample_end_date
    )
  ),
  ADD CONSTRAINT financing_model_cv_mae_check CHECK (
    cv_mae IS NULL OR cv_mae >= 0
  ),
  ADD CONSTRAINT financing_model_product_recommendation_check CHECK (
    (
      recommended_product IS NULL AND
      recommended_tenor_years IS NULL AND
      recommended_bond_type IS NULL
    ) OR
    (
      recommended_product IS NOT NULL AND
      recommended_tenor_years > 0 AND
      recommended_bond_type IS NOT NULL
    )
  );

CREATE TABLE financing_model.model_run_driver_group (
  run_id uuid NOT NULL REFERENCES financing_model.model_run(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  category text NOT NULL,
  display_name text NOT NULL,
  support_score numeric(12, 8) NOT NULL CHECK (support_score BETWEEN 0 AND 100),
  support_bp numeric(20, 10) NOT NULL,
  importance_weight numeric(12, 10) NOT NULL CHECK (
    importance_weight BETWEEN 0 AND 1
  ),
  PRIMARY KEY (run_id, ordinal),
  UNIQUE (run_id, category)
);

CREATE TABLE financing_model.model_run_product_scenario (
  run_id uuid NOT NULL REFERENCES financing_model.model_run(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 4),
  display_name text NOT NULL,
  tenor_years numeric(10, 4) NOT NULL CHECK (tenor_years > 0),
  bond_type text NOT NULL,
  predicted_deviation_bp numeric(20, 8) NOT NULL,
  peer_spread_median_bp numeric(20, 8) NOT NULL,
  historical_percentile numeric(10, 6) NOT NULL CHECK (
    historical_percentile BETWEEN 0 AND 100
  ),
  recommendation text NOT NULL CHECK (
    recommendation IN ('strong_buy', 'neutral', 'wait')
  ),
  recommendation_label text NOT NULL,
  rank integer NOT NULL CHECK (rank BETWEEN 1 AND 4),
  cost_vs_best_bp numeric(20, 8) NOT NULL CHECK (cost_vs_best_bp >= 0),
  is_recommended boolean NOT NULL,
  PRIMARY KEY (run_id, ordinal),
  UNIQUE (run_id, display_name),
  UNIQUE (run_id, rank)
);

CREATE UNIQUE INDEX financing_model_product_recommended_idx
  ON financing_model.model_run_product_scenario (run_id)
  WHERE is_recommended;

CREATE TABLE financing_model.timing_decision_record (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE REFERENCES financing_model.model_run(id) ON DELETE CASCADE,
  decision_action text NOT NULL CHECK (
    char_length(btrim(decision_action)) BETWEEN 1 AND 1000
  ),
  outcome text NOT NULL DEFAULT '' CHECK (
    char_length(outcome) <= 2000
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE financing_model.model_run_driver_group IS
  '模型运行按正式特征组汇总的局部 SHAP 发行支持度';
COMMENT ON TABLE financing_model.model_run_product_scenario IS
  '3Y/5Y 公募债与次级债的同批模型预测及品种推荐排序';
COMMENT ON TABLE financing_model.timing_decision_record IS
  '人工录入的历史择时决策操作与结果，模型日期、分位和建议由 model_run 派生';
