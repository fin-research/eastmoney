"""TimesFM 路径残差消融与 T+20 分段目标实验模型。"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.model_selection import GridSearchCV, TimeSeriesSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from .contracts import ModelInput
from .market_data import FLOW_DECOMPOSITION_FEATURES
from .models import ForecastModel
from .timesfm_engine import ProgressCallback, TimesFMForecastEngine

FLOW_RESIDUAL_RIDGE_ALPHAS = (
    0.01,
    0.1,
    1.0,
    10.0,
    100.0,
    300.0,
    1_000.0,
    3_000.0,
    10_000.0,
)
T20_BLOCKS = ((0, 5), (5, 10), (10, 15), (15, 20))


@dataclass(frozen=True)
class AblationSpec:
    """单个消融组合：是否加入资金流，以及是否只用最近三年。"""

    code: str
    include_flow: bool
    recent_train_years: int | None


ABLATION_SPECS = (
    AblationSpec("a", include_flow=False, recent_train_years=None),
    AblationSpec("b", include_flow=False, recent_train_years=3),
    AblationSpec("c", include_flow=True, recent_train_years=None),
    AblationSpec("d", include_flow=True, recent_train_years=3),
)


def _ridge_residual_estimator(
    n_samples: int,
    cv_gap: int,
) -> GridSearchCV:
    n_splits = min(5, max(2, n_samples // 120))
    return GridSearchCV(
        Pipeline(
            steps=[
                ("imputer", SimpleImputer(strategy="median")),
                ("scaler", StandardScaler()),
                ("model", Ridge()),
            ]
        ),
        param_grid={"model__alpha": FLOW_RESIDUAL_RIDGE_ALPHAS},
        cv=TimeSeriesSplit(n_splits=n_splits, gap=cv_gap),
        scoring="neg_mean_absolute_error",
        refit=True,
    )


class TimesFMResidualAblationModel(ForecastModel):
    """按 A/B/C/D 组合修正 TimesFM 路径残差。"""

    def __init__(
        self,
        engine: TimesFMForecastEngine,
        learner: str,
        spec: AblationSpec,
        *,
        target_mode: str = "direct",
        name_prefix: str = "ablation",
        cv_gap: int | None = None,
        progress: ProgressCallback | None = None,
    ):
        super().__init__(progress=progress)
        if learner not in {"ridge", "lightgbm"}:
            raise ValueError(f"未知残差学习器: {learner}")
        if target_mode not in {"direct", "t20_blocks"}:
            raise ValueError(f"未知目标模式: {target_mode}")
        self.engine = engine
        self.learner = learner
        self.spec = spec
        self.target_mode = target_mode
        self.name = f"{name_prefix}_{spec.code}_{learner}"
        self.input_scope = (
            "timesfm_path+economic+flow"
            if spec.include_flow
            else "timesfm_path+economic"
        )
        self.cv_gap = cv_gap

    def _feature_names(self, model_input: ModelInput) -> list[str]:
        features = list(model_input.feature_names)
        if self.spec.include_flow:
            features.extend(FLOW_DECOMPOSITION_FEATURES)
        missing = set(features) - set(model_input.train.columns)
        if missing:
            raise ValueError(f"{self.name} 缺少特征: {sorted(missing)}")
        return features

    def _training_frame(self, model_input: ModelInput) -> pd.DataFrame:
        if self.spec.recent_train_years is None:
            return model_input.train.copy()
        cutoff = model_input.evaluation.index.min() - pd.DateOffset(
            years=self.spec.recent_train_years
        )
        recent = model_input.train.loc[model_input.train.index >= cutoff].copy()
        if len(recent) < 60:
            raise ValueError(
                f"{self.name} 最近 {self.spec.recent_train_years} 年仅 "
                f"{len(recent)} 个样本，不满足最少 60 个样本。"
            )
        return recent

    def _fit_predict(
        self,
        train_x: pd.DataFrame,
        train_y: np.ndarray,
        evaluation_x: pd.DataFrame,
        cv_gap: int,
        label: str,
    ) -> np.ndarray:
        if self.learner == "ridge":
            estimator = _ridge_residual_estimator(len(train_x), cv_gap)
            estimator.fit(train_x, train_y)
            alpha = estimator.best_params_["model__alpha"]
            self._log(f"[INFO] {self.name} {label}: Ridge alpha={alpha:g}")
            return np.asarray(estimator.predict(evaluation_x), dtype=float)

        import lightgbm as lgb

        medians = train_x.median(numeric_only=True).fillna(0.0)
        estimator = lgb.LGBMRegressor(
            objective="regression",
            n_estimators=200,
            learning_rate=0.03,
            num_leaves=7,
            max_depth=3,
            min_child_samples=30,
            reg_lambda=5.0,
            n_jobs=1,
            verbosity=-1,
            random_state=42,
        )
        estimator.fit(train_x.fillna(medians), train_y)
        return np.asarray(
            estimator.predict(evaluation_x.fillna(medians)),
            dtype=float,
        )

    def _direct_prediction(
        self,
        model_input: ModelInput,
        train: pd.DataFrame,
        features: list[str],
    ) -> np.ndarray:
        horizon = model_input.horizon
        base_train = self.engine.forecast_changes(
            model_input.history,
            train.index,
            horizon,
        )
        base_evaluation = self.engine.forecast_changes(
            model_input.history,
            model_input.evaluation.index,
            horizon,
        )
        residual_pct = train[model_input.target_pct_column].to_numpy(
            dtype=float
        ) - base_train / train["market_margin"].to_numpy(dtype=float)
        predicted_residual_pct = self._fit_predict(
            train[features],
            residual_pct,
            model_input.evaluation[features],
            self.cv_gap or horizon,
            f"T+{horizon}",
        )
        return base_evaluation + predicted_residual_pct * model_input.evaluation[
            "market_margin"
        ].to_numpy(dtype=float)

    def _block_prediction(
        self,
        model_input: ModelInput,
        train: pd.DataFrame,
        features: list[str],
    ) -> np.ndarray:
        if model_input.horizon != 20:
            raise ValueError("四个五日区块目标只适用于 T+20。")
        predicted_total = np.zeros(len(model_input.evaluation), dtype=float)
        train_balance = train["market_margin"].to_numpy(dtype=float)
        evaluation_balance = model_input.evaluation["market_margin"].to_numpy(
            dtype=float
        )
        for block_number, (start, end) in enumerate(T20_BLOCKS, start=1):
            base_train = self.engine.forecast_segment_changes(
                model_input.history,
                train.index,
                start,
                end,
            )
            base_evaluation = self.engine.forecast_segment_changes(
                model_input.history,
                model_input.evaluation.index,
                start,
                end,
            )
            actual_pct = train[f"target_pct_t20_block{block_number}"].to_numpy(
                dtype=float
            )
            residual_pct = actual_pct - base_train / train_balance
            predicted_residual_pct = self._fit_predict(
                train[features],
                residual_pct,
                model_input.evaluation[features],
                self.cv_gap or 20,
                f"T+20 区块{block_number} ({start + 1}-{end}日)",
            )
            predicted_total += (
                base_evaluation + predicted_residual_pct * evaluation_balance
            )
        return predicted_total

    def _predict_fold(self, model_input: ModelInput) -> np.ndarray:
        self.engine.progress = self.progress
        train = self._training_frame(model_input)
        features = self._feature_names(model_input)
        window = (
            "Expanding"
            if self.spec.recent_train_years is None
            else f"最近{self.spec.recent_train_years}年"
        )
        self._log(
            f"[INFO] {self.name} T+{model_input.horizon} "
            f"{model_input.evaluation_year}年: {window} {len(train)} 个样本，"
            f"{len(features)} 个特征，目标={self.target_mode}"
        )
        if self.target_mode == "t20_blocks":
            return self._block_prediction(model_input, train, features)
        return self._direct_prediction(model_input, train, features)

    def predict(self, inputs):
        return self._predict_folds(inputs, self._predict_fold)


class TimesFMRidgeResidualModel(TimesFMResidualAblationModel):
    """兼容原实验标识的 D 组 Ridge 残差模型。"""

    def __init__(
        self,
        engine: TimesFMForecastEngine,
        progress: ProgressCallback | None = None,
    ):
        super().__init__(
            engine,
            "ridge",
            ABLATION_SPECS[-1],
            name_prefix="timesfm",
            progress=progress,
        )
        self.name = "timesfm_ridge_residual"


class TimesFMLightGBMResidualModel(TimesFMResidualAblationModel):
    """兼容原实验标识的 D 组 LightGBM 残差模型。"""

    def __init__(
        self,
        engine: TimesFMForecastEngine,
        progress: ProgressCallback | None = None,
    ):
        super().__init__(
            engine,
            "lightgbm",
            ABLATION_SPECS[-1],
            name_prefix="timesfm",
            progress=progress,
        )
        self.name = "timesfm_lightgbm_residual"


def build_ablation_models(
    engine: TimesFMForecastEngine,
    *,
    target_mode: str = "direct",
    name_prefix: str = "ablation",
    cv_gap: int | None = None,
    progress: ProgressCallback | None = None,
) -> list[TimesFMResidualAblationModel]:
    """构造 Ridge/LightGBM 的 A/B/C/D 八个消融模型。"""
    return [
        TimesFMResidualAblationModel(
            engine,
            learner,
            spec,
            target_mode=target_mode,
            name_prefix=name_prefix,
            cv_gap=cv_gap,
            progress=progress,
        )
        for spec in ABLATION_SPECS
        for learner in ("ridge", "lightgbm")
    ]


def build_flow_residual_challengers(
    engine: TimesFMForecastEngine,
    progress: ProgressCallback | None = None,
) -> list[TimesFMResidualAblationModel]:
    """构造原 D 组残差挑战者，保留旧实验入口兼容性。"""
    return [
        TimesFMRidgeResidualModel(engine=engine, progress=progress),
        TimesFMLightGBMResidualModel(engine=engine, progress=progress),
    ]
