"""统一接口下的四类全市场两融余额预测模型。"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable, Sequence

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.model_selection import GridSearchCV, TimeSeriesSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from .contracts import MODEL_OUTPUT_COLUMNS, ModelInput, ModelOutput
from .timesfm_engine import (
    ProgressCallback,
    TimesFMForecastEngine,
    TimesFMForecaster,
)

RIDGE_ALPHAS = (0.1, 1.0, 10.0, 100.0)
RIDGE_COEFFICIENT_COLUMNS = (
    "fold",
    "evaluation_set",
    "evaluation_year",
    "horizon",
    "feature",
    "coefficient_pct_per_1sd",
    "coefficient_bps_per_1sd",
    "alpha",
)


def _model_output(
    model: str,
    input_scope: str,
    model_input: ModelInput,
    predicted_change: np.ndarray,
) -> pd.DataFrame:
    evaluation = model_input.evaluation
    values = np.asarray(predicted_change, dtype=float)
    if values.shape != (len(evaluation),):
        raise ValueError(f"{model} 返回 {values.shape}，预期为 ({len(evaluation)},)。")
    return pd.DataFrame(
        {
            "model": model,
            "input_scope": input_scope,
            "fold": model_input.fold,
            "evaluation_set": model_input.evaluation_set,
            "evaluation_year": model_input.evaluation_year,
            "horizon": model_input.horizon,
            "origin_date": evaluation.index,
            "target_date": evaluation[model_input.target_date_column].to_numpy(),
            "origin_balance": evaluation["market_margin"].to_numpy(dtype=float),
            "actual_change": evaluation[model_input.target_amount_column].to_numpy(
                dtype=float
            ),
            "predicted_change": values,
        },
        columns=MODEL_OUTPUT_COLUMNS,
    )


class ForecastModel(ABC):
    """所有模型共用的批量 walk-forward 预测接口。"""

    name: str
    input_scope: str

    def __init__(self, progress: ProgressCallback | None = None):
        self.progress = progress

    def _log(self, message: str) -> None:
        if self.progress is not None:
            self.progress(message)

    @staticmethod
    def _validate_inputs(inputs: Sequence[ModelInput]) -> None:
        if not inputs:
            raise ValueError("模型输入不能为空。")
        for model_input in inputs:
            model_input.validate()

    def _log_fold_result(self, frame: pd.DataFrame) -> None:
        actual = frame["actual_change"].to_numpy(dtype=float)
        predicted = frame["predicted_change"].to_numpy(dtype=float)
        balance = frame["origin_balance"].to_numpy(dtype=float)
        absolute_error = np.abs(predicted - actual)
        direction_mask = actual != 0
        direction = (
            float(
                (
                    np.sign(predicted[direction_mask])
                    == np.sign(actual[direction_mask])
                ).mean()
            )
            if direction_mask.any()
            else float("nan")
        )
        self._log(
            f"[INFO] {self.name} T+{int(frame['horizon'].iloc[0])} "
            f"{int(frame['evaluation_year'].iloc[0])}年"
            f"{'最终测试' if frame['evaluation_set'].iloc[0] == 'test' else '验证'}"
            "完成: "
            f"方向={direction:.2%}, "
            f"MAE={absolute_error.mean():.2f}亿元, "
            f"相对误差={(absolute_error / balance).mean():.2%}"
        )

    def _predict_folds(
        self,
        inputs: Sequence[ModelInput],
        predict_fold: Callable[[ModelInput], np.ndarray],
    ) -> ModelOutput:
        self._validate_inputs(inputs)
        frames = []
        total = len(inputs)
        for position, model_input in enumerate(inputs, start=1):
            evaluation_name = (
                "最终测试" if model_input.evaluation_set == "test" else "年度验证"
            )
            self._log(
                f"[INFO] {self.name} T+{model_input.horizon} "
                f"{model_input.evaluation_year}年{evaluation_name} "
                f"({position}/{total}): "
                f"训练 {len(model_input.train)}，"
                f"评估 {len(model_input.evaluation)}"
            )
            frame = _model_output(
                self.name,
                self.input_scope,
                model_input,
                predict_fold(model_input),
            )
            self._log_fold_result(frame)
            frames.append(frame)
        return ModelOutput(pd.concat(frames, ignore_index=True))

    @abstractmethod
    def predict(self, inputs: Sequence[ModelInput]) -> ModelOutput:
        """接收标准 fold 输入并返回统一逐样本输出。"""


class TrendPersistenceModel(ForecastModel):
    """使用余额近期日变化趋势延续的单变量 baseline。"""

    name = "trend_persistence"
    input_scope = "univariate"

    def __init__(
        self,
        span: int = 20,
        min_periods: int = 5,
        progress: ProgressCallback | None = None,
    ):
        super().__init__(progress=progress)
        if span <= 1:
            raise ValueError("趋势延续 baseline 的 EWMA span 必须大于 1。")
        if min_periods < 1:
            raise ValueError("趋势延续 baseline 的 min_periods 必须为正数。")
        self.span = span
        self.min_periods = min_periods

    def _predict_fold(self, model_input: ModelInput) -> np.ndarray:
        balance = model_input.history["market_margin"].astype(float)
        smoothed_daily_change = (
            balance.diff()
            .ewm(
                span=self.span,
                adjust=False,
                min_periods=self.min_periods,
            )
            .mean()
        )
        forecast = smoothed_daily_change.reindex(model_input.evaluation.index)
        if forecast.isna().any():
            missing_date = forecast[forecast.isna()].index[0]
            raise ValueError(f"趋势延续 baseline 在 {missing_date:%Y-%m-%d} 缺少历史。")
        return forecast.to_numpy(dtype=float) * model_input.horizon

    def predict(self, inputs: Sequence[ModelInput]) -> ModelOutput:
        return self._predict_folds(inputs, self._predict_fold)


def _ridge_estimator(n_samples: int, horizon: int) -> GridSearchCV:
    n_splits = min(5, max(2, n_samples // 120))
    estimator = Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="median")),
            ("scaler", StandardScaler()),
            ("model", Ridge()),
        ]
    )
    return GridSearchCV(
        estimator,
        param_grid={"model__alpha": RIDGE_ALPHAS},
        cv=TimeSeriesSplit(n_splits=n_splits, gap=horizon),
        scoring="neg_mean_absolute_error",
        refit=True,
    )


class MainRegressionModel(ForecastModel):
    """结合全部经济结构特征的标准化 Ridge 主回归模型。"""

    name = "main_regression"
    input_scope = "multivariate"

    def __init__(self, progress: ProgressCallback | None = None):
        super().__init__(progress=progress)
        self._coefficient_records: dict[tuple, dict] = {}

    def _predict_fold(self, model_input: ModelInput) -> np.ndarray:
        features = list(model_input.feature_names)
        estimator = _ridge_estimator(len(model_input.train), model_input.horizon)
        estimator.fit(
            model_input.train[features],
            model_input.train[model_input.target_pct_column],
        )
        ridge = estimator.best_estimator_.named_steps["model"]
        for feature, coefficient in zip(features, ridge.coef_, strict=True):
            key = (
                model_input.horizon,
                model_input.evaluation_set,
                model_input.evaluation_year,
                model_input.fold,
                feature,
            )
            self._coefficient_records[key] = {
                "fold": model_input.fold,
                "evaluation_set": model_input.evaluation_set,
                "evaluation_year": model_input.evaluation_year,
                "horizon": model_input.horizon,
                "feature": feature,
                "coefficient_pct_per_1sd": float(coefficient),
                "coefficient_bps_per_1sd": float(coefficient * 10_000),
                "alpha": float(ridge.alpha),
            }
        predicted_pct = estimator.predict(model_input.evaluation[features])
        return predicted_pct * model_input.evaluation["market_margin"].to_numpy(
            dtype=float
        )

    @property
    def coefficient_history(self) -> pd.DataFrame:
        """返回各年度折的标准化 Ridge 系数，便于解释和审计。"""
        if not self._coefficient_records:
            return pd.DataFrame(columns=RIDGE_COEFFICIENT_COLUMNS)
        return (
            pd.DataFrame(
                self._coefficient_records.values(),
                columns=RIDGE_COEFFICIENT_COLUMNS,
            )
            .sort_values(
                [
                    "horizon",
                    "evaluation_set",
                    "evaluation_year",
                    "fold",
                    "feature",
                ]
            )
            .reset_index(drop=True)
        )

    def predict(self, inputs: Sequence[ModelInput]) -> ModelOutput:
        return self._predict_folds(inputs, self._predict_fold)


class LightGBMModel(ForecastModel):
    """结合全部经济结构特征的非线性 LightGBM 模型。"""

    name = "lightgbm"
    input_scope = "multivariate"

    @staticmethod
    def _predict_fold(model_input: ModelInput) -> np.ndarray:
        import lightgbm as lgb

        features = list(model_input.feature_names)
        medians = model_input.train[features].median(numeric_only=True).fillna(0.0)
        train_x = model_input.train[features].fillna(medians)
        evaluation_x = model_input.evaluation[features].fillna(medians)
        estimator = lgb.LGBMRegressor(
            objective="regression",
            n_estimators=200,
            learning_rate=0.03,
            num_leaves=7,
            max_depth=3,
            min_child_samples=30,
            reg_lambda=5.0,
            # PyTorch ships its own libomp on macOS; LightGBM's Homebrew
            # libomp can segfault when both runtimes create thread pools.
            n_jobs=1,
            verbosity=-1,
            random_state=42,
        )
        estimator.fit(
            train_x,
            model_input.train[model_input.target_pct_column],
        )
        predicted_pct = estimator.predict(evaluation_x)
        return predicted_pct * model_input.evaluation["market_margin"].to_numpy(
            dtype=float
        )

    def predict(self, inputs: Sequence[ModelInput]) -> ModelOutput:
        return self._predict_folds(inputs, self._predict_fold)


class TimesFMModel(ForecastModel):
    """在当前进程内运行、只使用全市场两融余额序列的 TimesFM。"""

    name = "timesfm"
    input_scope = "univariate"

    def __init__(
        self,
        forecaster: TimesFMForecaster | None = None,
        max_context: int = 1024,
        batch_size: int = 64,
        per_core_batch_size: int = 32,
        progress: ProgressCallback | None = None,
        engine: TimesFMForecastEngine | None = None,
    ):
        super().__init__(progress=progress)
        self.max_context = max_context
        self.batch_size = batch_size
        self.per_core_batch_size = per_core_batch_size
        self.forecaster = forecaster
        self.engine = engine or TimesFMForecastEngine(
            forecaster=forecaster,
            max_context=max_context,
            batch_size=batch_size,
            per_core_batch_size=per_core_batch_size,
            progress=progress,
        )

    def _load_model(self):
        self.engine.progress = self.progress
        return self.engine._load_model()

    def predict(self, inputs: Sequence[ModelInput]) -> ModelOutput:
        self._validate_inputs(inputs)
        horizons = {model_input.horizon for model_input in inputs}
        if len(horizons) != 1:
            raise ValueError("TimesFM 每个批次只能处理同一个预测期限。")
        horizon = next(iter(horizons))
        self._log(
            f"[INFO] timesfm T+{horizon}: {len(inputs)} 个 Expanding Window 评估窗口；"
            "预训练模型不在各折重新拟合"
        )
        self.engine.progress = self.progress

        frames = []
        total = len(inputs)
        for position, model_input in enumerate(inputs, start=1):
            predicted_changes = self.engine.forecast_changes(
                model_input.history,
                model_input.evaluation.index,
                horizon,
            )
            frame = _model_output(
                self.name,
                self.input_scope,
                model_input,
                predicted_changes,
            )
            self._log(
                f"[INFO] timesfm T+{horizon} "
                f"{model_input.evaluation_year}年"
                f"{'最终测试' if model_input.evaluation_set == 'test' else '验证'} "
                f"({position}/{total}): {len(model_input.evaluation)} 个样本"
            )
            self._log_fold_result(frame)
            frames.append(frame)
        return ModelOutput(pd.concat(frames, ignore_index=True))


class ThreeLayerModel(ForecastModel):
    """生产版市场状态、方向分类与分位数三层组合模型。"""

    name = "three_layer"
    input_scope = "economic+flow+state"

    def __init__(self, progress: ProgressCallback | None = None):
        super().__init__(progress=progress)
        from .market_data import PRODUCTION_THREE_LAYER_FEATURES
        from .state_direction_quantile_experiment import SchemeForecastEngine

        self.engine = SchemeForecastEngine(
            progress=progress,
            base_features=PRODUCTION_THREE_LAYER_FEATURES,
        )

    def _predict_fold(self, model_input: ModelInput) -> np.ndarray:
        result = self.engine.result(model_input)
        predicted_amount = result["predicted_amount"]
        return np.asarray(predicted_amount["scheme_three_layer"], dtype=float)

    def predict(self, inputs: Sequence[ModelInput]) -> ModelOutput:
        self.engine.progress = self.progress
        return self._predict_folds(inputs, self._predict_fold)


MODEL_REGISTRY: dict[str, type[ForecastModel]] = {
    "trend_persistence": TrendPersistenceModel,
    "timesfm": TimesFMModel,
    "main_regression": MainRegressionModel,
    "lightgbm": LightGBMModel,
    "three_layer": ThreeLayerModel,
}


def build_models(
    names: Sequence[str],
    progress: ProgressCallback | None = None,
    timesfm_per_core_batch_size: int = 32,
) -> list[ForecastModel]:
    """按稳定模型标识构造生产模型。"""
    unknown = set(names) - set(MODEL_REGISTRY)
    if unknown:
        raise ValueError(f"未知两融模型: {sorted(unknown)}")
    models = []
    for name in names:
        model_class = MODEL_REGISTRY[name]
        if name == "timesfm":
            models.append(
                model_class(
                    progress=progress,
                    per_core_batch_size=timesfm_per_core_batch_size,
                )
            )
        else:
            models.append(model_class(progress=progress))
    return models
