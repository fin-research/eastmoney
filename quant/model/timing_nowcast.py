"""Short-horizon catch-up forecast for the AAA securities 3Y valuation curve.

The sector curve is a smoothed valuation curve: its daily changes follow the
liquid curves (CDB, government, AAA corporate) with a lag and are positively
autocorrelated. The decision day T is the quote after the last known quote i.
This module forecasts, from information up to quote i only:

* ``catch_up``: quote(T) - quote(i), the move the last quote has not yet shown;
* ``wait_w``: quote(T + w) - quote(T) for w quotes after T. Negative means
  waiting is cheaper, positive means issuing on T is cheaper.

Everything is in bp. The estimator is a fixed-alpha ridge on lagged daily
changes, refit on matured targets only.
"""

import numpy as np
import pandas as pd

SECTOR_LAGS = range(5)
LIQUID_LAGS = range(4)
LIQUID = ("CDB3", "G3", "G1", "G10", "AAA3")
FUNDING_LAGS = (0, 1)
WAIT_QUOTES = (1, 2, 3, 5)
ALPHA = 50.0
MIN_TRAIN = 500
SIGNAL_BP = 0.5


def build_features(sector_bp, liquid_bp, funding_bp):
    """Lagged daily changes at each quote date; row i uses quotes up to i only."""
    index = sector_bp.index
    columns = {}
    changes = sector_bp.diff()
    for lag in SECTOR_LAGS:
        columns[f"sector_l{lag}"] = changes.shift(lag)
    for name in LIQUID:
        series = liquid_bp[name].reindex(index.union(liquid_bp.index)).ffill()
        changes = series.reindex(index).diff()
        for lag in LIQUID_LAGS:
            columns[f"{name}_l{lag}"] = changes.shift(lag)
    funding = funding_bp.reindex(index.union(funding_bp.index)).ffill().reindex(index)
    for lag in FUNDING_LAGS:
        columns[f"funding_l{lag}"] = funding.diff().shift(lag)
    return pd.DataFrame(columns, index=index)


def targets(sector_bp):
    """catch_up and wait_w per origin quote i; the future part stays NaN at the tail."""
    result = {"catch_up": sector_bp.shift(-1) - sector_bp}
    for w in WAIT_QUOTES:
        result[f"wait_{w}"] = sector_bp.shift(-1 - w) - sector_bp.shift(-1)
    return pd.DataFrame(result)


def fit(features, target, *, alpha=ALPHA):
    rows = pd.concat([features, target.rename("y")], axis=1).dropna()
    if len(rows) < MIN_TRAIN:
        raise ValueError("Not enough matured history for the catch-up model")
    x = rows[list(features)].to_numpy(float)
    mean, std = x.mean(0), x.std(0) + 1e-9
    z = (x - mean) / std
    y = rows.y.to_numpy(float)
    beta = np.linalg.solve(z.T @ z + alpha * np.eye(z.shape[1]), z.T @ (y - y.mean()))
    return {
        "columns": list(features),
        "mean": mean,
        "std": std,
        "beta": beta,
        "intercept": float(y.mean()),
    }


def predict(model, features):
    x = features[model["columns"]].to_numpy(float)
    return model["intercept"] + ((x - model["mean"]) / model["std"]) @ model["beta"]


def walk_forward(features, target_frame, start, *, horizons=None, alpha=ALPHA):
    """Monthly refit. A target is used only when its whole window ended before the month."""
    horizons = horizons or {"catch_up": 0, **{f"wait_{w}": w for w in WAIT_QUOTES}}
    months = pd.date_range(
        start, features.index[-1] + pd.offsets.MonthBegin(), freq="MS"
    )
    out = {name: [] for name in horizons}
    for first, last in zip(months[:-1], months[1:], strict=True):
        test = features[(features.index >= first) & (features.index < last)].dropna()
        if test.empty:
            continue
        for name, extra in horizons.items():
            cutoff = first - pd.Timedelta(days=int((extra + 1) * 1.6) + 4)
            try:
                model = fit(
                    features[features.index <= cutoff],
                    target_frame[name].loc[features.index[features.index <= cutoff]],
                    alpha=alpha,
                )
            except ValueError:
                continue
            out[name].append(pd.Series(predict(model, test), index=test.index))
    return pd.DataFrame(
        {name: pd.concat(parts) for name, parts in out.items() if parts}
    )


def signal(wait_forecast_bp, threshold_bp=SIGNAL_BP):
    """Issue now if waiting is expected to cost, wait if it is expected to save."""
    if wait_forecast_bp > threshold_bp:
        return "尽快"
    if wait_forecast_bp < -threshold_bp:
        return "暂缓"
    return "等待"
