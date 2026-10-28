"""Raw quoted yield histories for short-horizon coupon regression.

No direction, momentum label, threshold, or forecast correction is constructed.
All quote dates precede the request origin. Issuer quotes use the daily
least-squares tenor fit supplied with the existing issuer_daily input.
"""

from pathlib import Path

import numpy as np
import pandas as pd

from .industry_source import industry_available

TENORS = (1, 3, 5, 7, 10)
QUOTE_LAGS = tuple(range(20))
QUOTE_COLUMNS = tuple(
    f"{source}_quote_lag_{lag}_bp"
    for source in ("sector", "issuer")
    for lag in QUOTE_LAGS
)
STATIC_QUOTE_COLUMNS = (QUOTE_COLUMNS[0], QUOTE_COLUMNS[20])


def raw_quote_frame(nodes, dates):
    wide = nodes.pivot(
        index="observation_date", columns="tenor_years", values="yield_pct"
    ).reindex(index=dates, columns=TENORS)
    return pd.DataFrame(
        {
            f"sector_{tenor}_quote_lag_{lag}_bp": wide[tenor].shift(lag) * 100
            for tenor in TENORS
            for lag in QUOTE_LAGS
        },
        index=dates,
    )


def _sector_quotes(requests, dates, nodes):
    from .feature_engineering import FeatureBuildContext, build_feature_bundle

    values = np.full((len(requests), len(QUOTE_LAGS)), np.nan)
    if nodes is None or nodes.empty:
        return values
    frame = build_feature_bundle(
        ("coupon_quote_history",),
        FeatureBuildContext(
            data_path=Path("."),
            date_index=dates,
            source_frames={"industry_nodes": nodes},
        ),
    ).combined
    positions = dates.searchsorted(pd.DatetimeIndex(requests.origin), side="left") - 1
    target = requests.tenor.to_numpy(dtype=float)
    right = np.clip(np.searchsorted(TENORS, target), 0, len(TENORS) - 1)
    left = np.maximum(right - 1, 0)
    grid = np.asarray(TENORS)
    weight = np.divide(
        target - grid[left],
        grid[right] - grid[left],
        out=np.zeros(len(target)),
        where=grid[right] != grid[left],
    )
    for lag in QUOTE_LAGS:
        points = frame.iloc[np.maximum(positions, 0)][
            [f"sector_{tenor}_quote_lag_{lag}_bp" for tenor in TENORS]
        ].to_numpy()
        a, b = (
            points[np.arange(len(target)), left],
            points[np.arange(len(target)), right],
        )
        values[:, lag] = np.where(
            weight == 0, a, np.where(weight == 1, b, a + weight * (b - a))
        )
    values[(positions < 0) | (target < 1) | (target > 10)] = np.nan
    return values


def _issuer_quotes(requests, dates, secondary):
    values = np.full((len(requests), len(QUOTE_LAGS)), np.nan)
    required = {"yield_slope", "yield_intercept", "min_tenor", "max_tenor"}
    if secondary is None or not required.issubset(secondary):
        return values
    keys = ["issuer", "bond_type", "placement_type"]
    groups = dict(tuple(secondary.groupby(keys, sort=False)))
    origins = pd.DatetimeIndex(requests.origin)
    positions = dates.searchsorted(origins, side="left") - 1
    for key, indices in requests.groupby(keys, sort=False).indices.items():
        history = groups.get(key)
        if history is None:
            continue
        history = history.set_index("date").reindex(dates)
        target = requests.iloc[indices].tenor.to_numpy(dtype=float)
        for lag in QUOTE_LAGS:
            at = positions[indices] - lag
            selected = history.iloc[np.maximum(at, 0)]
            covered = (
                (at >= 0)
                & (target >= selected.min_tenor.to_numpy(dtype=float))
                & (target <= selected.max_tenor.to_numpy(dtype=float))
            )
            quoted = (
                selected.yield_intercept.to_numpy(dtype=float)
                + selected.yield_slope.to_numpy(dtype=float) * target
            ) * 100
            values[indices[covered], lag] = quoted[covered]
    return values


def coupon_quote_features(requests, dates, nodes, secondary):
    """Interpolate maturities, retain missing quotes, and expose raw lag values."""
    dates = pd.DatetimeIndex(dates)
    values = pd.DataFrame(
        np.column_stack(
            (
                _sector_quotes(requests, dates, nodes),
                _issuer_quotes(requests, dates, secondary),
            )
        ),
        columns=QUOTE_COLUMNS,
        index=requests.index,
    )
    if nodes is not None and not nodes.empty:
        curve = raw_quote_frame(nodes, dates)
    else:
        curve = raw_quote_frame(
            pd.DataFrame(columns=["observation_date", "tenor_years", "yield_pct"]),
            dates,
        )
    positions = dates.searchsorted(pd.DatetimeIndex(requests.origin), side="left") - 1
    selected = curve.iloc[np.maximum(positions, 0)].copy()
    selected.index = requests.index
    selected.loc[positions < 0] = np.nan
    result = pd.concat([values, selected], axis=1)
    columns = [name for name in result if name.startswith("sector_")]
    result.loc[~industry_available(requests.origin), columns] = np.nan
    return result
