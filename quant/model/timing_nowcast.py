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

FEATURE_VERSION = "timing-advice-v2"
CODES = {
    "CDB3": "E1701708",
    "G3": "E1000174",
    "G1": "E1000172",
    "G10": "E1000180",
    "AAA3": "E1000413",
}
FUNDING_CODE = "E1300004"
WAIT_TARGET = 3
RESIDUAL_POINTS = 200
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


def input_frames(inputs):
    """Sector, liquid and funding curves in bp from an archived T-1 input snapshot."""
    source = inputs["required_source_date"]
    wanted = {*CODES.values(), FUNDING_CODE}
    used = [r for r in inputs["datasets"]["funding"] if r["field"] in wanted]
    for row in (*inputs["datasets"]["sector3"], *used):
        if (
            row["observation_date"] > source
            or (row.get("published_date") or "") > source
        ):
            raise ValueError("Future timing input")
    index = [row["observation_date"] for row in inputs["datasets"]["sector3"]]
    if len(set(index)) != len(index):
        raise ValueError("Duplicate sector quote")
    sector = [r for r in inputs["datasets"]["sector3"] if r["yield_pct"]]
    funding = [r for r in inputs["datasets"]["funding"] if r["value"]]
    index = [row["observation_date"] for row in sector]
    sector_bp = pd.Series(
        [row["yield_pct"] * 100 for row in sector], index=pd.to_datetime(index)
    ).sort_index()
    columns = {}
    for code in wanted:
        rows = [row for row in funding if row["field"] == code]
        dates = [row["observation_date"] for row in rows]
        if len(set(dates)) != len(dates):
            raise ValueError("Duplicate funding quote")
        columns[code] = pd.Series(
            [row["value"] * 100 for row in rows], index=pd.to_datetime(dates)
        ).sort_index()
    liquid = pd.DataFrame({name: columns[code] for name, code in CODES.items()})
    return sector_bp, liquid, columns[FUNDING_CODE]


def live_features(inputs):
    """Feature row of the last quote; every input must reach the required source date."""
    source = pd.Timestamp(inputs["required_source_date"])
    if pd.Timestamp(inputs["as_of_date"]) <= source:
        raise ValueError("Timing inputs must precede decision date")
    sector, liquid, funding = input_frames(inputs)
    if (
        sector.empty
        or sector.index[-1] != source
        or sector.index[-1] >= pd.Timestamp(inputs["as_of_date"])
    ):
        raise ValueError("Stale market quote")
    for series in (*(liquid[c].dropna() for c in liquid), funding.dropna()):
        if series.empty or series.index[-1] != source:
            raise ValueError("Stale market quote")
    row = build_features(sector, liquid, funding).iloc[[-1]]
    if row.isna().any().any():
        raise ValueError("Incomplete timing history")
    return row


def export_model(features, target_frame, residuals, *, alpha=ALPHA):
    """Two fixed ridge fits plus the out-of-sample wait residual quantiles."""

    def part(name):
        model = fit(features, target_frame[name], alpha=alpha)
        return {
            "mean": model["mean"].tolist(),
            "std": model["std"].tolist(),
            "beta": model["beta"].tolist(),
            "intercept": model["intercept"],
        }

    points = (np.arange(RESIDUAL_POINTS) + 0.5) / RESIDUAL_POINTS
    return {
        "kind": "catch_up_ridge",
        "columns": list(features),
        "catch_up": part("catch_up"),
        f"wait_{WAIT_TARGET}": part(f"wait_{WAIT_TARGET}"),
        "residual_quantiles": np.quantile(
            np.asarray(residuals, float), points
        ).tolist(),
        "threshold_bp": SIGNAL_BP,
        "wait_quotes": WAIT_TARGET,
    }


def _predict(part, columns, row):
    x = row[columns].to_numpy(float)[0]
    z = (x - np.asarray(part["mean"])) / np.asarray(part["std"])
    return float(part["intercept"] + z @ np.asarray(part["beta"]))


def outcome_probabilities(model, wait_bp):
    """Share of out-of-sample residuals that put the realised move beyond +-threshold."""
    realised = wait_bp + np.asarray(model["residual_quantiles"])
    n = len(realised)
    defer = int((realised < -model["threshold_bp"]).sum())
    issue = int((realised > model["threshold_bp"]).sum())
    return {"defer": defer / n, "wait": (n - defer - issue) / n, "issue": issue / n}


NARRATIVES = {
    "暂缓": "预测此后3个报价日利率下行，建议暂缓发行。",
    "尽快": "预测此后3个报价日利率上行，建议尽快发行。",
    "等待": "预测此后3个报价日利率变动不大，建议等待。",
}


def nowcast_snapshot(manifest, model, inputs):
    from data.issuance_calendar import IssuanceCalendar  # noqa: PLC0415

    previous = IssuanceCalendar(manifest["calendar"]).previous_quote_day(
        inputs["as_of_date"]
    )
    if str(previous.date()) != inputs["required_source_date"]:
        raise ValueError("Wrong timing source date")
    row = live_features(inputs)
    columns = model["columns"]
    if list(row.columns) != columns:
        raise ValueError("Timing feature columns changed")
    catch_up = _predict(model["catch_up"], columns, row)
    wait = _predict(model[f"wait_{WAIT_TARGET}"], columns, row)
    action = signal(wait, model["threshold_bp"])
    return {
        "schema_version": FEATURE_VERSION,
        "as_of_date": inputs["as_of_date"],
        "market_source_date": inputs["required_source_date"],
        "model_version": manifest["model_version"],
        "scope": "AAA证券公司债3Y",
        "training_label_cutoff": manifest["training_label_cutoff"],
        "forecast": {
            "catch_up_bp": catch_up,
            "wait_bp": wait,
            "wait_quotes": model["wait_quotes"],
            "threshold_bp": model["threshold_bp"],
        },
        "probabilities": outcome_probabilities(model, wait),
        "decision": {"action": action},
        "validation": manifest["validation"],
        "base_conclusion": {
            "verdict": action,
            "preferred_window": "",
            "narrative": NARRATIVES[action],
        },
    }
