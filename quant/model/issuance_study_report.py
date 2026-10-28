"""Paired development gates and descriptive pricing diagnostics, not calibration."""

import numpy as np
import pandas as pd

from data.issuance_training import treasury_anchor
from .issuance_diagnostics import error_metrics, paired_month_interval, period_metrics
from .issuance_study_protocol import KEYS


def paired_rows(rows, control):
    pairs = rows.merge(
        control[KEYS + ["predicted_bp"]],
        on=KEYS,
        validate="one_to_one",
        suffixes=("", "_b0"),
    )
    if len(pairs) != len(rows) or len(pairs) != len(control):
        raise ValueError("paired control denominator differs")
    pairs["year"] = pd.to_datetime(pairs.pricing_date).dt.year
    return pairs


def pair_metrics(rows):
    return {
        "candidate": error_metrics(rows.coupon_bp, rows.predicted_bp),
        "b0": error_metrics(rows.coupon_bp, rows.predicted_bp_b0),
    }


def development_gates(pairs, *, business_tenors=False):
    h30 = pairs.loc[pairs.lead_days.eq(30)]
    if h30.empty:
        raise ValueError("missing h30 development events")
    metrics = pair_metrics(h30)
    candidate, control = metrics["candidate"], metrics["b0"]
    failures = []
    if control["mae_bp"] - candidate["mae_bp"] < max(0.5, control["mae_bp"] * 0.05):
        failures.append("h30_mae_improvement")
    if abs(candidate["bias_bp"]) - abs(control["bias_bp"]) > 1:
        failures.append("h30_absolute_bias")
    years = [
        {"year": int(year), **pair_metrics(group)}
        for year, group in h30.groupby("year")
    ]
    if sum(r["candidate"]["mae_bp"] < r["b0"]["mae_bp"] for r in years) < 2:
        failures.append("fewer_than_two_improved_years")
    for lead, group in pairs.groupby("lead_days"):
        metric = pair_metrics(group)
        if lead != 30 and metric["candidate"]["mae_bp"] - metric["b0"]["mae_bp"] > 1:
            failures.append(f"horizon_{lead}_mae")
    groups = group_diagnostics(h30, business_tenors=business_tenors)
    failures.extend(
        f"group_{r['dimension']}_{r['value']}"
        for r in groups
        if r["sufficient"] and r["mae_delta_bp"] > 2
    )
    return {
        "passed": not failures,
        "failures": failures,
        "h30": metrics,
        "years": years,
        "groups": groups,
        "paired_month_interval": paired_month_interval(h30, "predicted_bp_b0"),
    }


def group_diagnostics(rows, *, business_tenors=True):
    output = []
    rows = rows.assign(tenor_bucket=tenor_buckets(rows.tenor))
    tenor = "tenor_bucket" if business_tenors else "tenor"
    for dimension in ("year", tenor, "rating", "bond_type", "placement_type"):
        for value, group in rows.groupby(dimension, dropna=False, observed=True):
            metrics = pair_metrics(group)
            output.append(
                {
                    "dimension": dimension,
                    "value": str(value),
                    **metrics,
                    "sufficient": len(group) >= 20,
                    "mae_delta_bp": metrics["candidate"]["mae_bp"]
                    - metrics["b0"]["mae_bp"],
                }
            )
    return output


def tenor_buckets(tenors):
    """Business maturity buckets tolerate day-count differences around 1/3/5Y."""
    return pd.cut(
        tenors,
        bins=[0, 1.1, 3.1, 5.1, np.inf],
        labels=["<=1Y", "1-3Y", "3-5Y", ">5Y"],
        right=True,
    )


def candidate_report(rows, control, *, business_tenors=False):
    pairs = paired_rows(rows, control)
    return {
        "gates": development_gates(pairs, business_tenors=business_tenors),
        "metrics": period_metrics(rows, split="development_oos"),
        "event_horizon_rows": len(rows),
        "final_period_touched": False,
    }


def structural_report(rows, control, original):
    report = candidate_report(rows, control, business_tenors=True)
    original_gates = candidate_report(rows, original, business_tenors=True)["gates"]
    report["b0_gates"] = original_gates
    report["gates"]["passed"] &= original_gates["passed"]
    report["gates"]["failures"].extend(
        f"b0_{failure}" for failure in original_gates["failures"]
    )
    return report


def benchmark_report(rows):
    """Strong point-in-time benchmarks on exactly the same event denominator."""
    h30 = rows.loc[rows.lead_days.eq(30)]
    return {
        name: {
            "metrics": error_metrics(h30.coupon_bp, h30[name]),
            "paired_month_interval": paired_month_interval(h30, name),
            "years": {
                str(year): error_metrics(group.coupon_bp, group[name])
                for year, group in h30.groupby(pd.to_datetime(h30.pricing_date).dt.year)
            },
        }
        for name in ("simple_bp", "primary_flat_bp", "industry_flat_bp")
        if name in h30
    }


def pricing_decomposition(panel, rows):
    """Realized market anchors are report-only; never model training columns."""
    frame = rows.loc[rows.lead_days.eq(30)].copy().reset_index(drop=True)
    market = panel.rates.market_features
    for name, column in (("origin", "origin"), ("pricing", "pricing_date")):
        positions = (
            market.index.searchsorted(pd.DatetimeIndex(frame[column]), side="left") - 1
        )
        if (positions < 0).any():
            raise ValueError("diagnostic anchor history missing")
        frame[f"{name}_quote_date"] = market.index[positions].strftime("%Y-%m-%d")
        frame[f"{name}_anchor_bp"] = treasury_anchor(
            market.iloc[positions], frame.tenor
        )
    requests = frame.assign(origin=pd.to_datetime(frame.origin), issue_size=0.0)
    features = panel.features(
        requests, include_weighted_primary=True, include_industry_tenor=True
    )
    if not np.allclose(features.known_treasury_bp, frame.origin_anchor_bp, atol=1e-9):
        raise ValueError("diagnostic origin anchor differs from training panel")
    frame["overprediction_bp"] = frame.predicted_bp - frame.coupon_bp
    frame["market_move_bp"] = frame.origin_anchor_bp - frame.pricing_anchor_bp
    frame["excess_error_bp"] = frame.overprediction_bp - frame.market_move_bp
    for column in (
        "peer_premium_mean_bp",
        "peer_weighted_premium_bp",
        "issuer_shrunk_premium_bp",
        "issuer_secondary_missing",
        "issuer_secondary_spread_bp",
        "industry_aaa_available",
    ):
        frame[column] = features[column].to_numpy()
    frame["coupon_publication_time_verified"] = False
    frame["historical_vintage_verified"] = False
    return frame
