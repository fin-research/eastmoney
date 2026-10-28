"""Curve research application orchestration."""

import numpy as np
import pandas as pd
from .inputs import _prepare_issuance_engine


def run_curve_research(
    directory,
    as_of,
    snapshot_path,
    funding_history,
    days,
    terms,
    waiting_cost=0.0,
    target="AAA_3Y",
):
    import json
    from data.rate_data import build_rate_dataset
    from data.online_inputs import source_frame
    from model.curve_research import run_curve_research as evaluate

    _require_empty_research_directory(directory)

    date = (
        pd.Timestamp(as_of).normalize()
        if as_of
        else pd.Timestamp.now(tz="Asia/Shanghai").tz_localize(None).normalize()
    )
    directory.mkdir(parents=True, exist_ok=True)
    engine, _, _ = _prepare_issuance_engine(
        date, snapshot_path, directory, "lgb_anchor_drift"
    )
    input_path = snapshot_path or directory / "inputs.json"
    current_raw = source_frame(
        "funding", json.loads(input_path.read_text())["datasets"]["funding"]
    )
    raw = current_raw.loc[current_raw.index >= "2019-01-01"]
    if funding_history:
        raw = pd.read_csv(funding_history, index_col=0, parse_dates=True)
        overlap_raw = raw.index.intersection(current_raw.index)
        # The extended historical file may have filled additional pre-2019
        # fields. Recent observations must match the dated source snapshot.
        recent = overlap_raw[overlap_raw >= "2019-01-01"]
        if len(recent) < 60 or not np.allclose(
            raw.loc[recent, current_raw.columns],
            current_raw.loc[recent],
            atol=1e-8,
            rtol=0,
            equal_nan=True,
        ):
            raise ValueError("extended funding raw values differ from dated snapshot")
        additions = current_raw.loc[~current_raw.index.isin(raw.index)]
        raw = pd.concat([raw, additions]).sort_index()
        if raw.index.max() >= date:
            raise ValueError("extended funding includes unavailable observations")
    rates = build_rate_dataset(
        funding_history or input_path,
        funding_frame=raw,
        extra_groups=("funding_microstructure",),
    )
    rates.audit["current_snapshot"] = str(input_path)
    if funding_history:
        overlap = rates.levels_bp.index.intersection(engine.rates.levels_bp.index)
        if len(overlap) < 60 or not np.allclose(
            rates.levels_bp.loc[overlap], engine.rates.levels_bp.loc[overlap], atol=1e-6
        ):
            raise ValueError("extended funding differs from current source")
        common = rates.market_features.index.intersection(
            engine.rates.market_features.index
        )
        # Indicators with rolling warm-up differ only near the old history start.
        check = common[common >= common.min() + pd.Timedelta(days=365)]
        if not np.allclose(
            rates.market_features.loc[check, engine.rates.market_features.columns],
            engine.rates.market_features.loc[check],
            atol=1e-6,
            rtol=0,
            equal_nan=True,
        ):
            raise ValueError("extended funding features differ from current source")
    return evaluate(engine, rates, directory, date, days, terms, waiting_cost, target)


def run_timing_research(directory, as_of, snapshot_path, terms, waiting_cost=0.0):
    from model.timing_research import run_timing_research as evaluate

    _require_empty_research_directory(directory)

    date = (
        pd.Timestamp(as_of).normalize()
        if as_of
        else pd.Timestamp.now(tz="Asia/Shanghai").tz_localize(None).normalize()
    )
    directory.mkdir(parents=True, exist_ok=True)
    engine, _, _ = _prepare_issuance_engine(
        date, snapshot_path, directory, "lgb_anchor_drift"
    )
    return evaluate(engine, directory, date, terms, waiting_cost)


def _require_empty_research_directory(directory):
    if directory.exists() and any(directory.iterdir()):
        raise ValueError(
            "experiment already frozen or directory nonempty; choose a new directory"
        )


def run_conditional_research(directory, as_of, snapshot_path):
    from model.conditional_diagnostics import run_conditional_research as evaluate

    date = (
        pd.Timestamp(as_of).normalize()
        if as_of
        else pd.Timestamp.now(tz="Asia/Shanghai").tz_localize(None).normalize()
    )
    directory.mkdir(parents=True, exist_ok=True)
    engine, _, _ = _prepare_issuance_engine(
        date, snapshot_path, directory, "conditional_drift"
    )
    return evaluate(engine.rates, directory)
