"""Pricing research application orchestration."""

from pathlib import Path
import pandas as pd
from data.data import DATA_FILE


def run_rate_research(output_dir: Path) -> dict:
    """用现有本地报价评估利率目标，不更新源数据、不写生产结果。"""
    from data.rate_data import build_rate_dataset
    from model.rate_evaluation import evaluate_rate_candidates, save_rate_experiment
    from model.rate_diagnostics import add_decomposed_predictions
    from model.rate_policy import save_rolling_policy_diagnostics

    data = build_rate_dataset(DATA_FILE)
    config = {
        "start": "2022-01-01",
        "end": "2026-01-01",
        "horizons": tuple(range(31)),
        "targets": ("GOV_3Y", "AAA_3Y", "CREDIT_3Y"),
    }
    predictions = evaluate_rate_candidates(data, **config)
    manifest = save_rate_experiment(output_dir, data, predictions, config)
    save_rolling_policy_diagnostics(add_decomposed_predictions(predictions), output_dir)
    print(
        f"[rates] Development evidence saved to {output_dir}; 2026 excluded from this development run."
    )
    return manifest


def run_primary_research(
    output_dir: Path, as_of: str | None = None, refresh_metadata: bool = False
) -> dict:
    """一级定价研究复用本地数据与既有 CLI，保留真实票面误差及当期比较。"""
    import json
    from data.primary_pricing import (
        build_primary_pricing_dataset,
        refresh_pricing_metadata,
    )
    from data.rate_data import build_rate_dataset
    from model.primary_pricing import (
        PRIMARY_HALF_LIFE_DAYS,
        PRIMARY_SELECTED_CANDIDATE,
        evaluate_primary_pricing,
        evaluate_primary_intervals,
        primary_pricing_metrics,
        current_primary_quotes,
    )

    if refresh_metadata:
        print(refresh_pricing_metadata())
    date = (
        pd.Timestamp(as_of).normalize()
        if as_of
        else pd.Timestamp.now(tz="Asia/Shanghai").tz_localize(None).normalize()
    )
    rates = build_rate_dataset(DATA_FILE)
    dataset, audit = build_primary_pricing_dataset(rates)
    dataset = dataset.loc[dataset.label_available_date.lt(date)]
    if dataset.empty:
        raise ValueError("no mature primary pricing labels before as-of date")
    predictions, history = evaluate_primary_pricing(dataset)
    metrics = primary_pricing_metrics(predictions, end=str(date.date()))
    current = current_primary_quotes(history, predictions, rates, date)
    intervals = evaluate_primary_intervals(predictions)
    output_dir.mkdir(parents=True, exist_ok=True)
    predictions.to_csv(output_dir / "primary-predictions.csv", index=False)
    history.to_csv(output_dir / "primary-history.csv", index=False)
    metrics.to_csv(output_dir / "primary-metrics.csv", index=False)
    current.to_csv(output_dir / "primary-current.csv", index=False)
    intervals.to_csv(output_dir / "primary-intervals.csv", index=False)
    audit.update(
        as_of=str(date.date()),
        mature_labels=len(dataset),
        market_data=rates.audit,
        model={
            "selected_candidate": PRIMARY_SELECTED_CANDIDATE,
            "half_life_days": PRIMARY_HALF_LIFE_DAYS,
            "selection_period": "2022-2025 development; 2026 is research reference, not a fresh holdout",
        },
    )
    (output_dir / "primary-audit.json").write_text(
        json.dumps(audit, ensure_ascii=False, indent=2)
    )
    selected = current.loc[current.selected].copy()
    for column in ("as_of", "market_date"):
        selected[column] = selected[column].dt.strftime("%Y-%m-%d")
    products = (
        selected.astype(object)
        .where(pd.notna(selected), None)
        .to_dict(orient="records")
    )
    snapshot = {
        "schema_version": "primary-pricing-research-v1",
        "audit": audit,
        "products": products,
        "forecast_scope": "current primary coupon estimates; future window not yet integrated",
    }
    (output_dir / "primary-assessment.json").write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2, allow_nan=False)
    )
    print(json.dumps(audit, ensure_ascii=False, indent=2))
    print(metrics.round(3).to_string(index=False))
    print(current.round(3).to_string(index=False))
    return audit
