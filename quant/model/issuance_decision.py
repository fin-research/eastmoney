"""发行成本比较：使用联合重复发行误差，不把边际区间当独立分布相加。"""

import numpy as np
import pandas as pd


def issuance_decision(
    window, pair_errors, as_of, issue_size=30.0, waiting_cost_bp_day=0.0
):
    if (
        not np.isfinite(issue_size)
        or issue_size <= 0
        or not np.isfinite(waiting_cost_bp_day)
        or waiting_cost_bp_day < 0
    ):
        raise ValueError("invalid issuance size or waiting cost")
    if window.empty:
        return {"action": "暂缓发行", "reason": "no_issuance_day"}, window
    frame = window.copy().sort_values("date")
    if frame.coupon_percent.isna().any():
        return {
            "action": "暂缓发行",
            "reason": "insufficient_primary_history",
        }, frame
    today = frame.iloc[0]
    frame["expected_saving_bp"] = (today.coupon_percent - frame.coupon_percent) * 100
    frame["waiting_cost_bp"] = (frame.date - today.date).dt.days * waiting_cost_bp_day
    frame["net_saving_bp"] = frame.expected_saving_bp - frame.waiting_cost_bp
    frame["annual_saving_wan"] = frame.net_saving_bp * issue_size
    frame["saving_probability"] = np.nan
    frame["saving_p10_bp"] = np.nan
    frame["pair_samples"] = 0
    if not pair_errors.empty:
        pool = pair_errors.loc[
            pair_errors.label_available_date.lt(as_of)
            & pair_errors.origin.lt(as_of)
            & pair_errors.rating.eq(today.rating)
            & pair_errors.tenor.eq(today.tenor)
            & pair_errors.bond_type.eq(today.bond_type)
            & pair_errors.saving_error_bp.notna()
        ]
        for index, row in frame.iterrows():
            gap = (row.date - today.date).days
            if gap == 0:
                continue
            lower, upper = next(
                (lo, hi)
                for lo, hi in ((1, 5), (6, 10), (11, 20), (21, 30))
                if lo <= gap <= hi
            )
            errors = (
                pool.loc[pool.lead_days.between(lower, upper)]
                .sort_values("label_available_date")
                .tail(252)
                .saving_error_bp
            )
            frame.loc[index, "pair_samples"] = len(errors)
            if len(errors) >= 20:
                savings = row.net_saving_bp + errors
                frame.loc[index, "saving_probability"] = float((savings > 0).mean())
                frame.loc[index, "saving_p10_bp"] = float(np.quantile(savings, 0.1))
    best = frame.loc[frame.net_saving_bp.idxmax()]
    supported = best.date > today.date and best.net_saving_bp >= 2
    decision = {
        "action": "等待" if supported else "尽快发行",
        "reason": "forecast_cost_advantage"
        if supported
        else "no_material_waiting_advantage",
        "first_issuance_date": str(today.date.date()),
        "lowest_expected_cost_date": str(best.date.date()),
        "expected_net_saving_bp": float(best.net_saving_bp),
        "annual_saving_wan": float(best.annual_saving_wan),
        "saving_probability": float(best.saving_probability)
        if pd.notna(best.saving_probability)
        else None,
        "saving_p10_bp": float(best.saving_p10_bp)
        if pd.notna(best.saving_p10_bp)
        else None,
        "joint_error_pairs": int(best.pair_samples),
        "scope": "funding-cost comparison under chosen deadline; liquidity and issuance approvals not assessed",
        "validation_status": "historical conditional assessment; incremental timing alpha not established",
    }
    return decision, frame
