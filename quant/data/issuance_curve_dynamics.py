"""Sector tenor dynamics on the existing complete-quote clock, in basis points."""

from pathlib import Path

import numpy as np
import pandas as pd

from .industry_source import industry_available

TENORS = (1, 3, 5, 7, 10)
DYNAMICS = ("change_1", "change_5", "change_20", "deviation_20", "deviation_60")
CURVE_DYNAMIC_COLUMNS = tuple(f"sector_tenor_{name}" for name in DYNAMICS)
CURVE_SHAPE_COLUMNS = ("sector_slope_10_1", "sector_curvature_3")
CURVE_COLUMNS = (*CURVE_DYNAMIC_COLUMNS, *CURVE_SHAPE_COLUMNS)


def curve_dynamics_frame(nodes, dates):
    # Exact node/date observations: no carrying across gaps or missing windows.
    wide = nodes.pivot(
        index="observation_date", columns="tenor_years", values="yield_pct"
    )
    wide = wide.reindex(index=dates, columns=TENORS).mul(100)
    output = {}
    for tenor in TENORS:
        series = wide[tenor]
        for lag in (1, 5, 20):
            output[f"sector_{tenor}_change_{lag}"] = series.diff(lag)
        for window in (20, 60):
            output[f"sector_{tenor}_deviation_{window}"] = (
                series - series.rolling(window).mean()
            )
    output[CURVE_SHAPE_COLUMNS[0]] = wide[10] - wide[1]
    output[CURVE_SHAPE_COLUMNS[1]] = wide[3] - (7 * wide[1] + 2 * wide[10]) / 9
    return pd.DataFrame(output, index=dates)


def curve_features(requests, dates, nodes):
    from .feature_engineering import FeatureBuildContext, build_feature_bundle

    if nodes is None or nodes.empty:
        return pd.DataFrame(np.nan, index=requests.index, columns=CURVE_COLUMNS)
    bundle = build_feature_bundle(
        ("industry_curve_dynamics",),
        FeatureBuildContext(
            data_path=Path("."),
            date_index=dates,
            source_frames={"industry_nodes": nodes},
        ),
    )
    positions = dates.searchsorted(pd.DatetimeIndex(requests.origin), side="left") - 1
    if (positions < 0).any():
        raise ValueError("curve origin precedes complete quote clock")
    selected = bundle.combined.iloc[positions]
    target = requests.tenor.to_numpy(dtype=float)
    right = np.clip(np.searchsorted(TENORS, target), 0, len(TENORS) - 1)
    left = np.maximum(right - 1, 0)
    grid = np.array(TENORS)
    span = grid[right] - grid[left]
    weight = np.divide(
        target - grid[left], span, out=np.zeros(len(target)), where=span != 0
    )
    output = {}
    for name in DYNAMICS:
        values = selected[[f"sector_{t}_{name}" for t in TENORS]].to_numpy()
        a, b = (
            values[np.arange(len(target)), left],
            values[np.arange(len(target)), right],
        )
        interpolated = np.where(
            weight == 1, b, np.where(weight == 0, a, a + weight * (b - a))
        )
        interpolated[(target < 1) | (target > 10)] = np.nan
        output[f"sector_tenor_{name}"] = interpolated
    for name in CURVE_SHAPE_COLUMNS:
        output[name] = selected[name].to_numpy()
    result = pd.DataFrame(output, index=requests.index)
    result.loc[~industry_available(requests.origin)] = np.nan
    return result
