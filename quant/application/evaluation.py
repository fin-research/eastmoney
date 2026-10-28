"""Evaluation application orchestration."""

import pandas as pd
from .inputs import _prepare_issuance_engine, _coupon_inputs


def run_coupon_backtest(directory, as_of, snapshot_path, study_protocol=None):
    from data.issuance_training import IssuancePanel
    from model.short_coupon import evaluate_short_coupons
    from data.online_inputs import ISSUANCE_INPUT_GROUPS

    if study_protocol is not None:
        from model.issuance_study import run_study

        return run_study(study_protocol, snapshot_path, directory, as_of)
    date = as_of or pd.Timestamp.now(tz="Asia/Shanghai").date().isoformat()
    inputs = _coupon_inputs(
        directory, date, snapshot_path, (*ISSUANCE_INPUT_GROUPS, "industry_nodes")
    )
    inputs["issuance_scope"] = "public_only"
    from model.research_resources import release_training_memory

    panel = IssuancePanel.from_inputs(inputs)
    del inputs
    release_training_memory()
    return evaluate_short_coupons(panel, date, directory)


def run_issuance_backtest(
    directory, as_of, snapshot_path, issuer, event_overrides=None
):
    from model.issuance_backtest import (
        BACKTEST_CANDIDATES,
        save_backtest_candidate,
        summarize_backtest,
        apply_event_overrides,
        evaluate_pair_policy,
    )
    from model.export import write_json
    from model.primary_pricing import evaluate_primary_pricing
    from model.issuance_validation import issuance_pair_errors
    from model.issuance_backtest_report import write_event_report
    from model.issuance_optimization import (
        optimization_protocol,
        save_primary_optimization,
    )
    from model.statistical_validity import coupon_validity

    date = (
        pd.Timestamp(as_of).normalize()
        if as_of
        else pd.Timestamp.now(tz="Asia/Shanghai").tz_localize(None).normalize()
    )
    directory.mkdir(parents=True, exist_ok=True)
    engine, dataset, audit = _prepare_issuance_engine(
        date, snapshot_path, directory, "lgb_anchor_drift"
    )
    if event_overrides:
        dataset = apply_event_overrides(dataset, event_overrides)
        _, engine.history = evaluate_primary_pricing(dataset)
        audit["event_overrides"] = str(event_overrides)
    targets = dataset.loc[
        dataset.issuer.eq(issuer) & dataset.label_available_date.lt(date)
    ]
    if targets.empty:
        raise ValueError("no eligible priced bonds for requested issuer")
    targets.to_csv(directory / "target-bonds.csv", index=False)
    write_json(
        directory / "protocol.json",
        {
            "as_of": str(date.date()),
            "issuer": issuer,
            "candidates": BACKTEST_CANDIDATES,
            "objective": "actual issue T, origins T-30..T-1; coupon fixed on actual pricing date",
            "date_bases": ["issue_date", "decision_date"],
            "primary": "issuer_absolute",
            "primary_optimization": optimization_protocol(),
            "comparison": "same valid cases; per-event clustered uncertainty; 2026 previously observed",
            "direction": "AAA3Y secondary market change, 0.5bp neutral band; not issuer timing win rate",
            "scope": "fixed known terms scenario; later pricing origins excluded, historical vintages unavailable",
            "source_audit": audit,
        },
    )
    frames = []
    for name in BACKTEST_CANDIDATES:
        frames.append(
            save_backtest_candidate(
                engine.rates, engine.history, targets, directory, name
            )
        )
        print(f"[event backtest] {name} complete", flush=True)
    paths = pd.concat(frames, ignore_index=True)
    paths.to_csv(directory / "all-paths.csv", index=False)
    summarize_backtest(paths, directory)
    coupon_validity(paths).to_csv(directory / "statistical-coupon.csv", index=False)
    save_primary_optimization(paths, engine, directory)
    pairs = issuance_pair_errors(engine, dataset)
    pairs.to_csv(directory / "all-issuer-pairs.csv", index=False)
    policies = []
    for cost in (0.0, 0.1):
        policies.append(evaluate_pair_policy(pairs, cost))
    pd.concat(policies).to_csv(directory / "policy-replay.csv", index=False)
    write_event_report(
        paths, targets, pairs, pd.concat(policies), directory, issuer, date
    )
    print(f"[event backtest] saved {len(paths)} requested forecasts to {directory}")
    return paths


def _model_sample_metadata(dataset: pd.DataFrame) -> dict:
    """返回最终逐笔模型实际使用的完整有效样本范围。"""
    sample = dataset.dropna(subset=["y_regression", "issue_date"])
    dates = pd.to_datetime(sample["issue_date"], errors="coerce").dropna()
    if dates.empty:
        raise ValueError("最终模型没有可用的发行日期样本。")
    return {
        "sample_count": int(len(sample)),
        "sample_start_date": dates.min().strftime("%Y-%m-%d"),
        "sample_end_date": dates.max().strftime("%Y-%m-%d"),
    }
