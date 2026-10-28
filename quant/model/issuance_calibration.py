"""Point calibration from matured, uncalibrated OOF errors; research only."""

import numpy as np
import pandas as pd

MODES = ("pooled_event_median", "horizon_median")
RULES = {
    "window_days": 365,
    "min_bonds": 30,
    "update": "month_start",
    "fallback_bp": 0.0,
    "residual": "actual_minus_raw_huber",
    "median_tie": "midpoint_of_adjacent_values",
    "scope": "stored_historical_maturity_not_verified_publication_time",
}


def validate_oof(rows):
    """Reject ambiguous events and unsafe clocks before calculating residuals."""
    if {"calibration_offset_bp", "raw_predicted_bp"}.intersection(rows.columns):
        raise ValueError("calibration requires original uncalibrated OOF history")
    frame = rows.copy().reset_index(drop=True)
    dates = (
        "origin",
        "training_cutoff",
        "training_label_end",
        "pricing_date",
        "label_available_date",
    )
    for name in dates:
        frame[name] = pd.to_datetime(frame[name], errors="raise")
    valid = (
        frame.training_label_end.lt(frame.training_cutoff)
        & frame.training_cutoff.le(frame.origin)
        & frame.origin.lt(frame.pricing_date)
        & frame.pricing_date.le(frame.label_available_date)
        & frame.training_cutoff.eq(frame.origin.dt.to_period("M").dt.start_time)
        & (frame.pricing_date - frame.origin).dt.days.eq(frame.lead_days)
    )
    inconsistent = (
        frame.groupby("bond_code")[
            ["coupon_bp", "pricing_date", "label_available_date"]
        ]
        .nunique()
        .gt(1)
        .any()
        .any()
    )
    if (
        frame.empty
        or frame[list(dates)].isna().any().any()
        or not valid.all()
        or inconsistent
        or frame.bond_code.isna().any()
        or frame.duplicated(["bond_code", "lead_days"]).any()
        or not np.isfinite(frame[["coupon_bp", "predicted_bp"]]).all().all()
    ):
        raise ValueError("invalid or ambiguous OOF calibration history")
    return frame


def weighted_median(values, weights):
    """Minimize weighted absolute error; midpoint on an exact half-mass tie."""
    order = np.argsort(values, kind="stable")
    values = np.asarray(values, dtype=float)[order]
    weights = np.asarray(weights, dtype=float)[order]
    cumulative = np.cumsum(weights)
    half = cumulative[-1] / 2
    index = int(np.searchsorted(cumulative, half - 1e-12, side="left"))
    if np.isclose(cumulative[index], half, rtol=0, atol=1e-12):
        return float((values[index] + values[index + 1]) / 2)
    return float(values[index])


def _pool_offset(pool):
    counts = pool.groupby("bond_code").bond_code.transform("size")
    weights = 1.0 / counts
    n = pool.bond_code.nunique()
    offset = (
        weighted_median(pool.coupon_bp - pool.predicted_bp, weights)
        if n >= RULES["min_bonds"]
        else 0.0
    )
    return offset, {
        "bonds": int(n),
        "rows": len(pool),
        "active": bool(n >= RULES["min_bonds"]),
        "offset_bp": offset,
        "total_weight": float(weights.sum()),
        "latest_label": str(pool.label_available_date.max().date()) if n else None,
        "latest_origin": str(pool.origin.max().date()) if n else None,
        "horizon_rows": {str(k): len(g) for k, g in pool.groupby("lead_days")},
    }


def calibrate_oof(rows, mode):
    """Freeze offsets at month start; never recycle corrected residuals."""
    if mode not in MODES:
        raise ValueError("unregistered calibration mode")
    raw = validate_oof(rows)
    result = raw.copy()
    result["raw_predicted_bp"] = raw.predicted_bp
    result["calibration_offset_bp"] = 0.0
    result["calibration_active"] = False
    audit = []
    for cutoff, targets in raw.groupby("training_cutoff", sort=True):
        mature = raw.loc[
            raw.label_available_date.lt(cutoff)
            & raw.label_available_date.ge(cutoff - pd.Timedelta(days=365))
            & raw.origin.lt(cutoff)
        ]
        for lead, group in targets.groupby("lead_days", sort=True):
            pool = mature if mode == MODES[0] else mature.loc[mature.lead_days.eq(lead)]
            offset, record = _pool_offset(pool)
            result.loc[group.index, "predicted_bp"] = group.predicted_bp + offset
            result.loc[group.index, "calibration_offset_bp"] = offset
            result.loc[group.index, "calibration_active"] = record["active"]
            audit.append(
                {
                    "cutoff": str(cutoff.date()),
                    "lead_days": int(lead),
                    "requested": len(group),
                    **record,
                }
            )
    return result, audit
