"""Exact source-node histories; preserve missing dates and missing values."""

from pathlib import Path

import numpy as np
import pandas as pd

from .curve_grid import decode_curve_inputs
from .industry_source import industry_available, validate_industry_profile
from .issuance_training import CATEGORIES

# Identities from the frozen later download's 2020-12-28 cross-section.
# This records the source grid, not an archived vintage or generated yield.
NODE_TENORS = (
    0.019178,
    0.038356,
    0.083333,
    0.1,
    0.166667,
    0.2,
    0.25,
    0.3,
    0.4,
    0.5,
    0.6,
    0.7,
    0.75,
    0.8,
    0.9,
    1,
    1.1,
    1.2,
    1.3,
    1.4,
    1.5,
    1.6,
    1.7,
    1.8,
    1.9,
    2,
    2.1,
    2.2,
    2.3,
    2.4,
    2.5,
    2.6,
    2.7,
    2.8,
    2.9,
    3,
    3.1,
    3.2,
    3.3,
    3.4,
    3.5,
    3.6,
    3.7,
    3.8,
    3.9,
    4,
    4.1,
    4.2,
    4.3,
    4.4,
    4.5,
    4.6,
    4.7,
    4.8,
    4.9,
    5,
    5.1,
    5.2,
    5.3,
    5.4,
    5.5,
    5.6,
    5.7,
    5.8,
    5.9,
    6,
    6.1,
    6.2,
    6.3,
    6.4,
    6.5,
    6.6,
    6.7,
    6.8,
    6.9,
    7,
    7.1,
    7.2,
    7.3,
    7.4,
    7.5,
    7.6,
    7.7,
    7.8,
    7.9,
    8,
    8.1,
    8.2,
    8.3,
    8.4,
    8.5,
    8.6,
    8.7,
    8.8,
    8.9,
    9,
    9.1,
    9.2,
    9.3,
    9.4,
    9.5,
    9.6,
    9.7,
    9.8,
    9.9,
    10,
)
GOV_FIELDS = ("E1000172", "E1000174", "E1000180")
NODE_NAMES = (
    *[f"raw_sector_{t:g}y" for t in NODE_TENORS],
    "raw_gov_1y",
    "raw_gov_3y",
    "raw_gov_10y",
)
NODE_COLUMNS = tuple(
    f"{name}_lag_{lag}_pct" for lag in range(20) for name in NODE_NAMES
)
NODE_CONDITIONS = ("tenor", "issue_size", "lead_days")
NODE_NUMERIC = (*NODE_COLUMNS, *NODE_CONDITIONS)
NODE_FEATURES = (*NODE_NUMERIC, *CATEGORIES)


def raw_node_sources(inputs):
    """Use dated source keys for the clock, including days whose values are null."""
    inputs = decode_curve_inputs(inputs)
    validate_industry_profile(inputs)
    funding = pd.DataFrame(inputs["datasets"]["funding"]).copy()
    funding["date"] = pd.to_datetime(funding.observation_date)
    funding = funding.loc[funding.date.ge("2019-01-01")]
    dates = pd.DatetimeIndex(sorted(funding.date.unique()))
    if dates.empty or dates[-1] >= pd.Timestamp(inputs["as_of_date"]):
        raise ValueError("raw node clock is empty or contains future dates")
    nodes = pd.DataFrame(
        inputs["datasets"]["industry_nodes"],
        columns=("curve_code", "observation_date", "tenor_years", "yield_pct"),
    )
    nodes["observation_date"] = pd.to_datetime(nodes.observation_date)
    if nodes.observation_date.ge(pd.Timestamp(inputs["as_of_date"])).any():
        raise ValueError("raw industry nodes contain future dates")
    return dates, {"industry_nodes": nodes, "raw_node_funding": funding}


def raw_node_history(nodes, funding, dates):
    """Exact date/tenor pivots followed by shifts on one fixed quote-date index."""
    nodes = nodes.copy()
    if (
        not nodes.curve_code.eq("5781a1ff7651967e0176978d957b7346").all()
        or not nodes.tenor_years.isin(NODE_TENORS).all()
        or nodes.duplicated(["observation_date", "tenor_years"]).any()
        or not nodes.observation_date.isin(dates).all()
    ):
        raise ValueError("raw industry nodes have conflicting identities or dates")
    government = funding.loc[funding.field.isin(GOV_FIELDS)].copy()
    if government.duplicated(["date", "field"]).any():
        raise ValueError("raw government nodes have duplicate dates")
    for frame, column in ((nodes, "yield_pct"), (government, "value")):
        frame[column] = pd.to_numeric(frame[column], errors="raise")
        present = frame[column].dropna().to_numpy(dtype=float)
        if not np.isfinite(present).all():
            raise ValueError("raw nodes contain nonfinite nonempty values")
    sector = nodes.pivot(
        index="observation_date", columns="tenor_years", values="yield_pct"
    ).reindex(index=dates, columns=NODE_TENORS)
    gov = government.pivot(index="date", columns="field", values="value").reindex(
        index=dates, columns=GOV_FIELDS
    )
    source = pd.concat([sector, gov], axis=1)
    source.columns = NODE_NAMES
    return pd.concat(
        [
            source.shift(lag).set_axis(
                [f"{name}_lag_{lag}_pct" for name in NODE_NAMES], axis=1
            )
            for lag in range(20)
        ],
        axis=1,
    )


def raw_node_features(requests, dates, sources):
    from .feature_engineering import FeatureBuildContext, build_feature_bundle

    history = build_feature_bundle(
        ("coupon_raw_nodes",),
        FeatureBuildContext(
            data_path=Path("."), date_index=dates, source_frames=sources
        ),
    )["coupon_raw_nodes"]
    positions = dates.searchsorted(pd.DatetimeIndex(requests.origin), side="left") - 1
    selected = history.iloc[np.maximum(positions, 0)].copy()
    selected.index = requests.index
    selected.loc[positions < 0] = np.nan
    sector = [name for name in NODE_COLUMNS if name.startswith("raw_sector_")]
    selected.loc[~industry_available(requests.origin), sector] = np.nan
    _mask_unpublished_government(selected, requests, dates, positions, sources)
    return pd.concat([selected, requests[[*NODE_CONDITIONS, *CATEGORIES]]], axis=1)


def _mask_unpublished_government(selected, requests, dates, positions, sources):
    funding = sources["raw_node_funding"]
    releases = funding.loc[funding.field.isin(GOV_FIELDS)].copy()
    releases["published_date"] = pd.to_datetime(releases.published_date)
    published = releases.pivot(
        index="date", columns="field", values="published_date"
    ).reindex(index=dates, columns=GOV_FIELDS)
    origins = pd.DatetimeIndex(requests.origin).to_numpy()
    for lag in range(20):
        at = np.maximum(positions - lag, 0)
        for field, name in zip(GOV_FIELDS, NODE_NAMES[-3:], strict=True):
            unavailable = published[field].iloc[at].to_numpy() >= origins
            selected.loc[unavailable, f"{name}_lag_{lag}_pct"] = np.nan
