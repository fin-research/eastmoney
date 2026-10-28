"""利率直接预测候选模型。所有预处理仅在单次训练样本内拟合。"""

from dataclasses import dataclass

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .conditional_drift import CONDITIONAL_FEATURES, fit_conditional_drift
from data.rate_data import purged_training_index


@dataclass(frozen=True)
class RateCandidate:
    name: str
    kind: str
    feature_set: str = "all"
    alpha: float = 1000.0
    lookback_years: int | None = None
    shrinkage: float = 1.0
    anchor_horizon: int | None = None
    drift_extension: bool = False
    calendar_clock: bool = False
    monthly_fit: bool = False


# 先登记有限候选再看开发结果；2026 留出集不得用于选择这些参数。
RATE_CANDIDATES = (
    RateCandidate("random_walk", "zero"),
    RateCandidate("historical_drift", "mean", lookback_years=3),
    RateCandidate("conditional_drift", "conditional", "regime", lookback_years=3),
    RateCandidate("recent_drift", "mean", lookback_years=1),
    RateCandidate("robust_drift", "median", lookback_years=3),
    RateCandidate(
        "smooth_conditional_drift",
        "ridge",
        "smooth_regime",
        alpha=1000,
        lookback_years=3,
    ),
    RateCandidate("ridge_local_100", "ridge", "local", 100),
    RateCandidate("ridge_local_1000", "ridge", "local", 1000),
    RateCandidate("ridge_all_1000", "ridge", "all", 1000),
    RateCandidate("ridge_all_10000", "ridge", "all", 10000),
    RateCandidate("ridge_recent_1000", "ridge", "all", 1000, 3),
    RateCandidate("ridge_shrink_1000", "ridge", "all", 1000, None, 0.25),
    RateCandidate("lgb_shallow", "lgb", "all"),
    RateCandidate("lgb_recent", "lgb", "all", lookback_years=3),
    RateCandidate("lgb_shrink", "lgb", "all", shrinkage=0.25),
    RateCandidate("lgb_anchor_1", "lgb", anchor_horizon=1),
    RateCandidate("lgb_anchor_5", "lgb", anchor_horizon=5),
    RateCandidate("ridge_anchor_5", "ridge", alpha=10000, anchor_horizon=5),
    RateCandidate("lgb_anchor_drift", "lgb", anchor_horizon=1, drift_extension=True),
)

# Only the issuance forecaster implements calendar-day and frozen-fit semantics.
# Do not expose these to the older quote-clock research evaluator.
ISSUANCE_CHALLENGERS = (
    RateCandidate(
        "lgb_anchor_monthly",
        "lgb",
        anchor_horizon=1,
        drift_extension=True,
        monthly_fit=True,
    ),
    # Fixed challengers: direct calendar-horizon targets, monthly frozen fits.
    # No long-horizon historical drift is added to their predictions.
    RateCandidate("direct_lgb", "lgb", calendar_clock=True, monthly_fit=True),
    RateCandidate(
        "direct_lgb_shrink",
        "lgb",
        shrinkage=0.25,
        calendar_clock=True,
        monthly_fit=True,
    ),
    RateCandidate(
        "direct_ridge_shrink",
        "ridge",
        alpha=10000,
        shrinkage=0.25,
        calendar_clock=True,
        monthly_fit=True,
    ),
)


def candidate_features(
    features: pd.DataFrame, target: str, feature_set: str
) -> list[str]:
    if feature_set == "local_cdb":
        return candidate_features(features, target, "local") + [
            name for name in features if name.startswith("micro_cdb3")
        ]
    if feature_set == "all":
        return list(features.columns)
    if feature_set == "credit":
        return [
            name
            for name in features
            if name.startswith("credit_spread")
            or name
            in (
                "term_spread",
                "curve_curvature",
                "decision_weekday",
                "decision_month_end",
                "dr007_vs_policy",
                "r007_dr007_spread",
            )
        ]
    if feature_set == "regime":
        return list(CONDITIONAL_FEATURES)
    if feature_set == "smooth_regime":
        return [
            *CONDITIONAL_FEATURES,
            "credit_spread",
            "short_term_spread",
            "term_spread",
        ]
    prefix = "rate_aaa_3y" if target == "AAA_3Y" else "rate_gov_3y"
    return [
        name
        for name in features
        if name.startswith(prefix)
        or name
        in ("credit_spread", "term_spread", "dr007_vs_policy", "decision_weekday")
    ]


def candidate_training_index(labels, cutoff, candidate):
    available = purged_training_index(labels, cutoff)
    selected = available
    if candidate.lookback_years:
        selected = available[
            available >= cutoff - pd.DateOffset(years=candidate.lookback_years)
        ]
    # A calendar year can contain fewer than 240 mature quote labels. Keep the
    # fixed eligibility floor and full evaluation denominator via a registered
    # 3-year fallback, rather than dropping these origins or lowering the floor.
    if candidate.name == "recent_drift" and len(selected) < 240:
        selected = available[available >= cutoff - pd.DateOffset(years=3)]
    if len(selected) < 240:
        raise ValueError("insufficient mature market training labels")
    return selected


def fit_rate_candidate(candidate: RateCandidate, X: pd.DataFrame, y: pd.Series):
    if candidate.kind == "zero":
        return 0.0
    if candidate.kind == "mean":
        return float(y.mean())
    if candidate.kind == "median":
        return float(y.median())
    if candidate.kind == "conditional":
        return fit_conditional_drift(X, y)
    if candidate.kind == "ridge":
        model = make_pipeline(
            SimpleImputer(strategy="median", keep_empty_features=True),
            StandardScaler(),
            Ridge(alpha=candidate.alpha),
        )
    elif candidate.kind == "lgb":
        model = lgb.LGBMRegressor(
            n_estimators=120,
            num_leaves=7,
            max_depth=3,
            learning_rate=0.025,
            min_child_samples=80,
            reg_lambda=20,
            reg_alpha=1,
            colsample_bytree=0.8,
            random_state=20260921,
            n_jobs=1,
            verbosity=-1,
        )
    else:
        raise ValueError(f"unknown candidate kind: {candidate.kind}")
    model.fit(X, y)
    return model


def predict_rate_candidate(
    model, X: pd.DataFrame, candidate: RateCandidate
) -> np.ndarray:
    prediction = np.full(len(X), model) if np.isscalar(model) else model.predict(X)
    return np.asarray(prediction, dtype=float) * candidate.shrinkage
