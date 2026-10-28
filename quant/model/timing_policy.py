"""Decision-focused, purged walk-forward research on financing cost differences.

The target is future quotation minus the decision day's quotation, not the
previous close. All regressors and features reuse the existing rate model
registry. These are market proxy actions, never realized issuer savings.
"""

from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd

from data.rate_data import horizon_labels, purged_training_index
from .rate_forecast import (
    RateCandidate,
    candidate_features,
    fit_rate_candidate,
    predict_rate_candidate,
)


ACTION_HORIZONS = (0, 7, 30)
ACTION_NAMES = ("当日发行", "第7日发行", "第30日发行")


@dataclass(frozen=True)
class TimingCandidate(RateCandidate):
    normalize_volatility: bool = False


TIMING_CANDIDATES = (
    RateCandidate("cost_drift", "mean", lookback_years=3),
    RateCandidate("cost_ridge_regime_100", "ridge", "smooth_regime", 100, 3),
    RateCandidate("cost_ridge_regime_1000", "ridge", "smooth_regime", 1000, 3),
    RateCandidate("cost_ridge_local_1000", "ridge", "local", 1000, 3),
    RateCandidate("cost_ridge_all_1000", "ridge", "all", 1000, 3),
    RateCandidate("cost_ridge_all_10000", "ridge", "all", 10000, 3),
    RateCandidate("cost_lgb_local", "lgb", "local", lookback_years=3),
    RateCandidate("cost_lgb_all", "lgb", "all", lookback_years=3),
    TimingCandidate(
        "cost_scaled_ridge_regime",
        "ridge",
        "smooth_regime",
        100,
        3,
        normalize_volatility=True,
    ),
    TimingCandidate(
        "cost_scaled_ridge_local", "ridge", "local", 1000, 3, normalize_volatility=True
    ),
    TimingCandidate(
        "cost_scaled_lgb_local",
        "lgb",
        "local",
        lookback_years=3,
        normalize_volatility=True,
    ),
    TimingCandidate(
        "cost_scaled_lgb_all", "lgb", "all", lookback_years=3, normalize_volatility=True
    ),
)
ACTION_MARGINS = (0.0, 2.0)
FALLBACK_POLICY = "fixed_7"


def timing_protocol():
    return {
        "version": "timing-cost-v2",
        "target": "AAA3Y future minus same-origin day quote, bp",
        "actions": dict(zip(ACTION_NAMES, ACTION_HORIZONS, strict=True)),
        "candidates": [asdict(c) for c in TIMING_CANDIDATES],
        "margins_bp": ACTION_MARGINS,
        "ensembles": "fixed equal-weight raw non-drift models and fixed equal-weight volatility-normalized models",
        "scale": "lagged 20-quote AAA3Y daily volatility, floor 0.25bp, multiplied by sqrt(21)",
        "training": "quarterly frozen; past three years; all 30-day labels mature",
        "selection": "past two years of mature OOS costs; fixed chronological nonoverlap windows; at least 12 windows; lowest mean cost",
        "fallback": FALLBACK_POLICY,
        "primary_test": "nested policy vs fixed 0/7/30; 2022-2025 development and observed 2026 separately",
        "inference": "31 and 63 quote-row blocks and nonoverlap three-window blocks; Holm family includes all comparisons",
        "scope": "historical market-proxy research; all dates through 2026-09-21 previously observed; not issuer execution alpha",
    }


def action_labels(data):
    """Complete common target cohort, with one 30-day maturity clock for all actions."""
    labels = horizon_labels(data, "AAA_3Y", 30).copy()
    immediate = horizon_labels(data, "AAA_3Y", 0).target_bp.reindex(labels.index)
    for horizon in ACTION_HORIZONS:
        future = horizon_labels(data, "AAA_3Y", horizon).reindex(labels.index)
        labels[f"cost_{horizon}"] = future.target_bp - immediate
        labels[f"date_{horizon}"] = future.label_end
    if not np.isfinite(labels[[f"cost_{h}" for h in ACTION_HORIZONS]]).all().all():
        raise ValueError("incomplete common action labels")
    return labels


def choose_actions(predictions, elapsed_days, waiting_cost=0.0, margin=0.0):
    """Choose using forecasts alone; a prespecified near tie keeps the 7-day plan."""
    prediction = np.asarray(predictions, dtype=float)
    days = np.asarray(elapsed_days, dtype=float)
    if (
        prediction.ndim != 2
        or prediction.shape[1] != 3
        or days.shape != prediction.shape
    ):
        raise ValueError("three complete action forecasts and matching days required")
    if not np.isfinite(prediction).all() or not np.isfinite(days).all():
        raise ValueError("nonfinite action input")
    if not np.isfinite(waiting_cost) or waiting_cost < 0 or margin < 0:
        raise ValueError("invalid waiting cost or action margin")
    costs = prediction + days * waiting_cost
    best = costs.argmin(axis=1)
    near_tie = costs[:, 1] - costs[np.arange(len(costs)), best] <= margin
    return np.where(near_tie, 1, best)


def nonoverlap_indices(frame):
    selected, deadline = [], pd.Timestamp.min
    for index, row in frame.sort_values("origin").iterrows():
        if row.origin > deadline:
            selected.append(index)
            deadline = row.deadline
    return selected


def select_policy(policies, cutoff, lookback_years=2):
    """This inner selection sees only previously produced AND matured OOS costs."""
    past = policies.loc[
        policies.origin.lt(cutoff)
        & policies.deadline.lt(cutoff)
        & policies.origin.ge(cutoff - pd.DateOffset(years=lookback_years))
        & policies.policy.ne("nested_cost_policy")
    ]
    if past.empty:
        return FALLBACK_POLICY, 0, None
    common = past.pivot(index="origin", columns="policy", values="realized_cost_bp")
    if common.isna().any().any():
        raise ValueError("inner selection requires identical policy coverage")
    schedule = past.drop_duplicates("origin").sort_values("origin")
    selected = schedule.loc[nonoverlap_indices(schedule)]
    count = len(selected)
    if count < 12:
        return FALLBACK_POLICY, count, selected.deadline.max()
    # Predeclared fixed policies participate; signal complexity must earn its place.
    scores = common.loc[selected.origin].mean().sort_values(kind="stable")
    return str(scores.index[0]), count, selected.deadline.max()


def _fit_cost_models(data, labels, cutoff, candidate):
    train = purged_training_index(labels, cutoff)
    train = train[train >= cutoff - pd.DateOffset(years=3)]
    if len(train) < 240:
        raise ValueError("at least 240 fully mature common labels required")
    columns = candidate_features(data.features, "AAA_3Y", candidate.feature_set)
    X = data.features.loc[train, columns]
    scale = (
        _volatility_scale(X)
        if getattr(candidate, "normalize_volatility", False)
        else 1.0
    )
    models = [
        fit_rate_candidate(candidate, X, labels.loc[train, f"cost_{h}"] / scale)
        for h in ACTION_HORIZONS[1:]
    ]
    return models, columns, train


def _cost_predictions(models, features, candidate):
    predictions = np.column_stack(
        [
            np.zeros(len(features)),
            *(predict_rate_candidate(model, features, candidate) for model in models),
        ]
    )
    if getattr(candidate, "normalize_volatility", False):
        predictions *= _volatility_scale(features).to_numpy()[:, None]
    return predictions


def _volatility_scale(features):
    # The volatility is already lagged in the shared feature bundle.
    return features["rate_aaa_3y_volatility_20"].fillna(0.25).clip(
        lower=0.25
    ) * np.sqrt(21)


def _action_frame(
    labels, prediction, candidate, margin, cutoff, waiting_cost, fixed_action=None
):
    dates = labels.index
    # Price carries across closures, but the cash waiting cost continues accruing.
    elapsed = np.tile(ACTION_HORIZONS, (len(labels), 1))
    actions = choose_actions(prediction, elapsed, waiting_cost, margin)
    if fixed_action is not None:
        actions[:] = fixed_action
    actual = labels[[f"cost_{h}" for h in ACTION_HORIZONS]].to_numpy()
    actual = actual + waiting_cost * elapsed
    frame = pd.DataFrame(
        {
            "origin": dates,
            "deadline": labels.deadline.to_numpy(),
            "fold": cutoff,
            "policy": f"{candidate.name}:margin={margin:g}",
            "action": np.asarray(ACTION_NAMES)[actions],
            "chosen_horizon": np.asarray(ACTION_HORIZONS)[actions],
            "realized_cost_bp": actual[np.arange(len(actual)), actions],
            "predicted_cost_bp": (prediction + waiting_cost * elapsed)[
                np.arange(len(actual)), actions
            ],
            "regret_bp": actual[np.arange(len(actual)), actions] - actual.min(axis=1),
        }
    )
    for i, horizon in enumerate(ACTION_HORIZONS):
        frame[f"baseline_{horizon}_bp"] = actual[:, i]
        frame[f"prediction_{horizon}_bp"] = prediction[:, i]
    return frame


def _fixed_policies(labels, cutoff, waiting_cost):
    frames = []
    candidate = RateCandidate("fixed", "zero")
    for i, horizon in enumerate(ACTION_HORIZONS):
        forecasts = np.zeros((len(labels), 3))
        frame = _action_frame(labels, forecasts, candidate, 0, cutoff, waiting_cost, i)
        frame["policy"] = f"fixed_{horizon}"
        frame["predicted_cost_bp"] = np.nan
        frame[[f"prediction_{h}_bp" for h in ACTION_HORIZONS]] = np.nan
        frames.append(frame)
    return frames


def evaluate_timing_policies(data, *, start="2021-01-01", end=None, waiting_cost=0.0):
    labels = action_labels(data)
    end = pd.Timestamp(end or data.levels_bp.index.max())
    labels = labels.loc[labels.deadline.lt(end)]
    boundaries = pd.date_range(start, end, freq="QS")
    all_policies, choices = [], []
    for cutoff in boundaries:
        stop = min(cutoff + pd.offsets.QuarterBegin(startingMonth=1), end)
        test = labels.loc[(labels.index >= cutoff) & (labels.index < stop)]
        if test.empty:
            continue
        frames = _fixed_policies(test, cutoff, waiting_cost)
        predictions = {}
        for candidate in TIMING_CANDIDATES:
            models, columns, train = _fit_cost_models(data, labels, cutoff, candidate)
            predicted = _cost_predictions(
                models, data.features.loc[test.index, columns], candidate
            )
            predictions[candidate.name] = predicted
            for margin in ACTION_MARGINS:
                frame = _action_frame(
                    test, predicted, candidate, margin, cutoff, waiting_cost
                )
                frame["train_deadline_max"] = labels.loc[train, "deadline"].max()
                frame["train_samples"] = len(train)
                frames.append(frame)
        for name, normalized in (
            ("cost_ensemble_raw", False),
            ("cost_ensemble_scaled", True),
        ):
            members = [
                predictions[c.name]
                for c in TIMING_CANDIDATES
                if c.kind != "mean"
                and getattr(c, "normalize_volatility", False) == normalized
            ]
            prediction = np.mean(members, axis=0)
            for margin in ACTION_MARGINS:
                frame = _action_frame(
                    test,
                    prediction,
                    RateCandidate(name, "zero"),
                    margin,
                    cutoff,
                    waiting_cost,
                )
                frames.append(frame)
        current = pd.concat(frames, ignore_index=True)
        if all_policies:
            selected, count, last = select_policy(pd.concat(all_policies), cutoff)
        else:
            selected, count, last = FALLBACK_POLICY, 0, None
        choices.append(
            {
                "fold": cutoff,
                "selected_policy": selected,
                "selection_windows": count,
                "selection_latest_deadline": last,
            }
        )
        chosen = current.loc[current.policy.eq(selected)].copy()
        chosen["selected_policy"] = selected
        chosen["policy"] = "nested_cost_policy"
        all_policies.append(pd.concat([current, chosen], ignore_index=True))
        print(
            f"[timing] {cutoff.date()} selected={selected}; mature inner windows={count}",
            flush=True,
        )
    if not all_policies:
        raise ValueError("no complete timing evaluation windows")
    return pd.concat(all_policies, ignore_index=True), pd.DataFrame(choices)


def current_timing_signal(data, policies, as_of, waiting_cost=0.0):
    """Generate a research signal using the same frozen quarterly selection clock."""
    as_of = pd.Timestamp(as_of)
    cutoff = as_of.to_period("Q").start_time
    pool = policies.loc[policies.policy.ne("nested_cost_policy")]
    selected, count, last = select_policy(pool, cutoff)
    # Exact same quote-clock actions as backtest. Execution mapping is a separate
    # unvalidated approximation and is not used to change the research decision.
    elapsed = np.asarray([ACTION_HORIZONS])
    if selected.startswith("fixed_"):
        action = ACTION_HORIZONS.index(int(selected.split("_")[1]))
        forecasts = None
    else:
        name, margin = selected.split(":margin=")
        source = data.levels_bp.index[data.levels_bp.index < as_of][-1]
        X = data.market_features.loc[[source]].copy()
        X["decision_weekday"] = as_of.weekday()
        X["decision_month_end"] = as_of.days_in_month - as_of.day
        candidates = [c for c in TIMING_CANDIDATES if c.name == name]
        if name.startswith("cost_ensemble_"):
            normalized = name.endswith("scaled")
            candidates = [
                c
                for c in TIMING_CANDIDATES
                if c.kind != "mean"
                and getattr(c, "normalize_volatility", False) == normalized
            ]
        if not candidates:
            raise ValueError("unknown selected timing policy")
        values = []
        for candidate in candidates:
            models, columns, _ = _fit_cost_models(
                data, action_labels(data), cutoff, candidate
            )
            values.append(_cost_predictions(models, X[columns], candidate))
        predictions = np.mean(values, axis=0)
        action = int(
            choose_actions(predictions, elapsed, waiting_cost, float(margin))[0]
        )
        forecasts = predictions[0].tolist()
    return {
        "action": ACTION_NAMES[action],
        "action_index": action,
        "selected_policy": selected,
        "selection_windows": count,
        "selection_latest_deadline": last,
        "forecast_cost_differences_bp": forecasts,
        "date": as_of + pd.Timedelta(days=ACTION_HORIZONS[action]),
    }
