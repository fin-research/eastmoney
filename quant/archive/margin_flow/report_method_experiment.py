"""用现有两融数据复现并评估外部报告中的 ARIMA/Holt/MC 方法。

本模块只用于研究比较，不加入生产 ``MODEL_REGISTRY``。所有模型仍接收
标准 ``ModelInput`` 并返回 ``ModelOutput``，因此与生产模型共用年度
Expanding Window、当年最终测试和统一评价指标。
"""

from __future__ import annotations

import argparse
import warnings
from collections.abc import Sequence
from pathlib import Path

import numpy as np
import pandas as pd
from statsmodels.tsa.arima.model import ARIMA
from statsmodels.tsa.holtwinters import Holt

from .contracts import ModelInput, ModelOutput, PipelineConfig
from .models import (
    ForecastModel,
    ProgressCallback,
    build_models,
)
from .pipeline import run_pipeline, save_pipeline_result

REPORT_METHOD_COMPONENTS = (
    "report_arima211",
    "report_holt_damped",
    "report_mc_median",
    "report_ensemble",
)


class ReportMethodForecastEngine:
    """按预测起点缓存报告方法的三个分量路径。"""

    def __init__(
        self,
        max_horizon: int = 20,
        n_simulations: int = 10_000,
        random_seed: int = 42,
        progress: ProgressCallback | None = None,
    ):
        if max_horizon < 1:
            raise ValueError("max_horizon 必须为正数。")
        if n_simulations < 1:
            raise ValueError("n_simulations 必须为正数。")
        self.max_horizon = max_horizon
        self.n_simulations = n_simulations
        self.random_seed = random_seed
        self.progress = progress
        self._cache: dict[pd.Timestamp, dict[str, np.ndarray]] = {}

    def _log(self, message: str) -> None:
        if self.progress is not None:
            self.progress(message)

    @staticmethod
    def _validate_balance(balance: pd.Series) -> np.ndarray:
        values = balance.to_numpy(dtype=float)
        if len(values) < 60:
            raise ValueError("报告方法至少需要 60 个历史余额样本。")
        if not np.isfinite(values).all() or (values <= 0).any():
            raise ValueError("报告方法要求历史余额均为有限正数。")
        return values

    def _monte_carlo_median(
        self,
        values: np.ndarray,
        origin_date: pd.Timestamp,
    ) -> np.ndarray:
        log_returns = np.diff(np.log(values))
        recent_returns = log_returns[-20:]
        blended_volatility = 0.7 * np.std(recent_returns, ddof=1) + 0.3 * np.std(
            log_returns, ddof=1
        )
        blended_drift = 0.5 * np.mean(recent_returns) + 0.5 * np.mean(log_returns) * 0.3
        mean_60 = float(np.mean(values[-60:]))
        seed = np.random.SeedSequence(
            [self.random_seed, int(origin_date.year), int(origin_date.dayofyear)]
        )
        random = np.random.default_rng(seed)
        current = np.full(self.n_simulations, values[-1], dtype=float)
        median_path = np.empty(self.max_horizon, dtype=float)
        for step in range(self.max_horizon):
            mean_reversion = (
                np.zeros_like(current)
                if step == 0
                else -0.02 * np.log(current / mean_60)
            )
            current *= np.exp(
                blended_drift
                + mean_reversion
                + blended_volatility * random.standard_normal(self.n_simulations)
            )
            median_path[step] = float(np.median(current))
        return median_path

    def _fit_paths(
        self,
        balance: pd.Series,
        origin_date: pd.Timestamp,
    ) -> dict[str, np.ndarray]:
        values = self._validate_balance(balance)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            arima_path = np.asarray(
                ARIMA(values, order=(2, 1, 1)).fit().forecast(self.max_horizon),
                dtype=float,
            )
            holt_path = np.asarray(
                Holt(values, damped_trend=True).fit().forecast(self.max_horizon),
                dtype=float,
            )
        mc_path = self._monte_carlo_median(values, origin_date)
        return {
            "report_arima211": arima_path,
            "report_holt_damped": holt_path,
            "report_mc_median": mc_path,
        }

    def paths(
        self,
        balance: pd.Series,
        origin_date: pd.Timestamp,
    ) -> dict[str, np.ndarray]:
        origin = pd.Timestamp(origin_date)
        if origin not in self._cache:
            self._cache[origin] = self._fit_paths(balance, origin)
            completed = len(self._cache)
            if completed == 1 or completed % 50 == 0:
                self._log(
                    "[INFO] report_method: "
                    f"已完成 {completed} 个唯一预测起点的 ARIMA/Holt/MC 拟合"
                )
        return self._cache[origin]

    @staticmethod
    def ensemble_value(paths: dict[str, np.ndarray], horizon: int) -> float:
        if horizon <= 5:
            arima_weight, holt_weight, time_series_weight = 0.55, 0.45, 0.70
        elif horizon <= 20:
            arima_weight, holt_weight, time_series_weight = 0.45, 0.55, 0.60
        else:
            arima_weight, holt_weight, time_series_weight = 0.35, 0.65, 0.50
        position = horizon - 1
        time_series_value = (
            arima_weight * paths["report_arima211"][position]
            + holt_weight * paths["report_holt_damped"][position]
        )
        return float(
            time_series_weight * time_series_value
            + (1.0 - time_series_weight) * paths["report_mc_median"][position]
        )


class ReportMethodModel(ForecastModel):
    """外部报告单个分量或最终手工加权集成。"""

    input_scope = "univariate"

    def __init__(
        self,
        component: str,
        engine: ReportMethodForecastEngine,
        progress: ProgressCallback | None = None,
    ):
        if component not in REPORT_METHOD_COMPONENTS:
            raise ValueError(f"未知报告方法分量: {component}")
        super().__init__(progress=progress)
        self.name = component
        self.engine = engine

    def _predict_fold(self, model_input: ModelInput) -> np.ndarray:
        balance = model_input.history["market_margin"].astype(float)
        predictions = []
        for origin_date in model_input.evaluation.index:
            origin_history = balance.loc[:origin_date]
            paths = self.engine.paths(origin_history, pd.Timestamp(origin_date))
            if self.name == "report_ensemble":
                forecast_balance = self.engine.ensemble_value(
                    paths,
                    model_input.horizon,
                )
            else:
                forecast_balance = float(paths[self.name][model_input.horizon - 1])
            predictions.append(forecast_balance - float(origin_history.iloc[-1]))
        return np.asarray(predictions, dtype=float)

    def predict(self, inputs: Sequence[ModelInput]) -> ModelOutput:
        self.engine.progress = self.progress
        return self._predict_folds(inputs, self._predict_fold)


def build_report_method_models(
    progress: ProgressCallback | None = None,
    n_simulations: int = 10_000,
) -> list[ReportMethodModel]:
    """构造共享同一拟合缓存的三个分量和最终集成。"""
    engine = ReportMethodForecastEngine(
        n_simulations=n_simulations,
        progress=progress,
    )
    return [
        ReportMethodModel(component, engine, progress=progress)
        for component in REPORT_METHOD_COMPONENTS
    ]


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="用标准两融年度切分比较外部报告方法和现有模型",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="保存 predictions.csv、metrics.csv、metadata.json 的目录",
    )
    parser.add_argument(
        "--n-simulations",
        type=int,
        default=10_000,
        help="每个预测起点的蒙特卡洛路径数，默认复现报告的 10000",
    )
    parser.add_argument(
        "--skip-timesfm",
        action="store_true",
        help="仅在快速诊断时跳过 TimesFM；正式比较不应使用",
    )
    return parser.parse_args()


def cli() -> None:
    args = _parse_args()
    production_names = [
        "trend_persistence",
        "main_regression",
        "lightgbm",
        "three_layer",
    ]
    if not args.skip_timesfm:
        production_names.insert(1, "timesfm")
    models = build_models(production_names)
    models.extend(build_report_method_models(n_simulations=args.n_simulations))
    config = PipelineConfig(models=tuple(model.name for model in models))
    result = run_pipeline(config=config, models=models)
    save_pipeline_result(result, args.output_dir)


if __name__ == "__main__":
    cli()
