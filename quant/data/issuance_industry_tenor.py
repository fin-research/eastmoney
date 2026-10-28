"""Dated AAA securities-company curve context; never extrapolate tenors."""

import numpy as np
import pandas as pd

from .industry_source import industry_available


AAA_CURVE_CODE = "5781a1ff7651967e0176978d957b7346"
INDUSTRY_TENOR_COLUMNS = (
    "industry_aaa_tenor_bp",
    "industry_aaa_minus_treasury_bp",
    "industry_aaa_gap_years",
    "industry_aaa_quote_age_days",
    "industry_aaa_available",
)


def prepare_industry_nodes(records):
    if not records:
        return None
    frame = pd.DataFrame(records)
    required = ("curve_code", "observation_date", "tenor_years", "yield_pct")
    if not set(required).issubset(frame):
        raise ValueError("industry nodes lack curve/date/tenor/yield identity")
    frame = frame.loc[frame.curve_code.eq(AAA_CURVE_CODE), list(required)].copy()
    if frame.empty:
        return None
    frame["observation_date"] = pd.to_datetime(frame.observation_date)
    for name in ("tenor_years", "yield_pct"):
        frame[name] = pd.to_numeric(frame[name], errors="raise")
    if (
        frame.duplicated(["observation_date", "tenor_years"]).any()
        or not np.isfinite(frame[["tenor_years", "yield_pct"]].to_numpy()).all()
        or frame.tenor_years.le(0).any()
        or frame.yield_pct.le(0).any()
    ):
        raise ValueError("invalid or duplicate AAA industry nodes")
    return frame.sort_values(["observation_date", "tenor_years"]).reset_index(drop=True)


def industry_tenor_features(requests, quote_dates, treasury_bp, nodes):
    values = np.full((len(requests), len(INDUSTRY_TENOR_COLUMNS)), np.nan)
    values[:, -1] = 0
    if nodes is None or nodes.empty:
        return pd.DataFrame(
            values, columns=INDUSTRY_TENOR_COLUMNS, index=requests.index
        )
    groups = dict(tuple(nodes.groupby("observation_date", sort=False)))
    quote_dates = pd.DatetimeIndex(quote_dates)
    for date, indices in (
        pd.Series(range(len(requests))).groupby(quote_dates).groups.items()
    ):
        points = groups.get(date)
        if points is None:
            continue
        terms = points.tenor_years.to_numpy(dtype=float)
        yields = points.yield_pct.to_numpy(dtype=float)
        indices = np.asarray(list(indices), dtype=int)
        target = requests.iloc[indices].tenor.to_numpy(dtype=float)
        covered = (
            (target >= terms[0])
            & (target <= terms[-1])
            & industry_available(requests.iloc[indices].origin)
        )
        if not covered.any():
            continue
        positions = indices[covered]
        target = target[covered]
        right = terms.searchsorted(target, side="left")
        left = np.maximum(right - 1, 0)
        gap = np.where(terms[right] == target, 0, terms[right] - terms[left])
        value = np.interp(target, terms, yields) * 100
        values[positions, 0] = value
        values[positions, 1] = value - np.asarray(treasury_bp)[positions]
        values[positions, 2] = gap
        values[positions, 3] = (
            requests.iloc[positions].origin.to_numpy("datetime64[ns]")
            - np.datetime64(date)
        ) / np.timedelta64(1, "D")
        values[positions, 4] = 1
    return pd.DataFrame(values, columns=INDUSTRY_TENOR_COLUMNS, index=requests.index)
