"""市场状态、方向分类与分位数三层实验测试。"""

from __future__ import annotations

import unittest

import numpy as np
import pandas as pd

from archive.margin_flow.contracts import (
    MODEL_OUTPUT_COLUMNS,
    PRODUCTION_FEATURE_GROUPS,
    ModelInput,
)
from archive.margin_flow.market_data import (
    CORE_ECONOMIC_FEATURES,
    FLOW_DECOMPOSITION_FEATURES,
    PRODUCTION_THREE_LAYER_FEATURES,
    _add_market_features,
    resolve_economic_feature_names,
)
from archive.margin_flow.margin_feature_engineering_experiment import (
    ENHANCED_COMPONENTS,
    ENHANCED_FEATURES,
    compare_feature_increment,
)
from archive.margin_flow.state_direction_quantile_experiment import (
    SCHEME_BASE_FEATURES,
    SCHEME_COMPONENTS,
    _market_state,
    assess_production_upgrade,
    build_scheme_models,
    evaluate_scheme_diagnostics,
)


def _model_input() -> ModelInput:
    index = pd.bdate_range("2023-01-02", periods=430)
    step = np.arange(len(index), dtype=float)
    cycle = np.sin(step / 9) * 8 + np.sin(step / 31) * 20
    frame = pd.DataFrame(
        {
            "market_margin": 10_000 + step * 0.4 + cycle,
            "financing_balance": 9_950 + step * 0.4 + cycle,
            "financing_buy": 500 + np.cos(step / 8) * 20,
            "financing_repayment": 500 - np.sin(step / 7) * 20,
            "securities_lending_balance": 50 + np.sin(step / 15),
            "margin_turnover": 900 + np.cos(step / 10) * 30,
            "active_investors": 20_000 + step,
            "indebted_investors": 8_000 + step / 2,
            "collateral_value": 25_000 + step,
            "collateral_cash": 4_000 + step / 3,
            "maintenance_ratio_pct": 250 + np.sin(step / 20),
            "margin_turnover_share_pct": 8 + np.sin(step / 12),
            "margin_float_mcap_share_pct": 2 + np.sin(step / 30) / 10,
            "equity_bond_spread": 3 + np.sin(step / 20),
        },
        index=index,
    )
    for feature_position, feature in enumerate(CORE_ECONOMIC_FEATURES, start=1):
        if feature not in frame:
            frame[feature] = np.sin(step / (feature_position + 3))
    frame = _add_market_features(frame)
    evaluation = frame.iloc[380:410].copy()
    train = frame.iloc[:375].copy()
    return ModelInput(
        fold=1,
        evaluation_set="validation",
        evaluation_year=int(evaluation.index[0].year),
        horizon=5,
        train=train,
        evaluation=evaluation,
        history=frame.loc[: evaluation.index.max()].copy(),
        feature_names=tuple(CORE_ECONOMIC_FEATURES),
    )


class SchemeExperimentTest(unittest.TestCase):
    def test_feature_scope_uses_all_economic_and_flow_features(self):
        self.assertEqual(
            SCHEME_BASE_FEATURES,
            CORE_ECONOMIC_FEATURES + FLOW_DECOMPOSITION_FEATURES,
        )
        self.assertEqual(len(SCHEME_BASE_FEATURES), 31)

    def test_market_state_is_rule_based_and_exhaustive(self):
        frame = pd.DataFrame(
            {
                "csi300_ret_5d": [0.02, -0.02, 0.01],
                "csi300_ret_20d": [0.03, -0.03, -0.01],
                "csi300_vol_20d": [0.01, 0.03, 0.01],
            }
        )

        state = _market_state(frame, high_volatility_threshold=0.02)

        self.assertEqual(state.tolist(), ["bull", "bear", "range"])

    def test_three_components_share_fit_and_keep_standard_output(self):
        model_input = _model_input()
        models = build_scheme_models()

        outputs = [model.predict([model_input]).predictions for model in models]

        self.assertEqual([model.name for model in models], list(SCHEME_COMPONENTS))
        self.assertTrue(all(model.engine is models[0].engine for model in models))
        for output in outputs:
            self.assertEqual(tuple(output.columns), MODEL_OUTPUT_COLUMNS)
            self.assertTrue(np.isfinite(output["predicted_change"]).all())

        diagnostics = models[0].engine.diagnostics
        np.testing.assert_allclose(
            diagnostics[["probability_down", "probability_flat", "probability_up"]].sum(
                axis=1
            ),
            1.0,
        )
        self.assertTrue((diagnostics["p25_change"] <= diagnostics["p50_change"]).all())
        self.assertTrue((diagnostics["p50_change"] <= diagnostics["p75_change"]).all())
        observed_states = set(diagnostics["market_state"])
        self.assertTrue(observed_states)
        self.assertTrue(observed_states <= {"bear", "range", "bull"})

        regime, interval = evaluate_scheme_diagnostics(diagnostics)
        self.assertEqual(set(regime["market_state"]), observed_states)
        self.assertTrue(interval["p25_p75_coverage"].between(0, 1).all())
        self.assertTrue((interval["mean_interval_width"] >= 0).all())

    def test_upgrade_gate_requires_five_percent_mae_improvement(self):
        records = []
        for year in range(2021, 2026):
            for model, error in (
                ("main_regression", 10.0),
                ("scheme_direction_class", 9.6),
                ("scheme_quantile_p50", 4.0),
                ("scheme_three_layer", 4.0),
            ):
                records.append(
                    {
                        "evaluation_set": "validation",
                        "evaluation_year": year,
                        "horizon": 1,
                        "model": model,
                        "origin_balance": 1_000.0,
                        "actual_change": 100.0,
                        "predicted_change": 100.0 - error,
                    }
                )

        result = assess_production_upgrade(pd.DataFrame(records)).set_index(
            "challenger"
        )

        self.assertFalse(
            result.loc["scheme_direction_class", "passes_upgrade_threshold"]
        )
        self.assertAlmostEqual(
            result.loc["scheme_direction_class", "mae_improvement_pct"],
            4.0,
        )
        self.assertTrue(result.loc["scheme_quantile_p50", "passes_upgrade_threshold"])

    def test_enhanced_experiment_matches_production_feature_groups(self):
        production_features = resolve_economic_feature_names(PRODUCTION_FEATURE_GROUPS)

        self.assertEqual(len(production_features), 54)
        self.assertTrue(set(production_features) <= set(ENHANCED_FEATURES))
        self.assertEqual(len(ENHANCED_FEATURES), 60)
        self.assertEqual(ENHANCED_FEATURES, PRODUCTION_THREE_LAYER_FEATURES)
        self.assertEqual(
            ENHANCED_COMPONENTS,
            (
                "scheme_fe_direction_class",
                "scheme_fe_quantile_p50",
                "scheme_fe_three_layer",
            ),
        )

    def test_feature_increment_uses_same_component_and_dataset(self):
        metrics = pd.DataFrame(
            {
                "evaluation_set": ["validation", "validation"],
                "horizon": [1, 1],
                "model": ["scheme_direction_class", "scheme_fe_direction_class"],
                "mae": [100.0, 95.0],
                "direction_accuracy": [0.60, 0.63],
                "relative_error_pct": [1.0, 0.9],
            }
        )

        result = compare_feature_increment(metrics).iloc[0]

        self.assertEqual(result["component"], "direction_class")
        self.assertAlmostEqual(result["mae_improvement_pct"], 5.0)
        self.assertAlmostEqual(result["direction_change_pp"], 3.0)


if __name__ == "__main__":
    unittest.main()
