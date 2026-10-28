"""Joint future-cost curves with a fixed low-rank horizon basis.

Fits future minus same-day financing costs, using only pre-origin features.
Shared rate estimators supply the regression; horizons share three shape factors.
"""

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from data.rate_data import horizon_labels, purged_training_index
from .rate_forecast import RateCandidate, candidate_features, fit_rate_candidate


@dataclass(frozen=True)
class CurveCandidate(RateCandidate):
    pass


CURVE_CANDIDATES = (
    CurveCandidate("curve_zero", "zero"),
    CurveCandidate("curve_drift", "mean"),
    CurveCandidate("curve_ridge_local_1000", "ridge", "local", 1000),
    CurveCandidate("curve_ridge_local_10000", "ridge", "local", 10000),
    CurveCandidate("curve_ridge_all_1000", "ridge", "all", 1000),
    CurveCandidate("curve_ridge_all_10000", "ridge", "all", 10000),
    CurveCandidate("curve_lgb_local", "lgb", "local"),
    CurveCandidate("curve_lgb_all", "lgb", "all"),
    CurveCandidate("curve_short_lgb", "short_lgb", "local"),
    CurveCandidate("curve_short_cdb", "short_lgb", "local_cdb"),
)


def horizon_basis(days):
    if isinstance(days, bool) or not isinstance(days, int) or not 7 <= days <= 90:
        raise ValueError("joint curve window must be 7..90 calendar days")
    x = np.arange(days + 1) / days
    return np.column_stack([x, x * (1 - x), x * (1 - x) * (x - 0.5)])


def curve_labels(data, days=30, target="AAA_3Y"):
    max_h = max(30, days)
    labels = horizon_labels(data, target, days, max_horizon=max_h).copy()
    immediate = horizon_labels(data, target, 0).target_bp.reindex(labels.index)
    matrices = []
    for h in range(days + 1):
        future = horizon_labels(data, target, h, max_horizon=max_h).reindex(
            labels.index
        )
        matrices.append((future.target_bp - immediate).to_numpy())
        labels[f"executable_{h}"] = (
            future.label_end == labels.index + pd.Timedelta(days=h)
        ) & ((labels.index + pd.Timedelta(days=h)).dayofweek < 5)
    costs = pd.DataFrame(
        np.column_stack(matrices), index=labels.index, columns=np.arange(days + 1)
    )
    if not np.isfinite(costs).all().all():
        raise ValueError("future-cost curve labels must be complete")
    # Historical quote weekdays are an explicit issuance-calendar proxy.
    eligible = labels.index.dayofweek < 5
    return labels.loc[eligible], costs.loc[eligible]


def fit_curve(data, labels, costs, cutoff, candidate, target="AAA_3Y"):
    train = purged_training_index(labels, cutoff)
    train = train[train >= cutoff - pd.DateOffset(years=5)]
    if len(train) < 500:
        raise ValueError("joint curve requires 500 mature quote origins")
    basis = horizon_basis(costs.shape[1] - 1)
    feature_set = (
        "credit"
        if target == "CREDIT_3Y" and candidate.feature_set == "local"
        else candidate.feature_set
    )
    columns = candidate_features(data.features, target, feature_set)
    X = data.features.loc[train, columns]
    # Projection is per-origin, so no future observation can affect earlier fits.
    coefficients = costs.loc[train].to_numpy() @ np.linalg.pinv(basis.T)
    if candidate.kind == "short_lgb":
        estimator = RateCandidate(candidate.name, "lgb", candidate.feature_set)
        models = {
            "horizons": [1, 3, 5],
            "models": [
                fit_rate_candidate(estimator, X, costs.loc[train, h]) for h in (1, 3, 5)
            ],
        }
    elif candidate.kind == "zero":
        models = np.zeros(3)
    elif candidate.kind == "mean":
        models = coefficients.mean(axis=0)
    elif candidate.kind == "ridge":
        models = fit_rate_candidate(candidate, X, coefficients)
    else:
        models = [
            fit_rate_candidate(candidate, X, coefficients[:, k]) for k in range(3)
        ]
    return {
        "models": models,
        "basis": basis,
        "columns": columns,
        "candidate": candidate,
        "train_samples": len(train),
        "train_deadline_max": labels.loc[train, "deadline"].max(),
        "background": X,
    }


def predict_curve(fit, features):
    X = features[fit["columns"]]
    models = fit["models"]
    if isinstance(models, dict):
        anchors = np.column_stack(
            [np.zeros(len(X)), *[m.predict(X) for m in models["models"]]]
        )
        return np.array(
            [
                np.interp(np.arange(len(fit["basis"])), [0, *models["horizons"]], row)
                for row in anchors
            ]
        )
    if isinstance(models, np.ndarray):
        factors = np.tile(models, (len(X), 1))
    elif isinstance(models, list):
        factors = np.column_stack([m.predict(X) for m in models])
    else:
        factors = models.predict(X)
    return factors @ fit["basis"].T


def explain_curve(fit, features, horizon):
    """Exact model SHAP for the selected linear combination of curve factors.

    Linear models use the interventional independent-feature expectation; trees
    use path-dependent TreeSHAP. Both are explanations, not causal attributions.
    """
    X = features[fit["columns"]]
    weights = fit["basis"][horizon]
    models = fit["models"]
    names = fit["columns"]
    if isinstance(models, dict):
        knots = [0, *models["horizons"]]
        weights = np.array(
            [np.interp(horizon, knots, np.eye(4)[k]) for k in range(1, 4)]
        )
        factors = np.vstack(
            [m.booster_.predict(X, pred_contrib=True)[0] for m in models["models"]]
        )
        combined = weights @ factors
        contributions, baseline = combined[:-1], float(combined[-1])
        method = "tree_path_dependent"
    elif isinstance(models, np.ndarray):
        contributions = np.zeros(len(names))
        baseline = float(models @ weights)
        method = "constant_model"
    elif isinstance(models, list):
        factors = np.vstack(
            [m.booster_.predict(X, pred_contrib=True)[0] for m in models]
        )
        combined = weights @ factors
        contributions, baseline = combined[:-1], float(combined[-1])
        method = "tree_path_dependent"
    else:
        transform = models[:-1]
        transformed = transform.transform(X)[0]
        expected = transform.transform(fit["background"]).mean(axis=0)
        estimator = models[-1]
        coefficient = weights @ estimator.coef_
        contributions = coefficient * (transformed - expected)
        baseline = float(weights @ estimator.intercept_ + coefficient @ expected)
        method = "linear_interventional_independent_features"
    prediction = float(predict_curve(fit, features)[0, horizon])
    if not np.isclose(baseline + contributions.sum(), prediction, atol=1e-7):
        raise ValueError("curve SHAP additivity failed")
    return {
        "method": method,
        "unit": "bp",
        "target": "future_minus_current_cost",
        "base_bp": baseline,
        "prediction_bp": prediction,
        "features": [
            {"feature": name, "shap_bp": float(value)}
            for name, value in zip(names, contributions, strict=True)
        ],
    }


def score_curve_paths(
    labels, costs, predicted, name, cutoff, waiting_cost=0.0, outcome_costs=None
):
    horizon = costs.shape[1] - 1
    net = predicted + np.arange(horizon + 1) * waiting_cost
    allowed = labels[[f"executable_{h}" for h in range(horizon + 1)]].to_numpy(
        dtype=bool
    )
    net = np.where(allowed, net, np.inf)
    # Earliest date within 0.5bp of the predicted minimum avoids false precision.
    selected = (net <= net.min(axis=1, keepdims=True) + 0.5).argmax(axis=1)
    realized_path = costs if outcome_costs is None else outcome_costs
    actual = realized_path.to_numpy() + np.arange(horizon + 1) * waiting_cost
    row = np.arange(len(costs))
    realized = actual[row, selected]
    best_actual = np.where(allowed, actual, np.inf).min(axis=1)
    day_grid = np.arange(horizon + 1)
    week = np.where(allowed & (day_grid <= 7), day_grid, 0).max(axis=1)
    deadline = np.where(allowed, day_grid, 0).max(axis=1)
    frame = pd.DataFrame(
        {
            "origin": labels.index,
            "deadline": labels.deadline.to_numpy(),
            "fold": cutoff,
            "policy": name,
            "selected_horizon": selected,
            "predicted_selected_bp": net[row, selected],
            "realized_cost_bp": realized,
            "objective_realized_bp": costs.to_numpy()[row, selected],
            "regret_bp": realized - best_actual,
            "integrated_mae_bp": np.abs(predicted - costs.to_numpy()).mean(axis=1),
            "path_opportunity_bp": -best_actual,
            "baseline_0_bp": actual[:, 0],
            "baseline_7_bp": actual[row, week],
            f"baseline_{horizon}_bp": actual[row, deadline],
            "baseline_7_horizon": week,
            f"baseline_{horizon}_horizon": deadline,
            "chosen_horizon": selected,
            "action_bucket": np.where(
                selected == 0, 0, np.where(selected <= 7, 7, horizon)
            ),
        }
    )
    return frame


def evaluate_curves(
    data,
    *,
    days=30,
    start="2013-01-01",
    waiting_cost=0.0,
    target="AAA_3Y",
    path_directory=None,
):
    from .timing_policy import select_policy

    labels, costs = curve_labels(data, days, target)
    _, outcomes = curve_labels(data, days, "AAA_3Y")
    records, choices = [], []
    for cutoff in pd.date_range(start, labels.index.max(), freq="QS"):
        stop = cutoff + pd.offsets.QuarterBegin(startingMonth=1)
        test = labels.loc[(labels.index >= cutoff) & (labels.index < stop)]
        if test.empty:
            continue
        X, Y = data.features.loc[test.index], costs.loc[test.index]
        frames, forecasts = [], []
        for candidate in CURVE_CANDIDATES:
            fit = fit_curve(data, labels, costs, cutoff, candidate, target)
            predicted = predict_curve(fit, X)
            forecasts.append(predicted)
            frame = score_curve_paths(
                test,
                Y,
                predicted,
                candidate.name,
                cutoff,
                waiting_cost,
                outcomes.loc[test.index],
            )
            frame["train_deadline_max"] = fit["train_deadline_max"]
            frame["train_samples"] = fit["train_samples"]
            frames.append(frame)
        averaged = np.mean(forecasts[2:], axis=0)
        frames.append(
            score_curve_paths(
                test,
                Y,
                averaged,
                "curve_ensemble",
                cutoff,
                waiting_cost,
                outcomes.loc[test.index],
            )
        )
        if path_directory is not None:
            directory = Path(path_directory)
            directory.mkdir(parents=True, exist_ok=True)
            np.savez_compressed(
                directory / f"{cutoff.date()}.npz",
                origins=test.index.asi8,
                forecasts=np.stack([*forecasts, averaged]),
                names=np.array([c.name for c in CURVE_CANDIDATES] + ["curve_ensemble"]),
                target_costs=Y.to_numpy(),
                funding_costs=outcomes.loc[test.index].to_numpy(),
                executable=test[[f"executable_{h}" for h in range(days + 1)]].to_numpy(
                    bool
                ),
            )
        template = frames[0]
        for h in dict.fromkeys((0, 7, days)):
            name = f"fixed_{h}"
            frame = template.copy()
            frame["policy"] = name
            frame["selected_horizon"] = 0 if h == 0 else frame[f"baseline_{h}_horizon"]
            frame["chosen_horizon"] = frame.selected_horizon
            frame["action_bucket"] = h
            frame["realized_cost_bp"] = frame[f"baseline_{h}_bp"]
            frame["regret_bp"] = frame.realized_cost_bp + frame.path_opportunity_bp
            frames.append(frame)
        current = pd.concat(frames, ignore_index=True)
        previous = pd.concat(records, ignore_index=True) if records else pd.DataFrame()
        # Two years cannot hold twelve nonoverlapping 60/90-day windows.
        selection_years = max(2, int(np.ceil(days * 13 / 365)) + 1)
        selected, count, last = (
            select_policy(previous, cutoff, lookback_years=selection_years)
            if records
            else ("fixed_7", 0, None)
        )
        selected_frame = current.loc[current.policy.eq(selected)].copy()
        selected_frame["selected_policy"] = selected
        selected_frame["policy"] = "nested_cost_policy"
        records.append(pd.concat([current, selected_frame], ignore_index=True))
        choices.append(
            {
                "fold": cutoff,
                "selected_policy": selected,
                "selection_windows": count,
                "selection_latest_deadline": last,
            }
        )
        print(f"[curve] {cutoff.date()}: {selected}; {len(test)} origins", flush=True)
    return pd.concat(records, ignore_index=True), pd.DataFrame(choices)
