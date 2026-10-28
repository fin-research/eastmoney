"""Coupon error diagnostics; reporting scores never become training targets."""

import numpy as np
import pandas as pd


def error_metrics(actual, predicted):
    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    valid = np.isfinite(actual) & np.isfinite(predicted)
    errors = actual[valid] - predicted[valid]
    return {
        "samples": int(valid.sum()),
        "requested": len(actual),
        "missing": int((~valid).sum()),
        "mae_bp": float(np.abs(errors).mean()) if len(errors) else None,
        "rmse_bp": float(np.sqrt(np.mean(errors**2))) if len(errors) else None,
        "bias_bp": float(errors.mean()) if len(errors) else None,
    }


def period_metrics(rows, *, split):
    """One event per horizon; never pool overlapping monthly training samples."""
    if rows.duplicated(["bond_code", "lead_days"]).any():
        raise ValueError("duplicate issuance event within a horizon diagnostic")
    frame = rows.assign(year=pd.to_datetime(rows.pricing_date).dt.year)
    result = []
    for lead, group in frame.groupby("lead_days"):
        for year, subset in [("all", group), *group.groupby("year")]:
            result.append(
                {
                    "split": split,
                    "lead_days": int(lead),
                    "year": str(year),
                    **error_metrics(subset.coupon_bp, subset.predicted_bp),
                }
            )
    return result


def training_diagnostics(
    model, features, requests, cutoff, excluded=(), *, window_start=None
):
    """Only evaluate labels actually eligible for this fit, at business leads."""
    from data.issuance_training import HORIZONS

    selected = model.training_mask(
        requests, cutoff, excluded, window_start=window_start
    )
    selected &= requests.lead_days.isin(
        (1, 14, 30)
        if model.candidate.uses_quote_history or model.candidate.years == 0
        else HORIZONS
    )
    rows = requests.loc[
        selected, ["bond_code", "pricing_date", "lead_days", "coupon_bp"]
    ].copy()
    rows["predicted_bp"] = model.predict(features.loc[selected])
    return {
        "training_cutoff": pd.Timestamp(cutoff).date().isoformat(),
        "audit": model.audit,
        "interpretation": "in-sample fit diagnostic; not a selection score",
        "overlap_policy": "monthly training cohorts overlap; do not sum samples",
        "metrics": period_metrics(rows, split="train_in_sample"),
    }


def paired_month_interval(rows, reference="simple_bp", *, repeats=2000):
    """Paired month clusters preserve simultaneous events; exploratory interval."""
    columns = ["coupon_bp", "predicted_bp", reference]
    frame = rows.loc[np.isfinite(rows[columns]).all(axis=1)].copy()
    if frame.empty:
        return {"samples": 0, "months": 0, "mae_delta_bp": None, "interval": None}
    frame["delta"] = (frame.coupon_bp - frame.predicted_bp).abs() - (
        frame.coupon_bp - frame[reference]
    ).abs()
    frame["month"] = pd.to_datetime(frame.pricing_date).dt.to_period("M")
    blocks = frame.groupby("month").delta.agg(["sum", "count"])
    interval = None
    if len(blocks) >= 2:
        indices = np.random.default_rng(42).integers(
            0, len(blocks), size=(repeats, len(blocks))
        )
        values = blocks["sum"].to_numpy()[indices].sum(axis=1) / blocks[
            "count"
        ].to_numpy()[indices].sum(axis=1)
        interval = np.quantile(values, [0.025, 0.975]).tolist()
    return {
        "samples": len(frame),
        "months": len(blocks),
        "mae_delta_bp": float(frame.delta.mean()),
        "interval": interval,
        "seed": 42,
        "repeats": repeats,
        "interpretation": "historical exploratory paired month interval",
    }


def diagnostic_report(train, development, final):
    """Three separate score tables; no test-derived correction or pooled score."""
    return {
        "error_sign": "actual minus prediction; negative means overprediction",
        "training": train,
        "development": period_metrics(development, split="development_oos"),
        "final": period_metrics(final, split="final_historical_oos"),
        "selection_uses": "development 30-day MAE, RMSE, simplicity only",
        "training_and_final_used_for_selection": False,
        "win_rate_used_for_training_or_selection": False,
        "paired_final_vs_simple": {
            str(lead): paired_month_interval(group)
            for lead, group in final.groupby("lead_days")
        },
    }
