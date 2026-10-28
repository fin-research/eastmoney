"""市场状态、方向分类与分位数预测三层方案。

本模块同时提供生产三层模型的共享引擎和方向/P50 消融实验入口。
生产 ``three_layer`` 使用锁定的 60 特征三层组合；单独方向层和 P50 层
继续只作实验诊断。全部模型接收标准 ``ModelInput``，共用年度切分和评价契约。
"""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from .contracts import ModelInput, ModelOutput, PipelineConfig
from .market_data import (
    CORE_ECONOMIC_FEATURES,
    DOWNSIDE_RETURN_FEATURES,
    FEATURE_LABELS,
    FLOW_DECOMPOSITION_FEATURES,
    INTERACTION_FEATURES,
    STATE_FEATURES,
)
from .models import ForecastModel, ProgressCallback, build_models
from .pipeline import run_pipeline, save_pipeline_result

SCHEME_COMPONENTS = (
    "scheme_direction_class",
    "scheme_quantile_p50",
    "scheme_three_layer",
)
SCHEME_BASE_FEATURES = CORE_ECONOMIC_FEATURES + FLOW_DECOMPOSITION_FEATURES
PRODUCTION_BASELINE_BY_HORIZON = {
    1: "main_regression",
    5: "timesfm",
    20: "timesfm",
}
DIRECTION_NAMES = np.asarray(("down", "flat", "up"), dtype=object)
CLASS_LABELS = np.asarray((-1, 0, 1), dtype=int)


def _aligned_probabilities(estimator, features: pd.DataFrame) -> np.ndarray:
    probabilities = estimator.predict_proba(features)
    aligned = np.zeros((len(features), len(CLASS_LABELS)), dtype=float)
    for source, label in enumerate(estimator.classes_):
        target = int(np.flatnonzero(CLASS_LABELS == int(label))[0])
        aligned[:, target] = probabilities[:, source]
    return aligned


def _market_state(
    frame: pd.DataFrame,
    high_volatility_threshold: float,
) -> pd.Series:
    """按方案中的趋势和波动规则识别 bull/range/bear。"""
    return_5d = frame["csi300_ret_5d"].astype(float)
    return_20d = frame["csi300_ret_20d"].astype(float)
    volatility = frame["csi300_vol_20d"].astype(float)
    high_volatility = volatility >= high_volatility_threshold
    bull = (return_5d > 0) & (return_20d > 0) & ~high_volatility
    bear = (return_20d < 0) & ((return_5d < 0) | high_volatility)
    values = np.select((bear, bull), ("bear", "bull"), default="range")
    return pd.Series(values, index=frame.index, dtype="object")


def _design_matrix(
    frame: pd.DataFrame,
    high_volatility_threshold: float,
    base_features: tuple[str, ...] = SCHEME_BASE_FEATURES,
) -> tuple[pd.DataFrame, pd.Series]:
    missing = set(base_features) - set(frame.columns)
    if missing:
        raise ValueError(f"三层方案缺少实验特征: {sorted(missing)}")

    state = _market_state(frame, high_volatility_threshold)
    features = frame.loc[:, base_features].astype(float).copy()
    state_bear, state_bull = STATE_FEATURES
    features[state_bear] = (state == "bear").astype(float)
    features[state_bull] = (state == "bull").astype(float)
    downside_ret_5d, downside_ret_20d = DOWNSIDE_RETURN_FEATURES
    features[downside_ret_5d] = features["csi300_ret_5d"].clip(upper=0)
    features[downside_ret_20d] = features["csi300_ret_20d"].clip(upper=0)
    (
        downside_volatility,
        bear_repayment_pressure,
        bear_net_flow,
    ) = INTERACTION_FEATURES
    features[downside_volatility] = (
        features[downside_ret_20d] * features["csi300_vol_20d"]
    )
    features[bear_repayment_pressure] = (
        features[state_bear] * features["financing_repayment_acceleration"]
    )
    features[bear_net_flow] = (
        features[state_bear] * features["financing_net_flow_5d_to_balance"]
    )
    return features, state


def _logistic_wald_significance(
    estimator: Pipeline,
    features: pd.DataFrame,
) -> pd.DataFrame:
    """方向层多元逻辑回归的标准化系数、标准误与 Wald 显著性。

    以第一类（下跌）为基准；系数按标准化特征（因子增加 1 个训练样本
    标准差）给出，z 统计量和 p 值来自参数协方差（Fisher 信息逆）。
    """
    from scipy import stats as _stats

    scaler = estimator.named_steps["scaler"]
    model = estimator.named_steps["model"]
    x = scaler.transform(features)
    coef = np.asarray(model.coef_, dtype=float)  # (K, p)，首行为基准类零系数
    intercept = np.asarray(model.intercept_, dtype=float)
    active_coef = coef[1:]  # (K-1, p)
    active_intercept = intercept[1:]
    class_names = [str(label) for label in model.classes_[1:]]
    n_classes, n_features = active_coef.shape

    logits = x @ active_coef.T + active_intercept
    exp = np.exp(logits - logits.max(axis=1, keepdims=True))
    denominator = 1.0 + exp.sum(axis=1, keepdims=True)
    probabilities = exp / denominator  # (n, K-1)

    information = np.zeros((n_classes * n_features, n_classes * n_features))
    for k in range(n_classes):
        for col in range(n_classes):
            weight = probabilities[:, k] * (int(k == col) - probabilities[:, col])
            block = (x * weight[:, None]).T @ x
            r0, r1 = k * n_features, (k + 1) * n_features
            c0, c1 = col * n_features, (col + 1) * n_features
            information[r0:r1, c0:c1] = block
    covariance = np.linalg.pinv(information)
    std_errors = np.sqrt(
        np.maximum(
            np.diag(covariance).reshape(n_classes, n_features),
            0.0,
        )
    )
    with np.errstate(divide="ignore", invalid="ignore"):
        z_statistics = np.divide(
            active_coef,
            std_errors,
            out=np.full_like(active_coef, np.nan),
            where=std_errors > 0,
        )
    p_values = np.full_like(z_statistics, np.nan)
    finite = np.isfinite(z_statistics)
    p_values[finite] = 2.0 * (1.0 - _stats.norm.cdf(np.abs(z_statistics[finite])))

    records = []
    for k in range(n_classes):
        for j, feature in enumerate(features.columns):
            records.append(
                {
                    "direction_class": class_names[k],
                    "feature": feature,
                    "label": FEATURE_LABELS.get(feature, feature),
                    "standardized_coefficient": float(active_coef[k, j]),
                    "std_error": float(std_errors[k, j]),
                    "z_statistic": float(z_statistics[k, j]),
                    "p_value": float(p_values[k, j]),
                }
            )
    return pd.DataFrame(records)


class SchemeForecastEngine:
    """按期限和年度折缓存三层方案的共同拟合结果。"""

    def __init__(
        self,
        progress: ProgressCallback | None = None,
        base_features: tuple[str, ...] = SCHEME_BASE_FEATURES,
    ):
        self.progress = progress
        self.base_features = base_features
        self._cache: dict[tuple[int, str, int, int], dict[str, object]] = {}

    def _log(self, message: str) -> None:
        if self.progress is not None:
            self.progress(message)

    @staticmethod
    def _lightgbm_classifier():
        import lightgbm as lgb

        return lgb.LGBMClassifier(
            objective="multiclass",
            n_estimators=200,
            learning_rate=0.03,
            num_leaves=7,
            max_depth=3,
            min_child_samples=30,
            reg_lambda=5.0,
            class_weight="balanced",
            n_jobs=1,
            verbosity=-1,
            random_state=42,
        )

    @staticmethod
    def _quantile_regressor(alpha: float):
        import lightgbm as lgb

        return lgb.LGBMRegressor(
            objective="quantile",
            alpha=alpha,
            n_estimators=250,
            learning_rate=0.03,
            num_leaves=7,
            max_depth=3,
            min_child_samples=30,
            reg_lambda=5.0,
            n_jobs=1,
            verbosity=-1,
            random_state=42,
        )

    @staticmethod
    def _direction_labels(target: pd.Series, threshold: float) -> np.ndarray:
        return np.select(
            (
                target.to_numpy(dtype=float) < -threshold,
                target.to_numpy(dtype=float) > threshold,
            ),
            (-1, 1),
            default=0,
        ).astype(int)

    def _fit_fold(self, model_input: ModelInput) -> dict[str, object]:
        target = model_input.train[model_input.target_pct_column].astype(float)
        threshold = float(target.abs().quantile(0.25))
        if not np.isfinite(threshold) or threshold <= 0:
            raise ValueError("三层方案无法从训练集确定正的动态平稳阈值。")

        volatility_threshold = float(model_input.train["csi300_vol_20d"].quantile(0.75))
        train_x, _ = _design_matrix(
            model_input.train,
            volatility_threshold,
            self.base_features,
        )
        evaluation_x, evaluation_state = _design_matrix(
            model_input.evaluation,
            volatility_threshold,
            self.base_features,
        )
        medians = train_x.median(numeric_only=True).fillna(0.0)
        train_x = train_x.fillna(medians).fillna(0.0)
        evaluation_x = evaluation_x.fillna(medians).fillna(0.0)
        direction = self._direction_labels(target, threshold)

        logistic = Pipeline(
            steps=[
                ("scaler", StandardScaler()),
                (
                    "model",
                    LogisticRegression(
                        class_weight="balanced",
                        max_iter=2_000,
                        random_state=42,
                    ),
                ),
            ]
        )
        logistic.fit(train_x, direction)
        logistic_probabilities = _aligned_probabilities(logistic, evaluation_x)
        logistic_coefficients = _logistic_wald_significance(logistic, train_x)

        classifier = self._lightgbm_classifier()
        classifier.fit(train_x, direction)
        lightgbm_probabilities = _aligned_probabilities(classifier, evaluation_x)
        probabilities = (logistic_probabilities + lightgbm_probabilities) / 2

        quantile_predictions = []
        for alpha in (0.25, 0.5, 0.75):
            estimator = self._quantile_regressor(alpha)
            estimator.fit(train_x, target)
            quantile_predictions.append(estimator.predict(evaluation_x))
        quantiles = np.sort(np.column_stack(quantile_predictions), axis=1)

        fallback_medians = np.quantile(target.to_numpy(dtype=float), (0.25, 0.5, 0.75))
        class_medians = []
        for class_position, class_label in enumerate(CLASS_LABELS):
            values = target.to_numpy(dtype=float)[direction == class_label]
            class_medians.append(
                float(np.median(values))
                if len(values)
                else float(fallback_medians[class_position])
            )
        class_medians_array = np.asarray(class_medians, dtype=float)

        predicted_pct = {
            "scheme_direction_class": probabilities @ class_medians_array,
            "scheme_quantile_p50": quantiles[:, 1],
            "scheme_three_layer": np.sum(probabilities * quantiles, axis=1),
        }
        origin_balance = model_input.evaluation["market_margin"].to_numpy(dtype=float)
        predicted_amount = {
            name: values * origin_balance for name, values in predicted_pct.items()
        }
        predicted_class = DIRECTION_NAMES[np.argmax(probabilities, axis=1)]
        diagnostics = pd.DataFrame(
            {
                "fold": model_input.fold,
                "evaluation_set": model_input.evaluation_set,
                "evaluation_year": model_input.evaluation_year,
                "horizon": model_input.horizon,
                "origin_date": model_input.evaluation.index,
                "market_state": evaluation_state.to_numpy(),
                "predicted_direction_class": predicted_class,
                "flat_threshold_pct": threshold,
                "probability_down": probabilities[:, 0],
                "probability_flat": probabilities[:, 1],
                "probability_up": probabilities[:, 2],
                "actual_change": model_input.evaluation[
                    model_input.target_amount_column
                ].to_numpy(dtype=float),
                "origin_balance": origin_balance,
                "p25_change": quantiles[:, 0] * origin_balance,
                "p50_change": quantiles[:, 1] * origin_balance,
                "p75_change": quantiles[:, 2] * origin_balance,
                **predicted_amount,
            }
        )
        self._log(
            f"[INFO] scheme_engine T+{model_input.horizon} "
            f"{model_input.evaluation_year}年拟合完成: "
            f"平稳阈值={threshold:.4%}, "
            f"bear/range/bull="
            f"{(evaluation_state == 'bear').sum()}/"
            f"{(evaluation_state == 'range').sum()}/"
            f"{(evaluation_state == 'bull').sum()}"
        )
        return {
            "predicted_amount": predicted_amount,
            "diagnostics": diagnostics,
            "logistic_coefficients": logistic_coefficients,
        }

    def result(self, model_input: ModelInput) -> dict[str, object]:
        key = (
            model_input.horizon,
            model_input.evaluation_set,
            model_input.evaluation_year,
            model_input.fold,
        )
        if key not in self._cache:
            self._cache[key] = self._fit_fold(model_input)
        return self._cache[key]

    @property
    def diagnostics(self) -> pd.DataFrame:
        if not self._cache:
            return pd.DataFrame()
        frames = [value["diagnostics"] for value in self._cache.values()]
        return pd.concat(frames, ignore_index=True).sort_values(
            ["horizon", "evaluation_set", "evaluation_year", "origin_date"]
        )

    @property
    def coefficient_history(self) -> pd.DataFrame:
        """方向层逻辑回归系数与显著性，按折标注期限/评估集/年份。"""
        if not self._cache:
            return pd.DataFrame()
        frames = []
        for key, value in self._cache.items():
            horizon, evaluation_set, evaluation_year, fold = key
            frame = value["logistic_coefficients"].copy()
            frame["horizon"] = int(horizon)
            frame["evaluation_set"] = evaluation_set
            frame["evaluation_year"] = int(evaluation_year)
            frame["fold"] = int(fold)
            frames.append(frame)
        if not frames:
            return pd.DataFrame()
        return pd.concat(frames, ignore_index=True)


class SchemeForecastModel(ForecastModel):
    """三层方案单个组件的标准模型门面。"""

    input_scope = "economic+flow+state"

    def __init__(
        self,
        component: str,
        engine: SchemeForecastEngine,
        progress: ProgressCallback | None = None,
        model_name: str | None = None,
    ):
        if component not in SCHEME_COMPONENTS:
            raise ValueError(f"未知三层方案组件: {component}")
        super().__init__(progress=progress)
        self.component = component
        self.name = model_name or component
        self.engine = engine

    def _predict_fold(self, model_input: ModelInput) -> np.ndarray:
        result = self.engine.result(model_input)
        values = result["predicted_amount"]
        return np.asarray(values[self.component], dtype=float)

    def predict(self, inputs: Sequence[ModelInput]) -> ModelOutput:
        self.engine.progress = self.progress
        return self._predict_folds(inputs, self._predict_fold)


def build_scheme_models(
    progress: ProgressCallback | None = None,
    base_features: tuple[str, ...] = SCHEME_BASE_FEATURES,
    name_prefix: str | None = None,
) -> list[SchemeForecastModel]:
    engine = SchemeForecastEngine(progress=progress, base_features=base_features)
    return [
        SchemeForecastModel(
            component,
            engine,
            progress=progress,
            model_name=(
                f"{name_prefix}_{component.removeprefix('scheme_')}"
                if name_prefix
                else component
            ),
        )
        for component in SCHEME_COMPONENTS
    ]


def _simple_metrics(frame: pd.DataFrame, predicted_column: str) -> dict[str, float]:
    actual = frame["actual_change"].to_numpy(dtype=float)
    predicted = frame[predicted_column].to_numpy(dtype=float)
    balance = frame["origin_balance"].to_numpy(dtype=float)
    absolute_error = np.abs(predicted - actual)
    direction_mask = actual != 0
    return {
        "samples": int(len(frame)),
        "direction_accuracy": float(
            (
                np.sign(predicted[direction_mask]) == np.sign(actual[direction_mask])
            ).mean()
        ),
        "mae": float(absolute_error.mean()),
        "relative_error_pct": float((absolute_error / balance).mean() * 100),
    }


def evaluate_scheme_diagnostics(
    diagnostics: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """汇总三层组合的状态表现及 P25-P75 区间诊断。"""
    regime_records = []
    interval_records = []
    grouped = diagnostics.groupby(["evaluation_set", "horizon"], sort=False)
    for (evaluation_set, horizon), frame in grouped:
        covered = (frame["actual_change"] >= frame["p25_change"]) & (
            frame["actual_change"] <= frame["p75_change"]
        )
        interval_records.append(
            {
                "evaluation_set": evaluation_set,
                "horizon": int(horizon),
                "samples": int(len(frame)),
                "p25_p75_coverage": float(covered.mean()),
                "mean_interval_width": float(
                    (frame["p75_change"] - frame["p25_change"]).mean()
                ),
            }
        )
        for state, state_frame in frame.groupby("market_state", sort=False):
            regime_records.append(
                {
                    "evaluation_set": evaluation_set,
                    "horizon": int(horizon),
                    "market_state": state,
                    **_simple_metrics(state_frame, "scheme_three_layer"),
                }
            )
    return pd.DataFrame(regime_records), pd.DataFrame(interval_records)


def assess_production_upgrade(
    predictions: pd.DataFrame,
    challenger_names: Sequence[str] = SCHEME_COMPONENTS,
) -> pd.DataFrame:
    """按既定四项历史验证门槛比较三个方案组件。"""
    validation = predictions[predictions["evaluation_set"] == "validation"].copy()
    records = []
    for horizon, baseline_name in PRODUCTION_BASELINE_BY_HORIZON.items():
        baseline = validation[
            (validation["horizon"] == horizon) & (validation["model"] == baseline_name)
        ]
        if baseline.empty:
            continue
        baseline_metrics = _simple_metrics(baseline, "predicted_change")
        baseline_yearly = (
            baseline.assign(
                absolute_error=(
                    baseline["predicted_change"] - baseline["actual_change"]
                ).abs()
            )
            .groupby("evaluation_year")["absolute_error"]
            .mean()
        )
        for challenger_name in challenger_names:
            challenger = validation[
                (validation["horizon"] == horizon)
                & (validation["model"] == challenger_name)
            ]
            if challenger.empty:
                continue
            challenger_metrics = _simple_metrics(challenger, "predicted_change")
            challenger_yearly = (
                challenger.assign(
                    absolute_error=(
                        challenger["predicted_change"] - challenger["actual_change"]
                    ).abs()
                )
                .groupby("evaluation_year")["absolute_error"]
                .mean()
            )
            aligned = pd.concat(
                {"baseline": baseline_yearly, "challenger": challenger_yearly},
                axis=1,
                join="inner",
            )
            mae_improvement_pct = (
                1 - challenger_metrics["mae"] / baseline_metrics["mae"]
            ) * 100
            direction_change_pp = (
                challenger_metrics["direction_accuracy"]
                - baseline_metrics["direction_accuracy"]
            ) * 100
            improved_years = int((aligned["challenger"] < aligned["baseline"]).sum())
            worst_year_ratio = float(
                aligned["challenger"].max() / aligned["baseline"].max()
            )
            passes = (
                mae_improvement_pct >= 5
                and improved_years >= 3
                and worst_year_ratio <= 1.05
                and direction_change_pp >= -2
            )
            records.append(
                {
                    "horizon": horizon,
                    "baseline": baseline_name,
                    "challenger": challenger_name,
                    "baseline_mae": baseline_metrics["mae"],
                    "challenger_mae": challenger_metrics["mae"],
                    "mae_improvement_pct": mae_improvement_pct,
                    "improved_years": improved_years,
                    "validation_years": int(len(aligned)),
                    "worst_year_mae_ratio": worst_year_ratio,
                    "direction_change_pp": direction_change_pp,
                    "passes_upgrade_threshold": passes,
                }
            )
    return pd.DataFrame(records)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="按标准两融年度切分评估市场状态+方向分类+分位数方案",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="保存标准结果、方案诊断和升级判定的目录",
    )
    parser.add_argument(
        "--skip-timesfm",
        action="store_true",
        help="仅供快速诊断；正式升级比较不得跳过 TimesFM",
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
    scheme_models = build_scheme_models()
    models.extend(scheme_models)
    config = PipelineConfig(models=tuple(model.name for model in models))
    result = run_pipeline(config=config, models=models)
    save_pipeline_result(result, args.output_dir)

    diagnostics = scheme_models[0].engine.diagnostics
    regime_metrics, interval_metrics = evaluate_scheme_diagnostics(diagnostics)
    upgrade = assess_production_upgrade(result.predictions)
    diagnostics.to_csv(args.output_dir / "scheme_diagnostics.csv", index=False)
    regime_metrics.to_csv(args.output_dir / "scheme_regime_metrics.csv", index=False)
    interval_metrics.to_csv(
        args.output_dir / "scheme_interval_metrics.csv", index=False
    )
    upgrade.to_csv(args.output_dir / "scheme_upgrade_assessment.csv", index=False)
    print("[RESULT] 三层方案生产升级判定", flush=True)
    if upgrade.empty:
        print("[INFO] 缺少正式生产基准，未执行升级判定。", flush=True)
    else:
        print(upgrade.to_string(index=False), flush=True)
    print(
        "[INFO] 已保存 scheme_diagnostics.csv、scheme_regime_metrics.csv、"
        "scheme_interval_metrics.csv、scheme_upgrade_assessment.csv",
        flush=True,
    )


if __name__ == "__main__":
    cli()
