"""全市场两融统一 data/model/evaluation 契约测试。"""

import io
import sys
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

import numpy as np
import pandas as pd

from archive.margin_flow.contracts import (
    MODEL_OUTPUT_COLUMNS,
    PRODUCTION_FEATURE_GROUPS,
    ModelInput,
    PipelineConfig,
)
from archive.margin_flow.data import build_model_inputs
from archive.margin_flow.evaluate import evaluate_predictions
from archive.margin_flow.flow_residual import (
    ABLATION_SPECS,
    TimesFMLightGBMResidualModel,
    TimesFMRidgeResidualModel,
    build_ablation_models,
)
from archive.margin_flow.market_data import (
    CORE_ECONOMIC_FEATURES,
    ENGINE_DERIVED_FEATURES,
    FEATURE_LABELS,
    FEATURE_TAXONOMY,
    FORECAST_HORIZONS,
    FLOW_DECOMPOSITION_FEATURES,
    MARGIN_BEHAVIOR_FEATURES,
    MARGIN_OPTIONAL_FEATURE_GROUPS,
    PRODUCTION_THREE_LAYER_FEATURES,
    _add_market_features,
    resolve_economic_feature_names,
    validate_feature_taxonomy,
)
from archive.margin_flow.models import (
    LightGBMModel,
    MODEL_REGISTRY,
    MainRegressionModel,
    ThreeLayerModel,
    TrendPersistenceModel,
    TimesFMModel,
)
from archive.margin_flow.pipeline import run_pipeline
from archive.margin_flow.timesfm_engine import TimesFMForecastEngine


def _daily_market_fixture(
    rows: int = 520,
    start: str = "2024-01-02",
) -> pd.DataFrame:
    index = pd.bdate_range(start, periods=rows)
    step = np.arange(rows, dtype=float)
    cycle = np.sin(step / 12)
    frame = pd.DataFrame(
        {
            "market_margin": 1000.0 + step * 0.2 + cycle * 10,
            "financing_balance": 990.0 + step * 0.2 + cycle * 10,
            "securities_lending_balance": 10.0,
            "financing_buy": 50.0,
            "securities_lending_sell": 1.0,
            "active_investors": 10000.0 + step,
            "individual_investors": 800.0 + step / 100,
            "institutional_investors": 500.0,
            "indebted_investors": 5000.0 + step,
            "collateral_value": 3000.0 + step,
            "collateral_cash": 500.0,
            "eligible_securities_value": 2500.0 + step,
            "maintenance_ratio_pct": 250.0,
            "margin_turnover": 100.0,
            "margin_turnover_share_pct": 8.0,
            "margin_float_mcap_share_pct": 2.0,
            "equity_bond_spread": 3.0 + cycle,
        },
        index=index,
    )
    frame["financing_repayment"] = (
        frame["financing_balance"].shift(1)
        + frame["financing_buy"]
        - frame["financing_balance"]
    ).fillna(frame["financing_buy"])
    for feature_id, feature in enumerate(CORE_ECONOMIC_FEATURES, start=1):
        if feature not in frame:
            frame[feature] = step / (feature_id + 10)
    frame.index.name = "date"
    return _add_market_features(frame)


class MarketDataTest(unittest.TestCase):
    def test_production_config_uses_enhanced_feature_groups(self):
        config = PipelineConfig()

        self.assertEqual(config.additional_feature_groups, PRODUCTION_FEATURE_GROUPS)
        self.assertEqual(
            len(resolve_economic_feature_names(config.additional_feature_groups)),
            54,
        )

    def test_feature_taxonomy_covers_all_production_inputs(self):
        problems = validate_feature_taxonomy()

        self.assertEqual(problems, [])
        self.assertEqual(
            len(PRODUCTION_THREE_LAYER_FEATURES) + len(ENGINE_DERIVED_FEATURES),
            67,
        )
        self.assertEqual(
            sorted(sum(FEATURE_TAXONOMY.values(), ())),
            sorted(PRODUCTION_THREE_LAYER_FEATURES + ENGINE_DERIVED_FEATURES),
        )
        self.assertEqual(
            FEATURE_TAXONOMY["派生特征"],
            ("state_bear", "state_bull", "downside_ret_5d", "downside_ret_20d"),
        )
        self.assertEqual(
            FEATURE_TAXONOMY["交互特征"],
            (
                "downside_return_volatility",
                "saturation_drawdown",
                "financing_participation_momentum",
                "market_turnover_return_interaction",
                "downside_volatility",
                "bear_repayment_pressure",
                "bear_net_flow",
            ),
        )

    def test_targets_use_trading_day_horizons(self):
        result = _daily_market_fixture(40)

        self.assertEqual(FORECAST_HORIZONS, (1, 5, 20))
        self.assertEqual(len(CORE_ECONOMIC_FEATURES), 25)
        self.assertTrue(set(CORE_ECONOMIC_FEATURES) <= set(FEATURE_LABELS))
        with_macro = resolve_economic_feature_names(("macro",))
        self.assertEqual(len(with_macro), 31)
        self.assertTrue(
            {"CPI", "PPI", "PMI", "SOCIAL_FINANCE", "M2", "pmi_above_50"}
            <= set(with_macro)
        )
        self.assertFalse({"CPI", "PPI", "PMI"} & set(CORE_ECONOMIC_FEATURES))
        with_behavior = resolve_economic_feature_names(("margin_behavior",))
        self.assertEqual(len(with_behavior), 46)
        self.assertTrue(set(MARGIN_BEHAVIOR_FEATURES) <= set(with_behavior))
        with_margin_equity = resolve_economic_feature_names(("margin_equity",))
        self.assertEqual(len(with_margin_equity), 33)
        with_both = resolve_economic_feature_names(("margin_equity", "margin_behavior"))
        self.assertEqual(len(with_both), 54)
        self.assertEqual(
            MARGIN_OPTIONAL_FEATURE_GROUPS,
            ("macro", "margin_equity", "margin_behavior"),
        )
        self.assertTrue(set(MARGIN_BEHAVIOR_FEATURES) <= set(FEATURE_LABELS))
        self.assertFalse(
            {
                "supply_20d",
                "bond_volume_20d_avg",
                "ef_funding_gap",
            }
            & set(CORE_ECONOMIC_FEATURES)
        )
        for horizon in FORECAST_HORIZONS:
            expected = (
                result.iloc[horizon]["market_margin"] - result.iloc[0]["market_margin"]
            )
            self.assertAlmostEqual(
                result.iloc[0][f"target_amount_t{horizon}"], expected
            )
            self.assertEqual(
                result.iloc[0][f"target_date_t{horizon}"], result.index[horizon]
            )

    def test_margin_behavior_features_use_only_current_and_lagged_data(self):
        result = _daily_market_fixture(600)

        self.assertTrue(set(MARGIN_BEHAVIOR_FEATURES) <= set(result.columns))
        position = 300
        balance = result["market_margin"]
        expected_acceleration = (
            (balance.iloc[position] - balance.iloc[position - 5])
            - (balance.iloc[position - 5] - balance.iloc[position - 10])
        ) / balance.iloc[position - 10]
        self.assertAlmostEqual(
            result.iloc[position]["margin_balance_accel_5d"],
            expected_acceleration,
        )
        expected_repay_buy = (
            result["financing_repayment"].iloc[position - 4 : position + 1].sum()
            / result["financing_buy"].iloc[position - 4 : position + 1].sum()
        )
        self.assertAlmostEqual(
            result.iloc[position]["financing_repay_buy_ratio_5d"],
            expected_repay_buy,
        )
        finite_features = set(MARGIN_BEHAVIOR_FEATURES) - {
            "market_turnover_log_z_60d",
            "market_turnover_return_interaction",
        }
        self.assertTrue(
            np.isfinite(
                result.iloc[position][sorted(finite_features)].to_numpy(dtype=float)
            ).all()
        )

    def test_financing_repayment_source_and_proxy_are_kept_separate(self):
        result = _daily_market_fixture(40)
        net_financing_flow = (
            result["financing_buy"] - result["financing_repayment_proxy"]
        )

        np.testing.assert_allclose(
            net_financing_flow.iloc[1:],
            result["financing_balance"].diff().iloc[1:],
        )
        self.assertIn("financing_repayment", result)
        self.assertIn("financing_repayment_to_balance", result)
        self.assertNotIn(
            "financing_repayment_proxy_to_balance",
            FLOW_DECOMPOSITION_FEATURES,
        )
        self.assertTrue(set(FLOW_DECOMPOSITION_FEATURES) <= set(result.columns))
        self.assertTrue(set(FLOW_DECOMPOSITION_FEATURES) <= set(FEATURE_LABELS))
        for block_number in range(1, 5):
            self.assertIn(f"target_amount_t20_block{block_number}", result)
            self.assertIn(f"target_pct_t20_block{block_number}", result)

    def test_model_inputs_enforce_non_overlapping_labels(self):
        dataset = _daily_market_fixture(rows=1650, start="2020-01-02")
        config = PipelineConfig(
            initial_train_years=2,
            test_year=2026,
            models=("trend_persistence",),
            additional_feature_groups=(),
        )

        inputs = build_model_inputs(dataset, config)

        for horizon, folds in inputs.items():
            self.assertGreater(len(folds), 0)
            validation_years = [
                model_input.evaluation_year
                for model_input in folds
                if model_input.evaluation_set == "validation"
            ]
            test_inputs = [
                model_input
                for model_input in folds
                if model_input.evaluation_set == "test"
            ]
            self.assertEqual(validation_years, [2022, 2023, 2024, 2025])
            self.assertEqual(len(test_inputs), 1)
            self.assertEqual(test_inputs[0].evaluation_year, 2026)
            validation_train_sizes = [
                len(model_input.train)
                for model_input in folds
                if model_input.evaluation_set == "validation"
            ]
            self.assertEqual(validation_train_sizes, sorted(validation_train_sizes))
            self.assertLess(validation_train_sizes[0], validation_train_sizes[-1])
            for model_input in folds:
                self.assertLess(
                    model_input.train[f"target_date_t{horizon}"].max(),
                    model_input.evaluation.index.min(),
                )
                self.assertEqual(
                    set(model_input.evaluation.index.year),
                    {model_input.evaluation_year},
                )


class ModelContractTest(unittest.TestCase):
    @staticmethod
    def _input(
        horizon: int = 20,
        evaluation_set: str = "validation",
    ) -> ModelInput:
        dataset = _daily_market_fixture(380)
        validation = dataset.iloc[340:360].copy()
        train = dataset.iloc[: 340 - horizon].copy()
        return ModelInput(
            fold=1,
            evaluation_set=evaluation_set,
            evaluation_year=int(validation.index[0].year),
            horizon=horizon,
            train=train,
            evaluation=validation,
            history=dataset.loc[: validation.index.max()].copy(),
            feature_names=tuple(CORE_ECONOMIC_FEATURES),
        )

    def test_registry_contains_exact_five_models(self):
        self.assertEqual(
            tuple(MODEL_REGISTRY),
            (
                "trend_persistence",
                "timesfm",
                "main_regression",
                "lightgbm",
                "three_layer",
            ),
        )
        self.assertEqual(PipelineConfig().models, tuple(MODEL_REGISTRY))

    def test_three_layer_is_a_standard_production_model(self):
        model_input = self._input(5)
        for frame in (
            model_input.train,
            model_input.evaluation,
            model_input.history,
        ):
            for feature_position, feature in enumerate(
                PRODUCTION_THREE_LAYER_FEATURES,
                start=1,
            ):
                if feature not in frame:
                    frame[feature] = np.sin(
                        np.arange(len(frame), dtype=float) / (feature_position + 3)
                    )
        model = ThreeLayerModel()

        output = model.predict([model_input]).predictions

        self.assertEqual(tuple(output.columns), MODEL_OUTPUT_COLUMNS)
        self.assertEqual(output["model"].unique().tolist(), ["three_layer"])
        self.assertTrue(np.isfinite(output["predicted_change"]).all())

    def test_trend_persistence_uses_ewma_daily_change(self):
        model_input = self._input()
        output = TrendPersistenceModel().predict([model_input])
        expected = (
            model_input.history["market_margin"]
            .diff()
            .ewm(span=20, adjust=False, min_periods=5)
            .mean()
            .reindex(model_input.evaluation.index)
            * model_input.horizon
        )

        self.assertEqual(tuple(output.predictions.columns), MODEL_OUTPUT_COLUMNS)
        np.testing.assert_allclose(
            output.predictions["predicted_change"],
            expected,
        )
        self.assertEqual(
            output.predictions["model"].unique().tolist(), ["trend_persistence"]
        )
        self.assertEqual(
            output.predictions["input_scope"].unique().tolist(), ["univariate"]
        )
        with self.assertRaises(ValueError):
            TrendPersistenceModel(span=1)
        with self.assertRaises(ValueError):
            TrendPersistenceModel(min_periods=0)

    def test_timesfm_uses_same_output_without_loading_weights(self):
        def persistence(contexts: list[np.ndarray], horizon: int) -> np.ndarray:
            return np.asarray(
                [np.repeat(context[-1], horizon) for context in contexts],
                dtype=float,
            )

        output = TimesFMModel(forecaster=persistence).predict([self._input()])

        self.assertEqual(tuple(output.predictions.columns), MODEL_OUTPUT_COLUMNS)
        self.assertTrue((output.predictions["predicted_change"] == 0).all())
        self.assertEqual(
            output.predictions["input_scope"].unique().tolist(), ["univariate"]
        )

    def test_timesfm_loads_model_in_current_process(self):
        compiled_model = Mock()
        model_class = Mock()
        model_class.from_pretrained.return_value = compiled_model
        fake_timesfm = types.SimpleNamespace(
            TimesFM_2p5_200M_torch=model_class,
            ForecastConfig=lambda **kwargs: kwargs,
        )
        fake_torch = types.SimpleNamespace(
            set_float32_matmul_precision=Mock(),
        )
        model = TimesFMModel()

        with patch.dict(
            sys.modules,
            {"timesfm": fake_timesfm, "torch": fake_torch},
        ):
            loaded = model._load_model()

        self.assertIs(loaded, compiled_model)
        model_class.from_pretrained.assert_called_once()
        compiled_model.compile.assert_called_once()
        compile_config = compiled_model.compile.call_args.args[0]
        self.assertEqual(compile_config["per_core_batch_size"], 32)

    def test_timesfm_per_core_batch_size_is_configurable(self):
        model = TimesFMModel(per_core_batch_size=8)
        self.assertEqual(model.per_core_batch_size, 8)
        with self.assertRaises(ValueError):
            TimesFMModel(per_core_batch_size=0)

    def test_multivariate_models_use_same_output(self):
        model_input = self._input()

        for model in (MainRegressionModel(), LightGBMModel()):
            with self.subTest(model=model.name):
                output = model.predict([model_input])
                self.assertEqual(
                    tuple(output.predictions.columns),
                    MODEL_OUTPUT_COLUMNS,
                )
                self.assertEqual(
                    output.predictions["input_scope"].unique().tolist(),
                    ["multivariate"],
                )

    def test_timesfm_flow_residual_challengers_use_same_output(self):
        def persistence(contexts: list[np.ndarray], horizon: int) -> np.ndarray:
            return np.asarray(
                [np.repeat(context[-1], horizon) for context in contexts],
                dtype=float,
            )

        model_input = self._input(horizon=5)
        engine = TimesFMForecastEngine(forecaster=persistence)
        models = (
            TimesFMRidgeResidualModel(engine),
            TimesFMLightGBMResidualModel(engine),
        )

        for model in models:
            with self.subTest(model=model.name):
                output = model.predict([model_input])
                self.assertEqual(
                    tuple(output.predictions.columns),
                    MODEL_OUTPUT_COLUMNS,
                )
                self.assertEqual(
                    output.predictions["input_scope"].unique().tolist(),
                    ["timesfm_path+economic+flow"],
                )
                self.assertTrue(
                    np.isfinite(output.predictions["predicted_change"]).all()
                )

    def test_ablation_matrix_and_t20_blocks_keep_unified_output(self):
        def persistence(contexts: list[np.ndarray], horizon: int) -> np.ndarray:
            return np.asarray(
                [np.repeat(context[-1], horizon) for context in contexts],
                dtype=float,
            )

        self.assertEqual([spec.code for spec in ABLATION_SPECS], ["a", "b", "c", "d"])
        self.assertEqual(
            [(spec.include_flow, spec.recent_train_years) for spec in ABLATION_SPECS],
            [(False, None), (False, 3), (True, None), (True, 3)],
        )
        engine = TimesFMForecastEngine(forecaster=persistence)
        models = build_ablation_models(
            engine,
            target_mode="t20_blocks",
            name_prefix="t20_blocks",
        )
        self.assertEqual(len(models), 8)
        output = models[0].predict([self._input(horizon=20)])
        self.assertEqual(tuple(output.predictions.columns), MODEL_OUTPUT_COLUMNS)
        self.assertTrue(np.isfinite(output.predictions["predicted_change"]).all())

    def test_main_regression_exposes_standardized_coefficients(self):
        model_input = self._input(horizon=5)
        model = MainRegressionModel()

        model.predict([model_input])
        coefficients = model.coefficient_history

        self.assertEqual(len(coefficients), len(CORE_ECONOMIC_FEATURES))
        self.assertEqual(set(coefficients["feature"]), set(CORE_ECONOMIC_FEATURES))
        self.assertEqual(coefficients["horizon"].unique().tolist(), [5])
        np.testing.assert_allclose(
            coefficients["coefficient_bps_per_1sd"],
            coefficients["coefficient_pct_per_1sd"] * 10_000,
        )
        self.assertTrue(coefficients["alpha"].isin((0.1, 1.0, 10.0, 100.0)).all())


class EvaluationContractTest(unittest.TestCase):
    def test_standard_metrics_use_t_day_balance_denominator(self):
        predictions = pd.DataFrame(
            {
                "model": ["test", "test"],
                "input_scope": ["multivariate", "multivariate"],
                "fold": [1, 1],
                "evaluation_set": ["test", "test"],
                "evaluation_year": [2026, 2026],
                "horizon": [5, 5],
                "origin_date": pd.to_datetime(["2026-01-01", "2026-01-02"]),
                "target_date": pd.to_datetime(["2026-01-08", "2026-01-09"]),
                "origin_balance": [1000.0, 2000.0],
                "actual_change": [100.0, -100.0],
                "predicted_change": [80.0, -140.0],
            },
            columns=MODEL_OUTPUT_COLUMNS,
        )

        metrics = evaluate_predictions(predictions).iloc[0]

        self.assertEqual(metrics["direction_accuracy"], 1.0)
        self.assertEqual(metrics["mae"], 30.0)
        self.assertEqual(metrics["relative_error_pct"], 2.0)


class PipelineProgressTest(unittest.TestCase):
    def test_pipeline_prints_validation_then_test_comparison_tables(self):
        dataset = _daily_market_fixture(380)
        metadata = {"feature_names": list(CORE_ECONOMIC_FEATURES)}
        inputs = {
            horizon: [
                ModelContractTest._input(horizon, "validation"),
                ModelContractTest._input(horizon, "test"),
            ]
            for horizon in (1, 5, 20)
        }
        test_year = inputs[1][-1].evaluation_year
        config = PipelineConfig(
            horizons=(1, 5, 20),
            models=("trend_persistence",),
            test_year=test_year,
        )
        output = io.StringIO()

        with (
            patch(
                "archive.margin_flow.pipeline.load_dataset",
                return_value=(dataset, metadata),
            ),
            patch(
                "archive.margin_flow.pipeline.build_model_inputs",
                return_value=inputs,
            ),
            redirect_stdout(output),
        ):
            result = run_pipeline(
                config=config,
                models=[TrendPersistenceModel()],
            )

        text = output.getvalue()
        self.assertIn("[Step 1] 数据读取与特征构建", text)
        self.assertIn("[Step 2] 年度 Expanding Window 输入构建", text)
        self.assertIn("Expanding Window", text)
        self.assertIn("年度验证", text)
        self.assertIn("最终测试", text)
        self.assertEqual(text.count("验证集 · T+"), 3)
        self.assertEqual(text.count("测试集 · T+"), 3)
        validation_t1 = text.index("验证集 · T+1")
        validation_t5 = text.index("验证集 · T+5")
        validation_t20 = text.index("验证集 · T+20")
        test_t1 = text.index("测试集 · T+1")
        test_t5 = text.index("测试集 · T+5")
        test_t20 = text.index("测试集 · T+20")
        self.assertLess(validation_t1, validation_t5)
        self.assertLess(validation_t5, validation_t20)
        self.assertLess(validation_t20, test_t1)
        self.assertLess(test_t1, test_t5)
        self.assertLess(test_t5, test_t20)
        self.assertIn("[RESULT] trend_persistence T+20", text)
        self.assertIn("[完成] 全市场两融 Pipeline 运行结束", text)
        self.assertEqual(len(result.metrics), 6)

    def test_pipeline_prints_main_regression_factors_before_final_tables(self):
        dataset = _daily_market_fixture(380)
        metadata = {"feature_names": list(CORE_ECONOMIC_FEATURES)}
        inputs = {
            1: [
                ModelContractTest._input(1, "validation"),
                ModelContractTest._input(1, "test"),
            ]
        }
        test_year = inputs[1][-1].evaluation_year
        output = io.StringIO()

        with (
            patch(
                "archive.margin_flow.pipeline.load_dataset",
                return_value=(dataset, metadata),
            ),
            patch(
                "archive.margin_flow.pipeline.build_model_inputs",
                return_value=inputs,
            ),
            redirect_stdout(output),
        ):
            result = run_pipeline(
                config=PipelineConfig(
                    horizons=(1,),
                    models=("main_regression",),
                    test_year=test_year,
                ),
                models=[MainRegressionModel()],
            )

        text = output.getvalue()
        factors_position = text.index("主回归主要影响因子 · T+1")
        comparison_position = text.index("验证集 · T+1")
        self.assertLess(factors_position, comparison_position)
        self.assertIn("当前系数（bp/1SD）", text)
        self.assertIn("验证折中位数", text)
        self.assertIn("与当前同号率", text)
        summary = result.metadata["main_regression"]["top_factors"]
        self.assertEqual(len(summary), 5)
        self.assertEqual(
            result.metadata["main_regression"]["coefficient_unit"],
            "target_change_rate_bps_per_1_train_sd",
        )


class ResearchReportContractTest(unittest.TestCase):
    def test_report_has_fixed_structure_and_six_result_tables(self):
        report = Path("archive/margin_flow/REPORT.md").read_text(encoding="utf-8")

        for section in range(1, 8):
            self.assertIn(f"## {section}. ", report)
        self.assertTrue(
            any(line.startswith("> 摘要：") for line in report.splitlines()[:8])
        )
        self.assertNotIn("技术摘要", report)
        self.assertEqual(
            report.count("| 模型 | 方向准确率 | MAE（亿元） | 相对误差 | 样本数 |"),
            6,
        )
        for heading in (
            "### 4.1 历史验证：T+1",
            "### 4.2 历史验证：T+5",
            "### 4.3 历史验证：T+20",
            "### 4.4 2026 测试：T+1",
            "### 4.5 2026 测试：T+5",
            "### 4.6 2026 测试：T+20",
        ):
            self.assertIn(heading, report)
        self.assertIn("### 4.7 五模型生产使用定位", report)
        self.assertIn("54 个生产特征", report)
        self.assertIn("三层组合", report)


if __name__ == "__main__":
    unittest.main()
