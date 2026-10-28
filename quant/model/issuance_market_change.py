"""Direct market changes at natural-day horizons; one integrated coupon bundle.

Dense sector-curve labels use the quote strictly before the target pricing day.
Only fully matured deadlines enter a monthly fit. Centering is estimated inside
that training window; no constraint forces a forecast path to reverse or average
zero. Horizon zero is known, and intermediate horizons interpolate direct fits.
"""

import lightgbm as lgb
import numpy as np
import pandas as pd

from .window_linear import WindowRidge
from .export import _tree
from data.issuance_industry_tenor import industry_tenor_features
from data.issuance_training import treasury_anchor
from data.issuance_curve_dynamics import (
    CURVE_DYNAMIC_COLUMNS,
    CURVE_SHAPE_COLUMNS,
    curve_features,
)

MARKET_HORIZONS = (7, 14, 30, 60, 90)
MARKET_TENORS = (1.0, 3.0, 5.0, 7.0, 10.0)
MARKET_STATES = (
    "rate_aaa_3y_change_1",
    "rate_aaa_3y_change_5",
    "rate_aaa_3y_change_20",
    "rate_aaa_3y_deviation_20",
    "rate_aaa_3y_deviation_60",
    "rate_gov_3y_change_20",
    "rate_gov_3y_deviation_20",
    "credit_spread_chg_5d",
    "credit_spread_chg_20d",
    "credit_spread",
    "dr007_vs_policy",
    "dr007_vs_ma5_dev",
    "dr007_chg_20d",
    "term_spread",
)


MARKET_TREE_PARAMS = dict(
    n_estimators=120,
    num_leaves=7,
    max_depth=3,
    learning_rate=0.025,
    min_child_samples=80,
    reg_lambda=20.0,
    reg_alpha=1.0,
    colsample_bytree=0.8,
    random_state=20260921,
    n_jobs=1,
    verbosity=-1,
    deterministic=True,
    force_col_wise=True,
    objective="regression",
)


def market_states(mode):
    if mode in ("tenor", "tenor_shape"):
        return (
            *CURVE_DYNAMIC_COLUMNS,
            *MARKET_STATES[5:],
            *(CURVE_SHAPE_COLUMNS if mode == "tenor_shape" else ()),
        )
    return MARKET_STATES


def market_matrix(features, states=MARKET_STATES):
    state = features.reindex(columns=states).astype(float)
    tenor = features.tenor.to_numpy() / 5.0
    interaction = state.mul(tenor, axis=0).add_suffix("__tenor")
    return pd.concat(
        [state, interaction, pd.Series(tenor, name="tenor", index=features.index)],
        axis=1,
    )


def market_labels(panel, horizon, *, include_curve=False):
    market = panel.rates.market_features
    origins = market.index + pd.Timedelta(days=1)
    requests = pd.DataFrame(
        {
            "origin": origins.repeat(len(MARKET_TENORS)),
            "tenor": np.tile(MARKET_TENORS, len(origins)),
        }
    )
    deadlines = pd.DatetimeIndex(requests.origin) + pd.Timedelta(days=horizon)
    source = market.index.searchsorted(requests.origin, side="left") - 1
    target = market.index.searchsorted(deadlines, side="left") - 1
    known = market.iloc[source].reset_index(drop=True)
    future = market.iloc[target].reset_index(drop=True)
    initial = industry_tenor_features(
        requests,
        market.index[source],
        treasury_anchor(known, requests.tenor),
        panel.industry_nodes,
    ).industry_aaa_tenor_bp
    ending = industry_tenor_features(
        requests.assign(origin=deadlines),
        market.index[target],
        treasury_anchor(future, requests.tenor),
        panel.industry_nodes,
    ).industry_aaa_tenor_bp
    known["tenor"] = requests.tenor
    if include_curve:
        known = pd.concat(
            [known, curve_features(requests, market.index, panel.industry_nodes)],
            axis=1,
        )
    labels = requests.assign(
        deadline=deadlines, label_end=market.index[target], change_bp=ending - initial
    )
    labels.loc[deadlines > market.index[-1], "change_bp"] = np.nan
    return known, labels


def balanced_origin_weights(labels):
    """Balance mature origin regimes, never five independent tenor observations.

    The regime is the mean curve change across all five tenors at one origin.
    Keep flat origins at raw weight one, equalize rising/falling total mass,
    cap raw weights at three, then normalize origin weights to mean one.
    Fewer than 30 origins on either moving side keeps uniform weights.
    """
    grouped = labels.groupby("origin").change_bp.agg(["mean", "count"])
    if not grouped["count"].eq(len(MARKET_TENORS)).all():
        raise ValueError("balanced market fit requires all five tenors per origin")
    regime = pd.Series(
        np.where(
            grouped["mean"].ge(1),
            "rising",
            np.where(grouped["mean"].le(-1), "falling", "flat"),
        ),
        index=grouped.index,
    )
    counts = regime.value_counts().reindex(["rising", "falling", "flat"], fill_value=0)
    weights = pd.Series(1.0, index=grouped.index)
    eligible = min(counts["rising"], counts["falling"]) >= 30
    if eligible:
        moving = counts["rising"] + counts["falling"]
        for name in ("rising", "falling"):
            weights.loc[regime.eq(name)] = min(3.0, moving / (2 * counts[name]))
        weights /= weights.mean()
    audit = {
        "policy": "origin mean across five tenors; +/-1bp; cap raw weight 3; normalize mean 1",
        "regime_origins": {k: int(v) for k, v in counts.items()},
        "uniform_fallback": not eligible,
        "origin_weight_min": float(weights.min()),
        "origin_weight_max": float(weights.max()),
        "origin_weight_sum": float(weights.sum()),
        "effective_origins": float(weights.sum() ** 2 / (weights @ weights)),
        "origin_weights": {str(k.date()): float(v) for k, v in weights.items()},
    }
    return labels.origin.map(weights).to_numpy() / len(MARKET_TENORS), audit


def fit_market_change(panel, cutoff, mode):
    cutoff = pd.Timestamp(cutoff)
    output = {
        "mode": mode,
        "states": list(market_states(mode)),
        "models": {},
        "audit": {
            "cutoff": str(cutoff.date()),
            "target": "sector curve change; not primary coupon",
            "lookback_years": 5,
            "alpha": 1000.0,
            "horizons": list(MARKET_HORIZONS),
            "centering": "training-window tenor mean"
            if mode in ("centered", "lgb_centered")
            else "none",
        },
    }
    if mode == "zero":
        return output
    if mode not in (
        "ridge",
        "centered",
        "lgb",
        "lgb_centered",
        "balanced",
        "balanced_half",
        "tenor",
        "tenor_shape",
    ):
        raise ValueError("unknown direct market mode")
    output["audit"]["horizon_training"] = {}
    for horizon in MARKET_HORIZONS:
        features, labels = market_labels(
            panel, horizon, include_curve=mode in ("tenor", "tenor_shape")
        )
        mask = (
            labels.deadline.lt(cutoff)
            & labels.label_end.lt(cutoff)
            & labels.origin.ge(cutoff - pd.DateOffset(years=5))
            & labels.change_bp.notna()
        )
        chosen = labels.loc[mask]
        if chosen.origin.nunique() < 240:
            raise ValueError("fewer than 240 mature market origins")
        y = chosen.change_bp.copy()
        means = chosen.groupby("tenor").change_bp.mean()
        if mode in ("centered", "lgb_centered"):
            y -= chosen.tenor.map(means)
        matrix = market_matrix(features.loc[mask], output["states"])
        weights = np.ones(len(y)) / len(MARKET_TENORS)
        weighting = {}
        if mode in ("balanced", "balanced_half"):
            weights, weighting = balanced_origin_weights(chosen)
        if mode.startswith("lgb"):
            model = lgb.LGBMRegressor(**MARKET_TREE_PARAMS).fit(
                matrix, y.to_numpy(), sample_weight=weights
            )
            output["models"][str(horizon)] = {
                "model_text": model.booster_.model_to_string(),
                "trees": [
                    _tree(t["tree_structure"])
                    for t in model.booster_.dump_model()["tree_info"]
                ],
            }
            output["audit"]["tree_params"] = MARKET_TREE_PARAMS
        else:
            model = WindowRidge.fit(matrix, y.to_numpy(), weights, 1000.0)
            if mode == "balanced_half":
                model.coefficients *= 0.5
                model.intercept *= 0.5
            output["models"][str(horizon)] = {
                name: getattr(model, name).tolist()
                if name != "intercept"
                else model.intercept
                for name in ("fill", "center", "scale", "coefficients", "intercept")
            }
        output["models"][str(horizon)]["audit"] = {
            "origins": chosen.origin.nunique(),
            "rows": len(y),
            "label_end": str(chosen.label_end.max().date()),
            "latest_deadline": str(chosen.deadline.max().date()),
            "training_mean_by_tenor": {str(k): float(v) for k, v in means.items()},
            "weighted_constant_bp": float(np.average(y, weights=weights))
            * (0.5 if mode == "balanced_half" else 1.0),
            "weighting": weighting,
            "missing_feature_rows": int(matrix.isna().any(axis=1).sum()),
            "missing_by_feature": {
                name: int(count) for name, count in matrix.isna().sum().items() if count
            },
        }
        output["audit"]["horizon_training"][str(horizon)] = output["models"][
            str(horizon)
        ]["audit"]
    return output


def market_constant_change(layer, features):
    """Same fitted-window weights, no state features; diagnostic only."""
    result = np.zeros(len(features))
    if layer["mode"] == "zero":
        return result
    for horizon in MARKET_HORIZONS:
        result += (
            horizon_weights(features.lead_days.to_numpy(), horizon)
            * layer["models"][str(horizon)]["audit"]["weighted_constant_bp"]
        )
    return result * (
        1
        - features.get(
            "market_known_zero", pd.Series(0.0, index=features.index)
        ).to_numpy()
    )


def horizon_weights(leads, horizon):
    grid = (0, *MARKET_HORIZONS)
    i = grid.index(horizon)
    prior = grid[i - 1]
    following = grid[i + 1] if i + 1 < len(grid) else horizon
    left = np.clip((leads - prior) / (horizon - prior), 0, 1)
    right = (
        np.clip((following - leads) / (following - horizon), 0, 1)
        if following > horizon
        else np.ones(len(leads))
    )
    return np.minimum(left, right)


def market_contributions(layer, features):
    count = len(features)
    states = layer["states"]
    components = {name: np.zeros(count) for name in states}
    base = np.zeros(count)
    if layer["mode"] == "zero":
        return components, base
    if not features.industry_aaa_available.eq(1).all():
        raise ValueError("market change requires the same dated industry reference")
    matrix = market_matrix(features, states)
    for horizon in MARKET_HORIZONS:
        state = layer["models"][str(horizon)]
        if "model_text" in state:
            booster = lgb.Booster(model_str=state["model_text"])
            phi = booster.predict(matrix, pred_contrib=True, num_threads=1)
            values, intercept = phi[:, :-1], phi[:, -1]
        else:
            model = WindowRidge(
                **{
                    name: np.asarray(state[name])
                    if name != "intercept"
                    else state[name]
                    for name in ("fill", "center", "scale", "coefficients", "intercept")
                }
            )
            values = model.transformed(matrix) * model.coefficients
            intercept = model.intercept
        weight = horizon_weights(features.lead_days.to_numpy(), horizon)
        weight *= (
            1
            - features.get(
                "market_known_zero", pd.Series(0.0, index=features.index)
            ).to_numpy()
        )
        for i, name in enumerate(states):
            components[name] += weight * (values[:, i] + values[:, i + len(states)])
        base += weight * (values[:, -1] + intercept)
    return components, base


def market_change(layer, features):
    parts, base = market_contributions(layer, features)
    return base + sum(parts.values())
