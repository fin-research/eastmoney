"""Balance-weighted issuer spreads from same-day secondary valuations.

Call separately for comparable seniority, option and placement groups, using
their matching industry curve. Inputs must retain eligible bonds with missing
valuations/balances; dropping them would overstate coverage. This produces EOD
observations, not opening-time features or primary issuance coupons.
"""

import numpy as np
import pandas as pd


def _dated_frame(frame, keys, numeric):
    result = frame.copy()
    result["date"] = pd.to_datetime(result["date"], errors="raise")
    for name in numeric:
        result[name] = pd.to_numeric(result[name], errors="raise")
        if np.isinf(result[name]).any():
            raise ValueError(f"infinite {name}")
    if result[keys].isna().any().any() or result.duplicated(keys).any():
        raise ValueError(f"missing or duplicate observation keys: {keys}")
    return result.sort_values(keys)


def _matching_curves(bonds, curves, target_tenor):
    result = bonds.copy()
    result["industry_yield_pct"] = np.nan
    result["target_industry_yield_pct"] = np.nan
    by_date = {day: group for day, group in curves.groupby("date")}
    for day, group in result.groupby("date"):
        curve = by_date.get(day)
        if curve is None:
            continue
        # No date filling, short-end clipping or long-end extrapolation.
        curve = curve.dropna(subset=["yield_pct"]).sort_values("tenor_years")
        if curve.empty:
            continue
        terms, levels = curve.tenor_years, curve.yield_pct
        result.loc[group.index, "industry_yield_pct"] = np.interp(
            group.remaining_years, terms, levels, left=np.nan, right=np.nan
        )
        result.loc[group.index, "target_industry_yield_pct"] = np.interp(
            target_tenor, terms, levels, left=np.nan, right=np.nan
        )
    result["spread_bp"] = (result.yield_pct - result.industry_yield_pct) * 100
    result["covered"] = (
        result.balance.gt(0) & result.remaining_years.gt(0) & result.spread_bp.notna()
    )
    return result


def _daily_summary(day, group):
    active = group.loc[group.balance.gt(0)]
    covered = group.loc[group.covered]
    total, observed = active.balance.sum(), covered.balance.sum()
    unknown = int(group.balance.isna().sum())
    complete = bool(total > 0 and len(active) == len(covered) and unknown == 0)
    spread = (
        float(np.average(covered.spread_bp, weights=covered.balance))
        if observed > 0
        else np.nan
    )
    target = group.target_industry_yield_pct.iloc[0]
    return {
        "date": day,
        "outstanding_bonds": len(active),
        "covered_bonds": len(covered),
        "unknown_balance_bonds": unknown,
        "known_balance": float(total),
        "covered_balance": float(observed),
        "known_balance_coverage": float(observed / total) if total > 0 else np.nan,
        "partial_spread_bp": spread,
        "issuer_spread_bp": spread if complete else np.nan,
        "target_industry_yield_pct": target,
        "synthetic_target_yield_pct": target + spread / 100 if complete else np.nan,
        "complete": complete,
    }


def balance_weighted_issuer_spread(observations, industry_curve, *, target_tenor=3.0):
    """Return daily summary and bond contributions for one comparable pool.

    Observations: date, code, balance, yield_pct, remaining_years. Balance may
    use any consistently applied currency unit. Zero means no outstanding
    principal; missing does not. Dates before issue / after redemption must be
    handled by the source adapter, never inferred from missing valuations.

    Industry curve: date, tenor_years, yield_pct, one curve family only. Linear
    tenor interpolation is explicit; there is no date fill or extrapolation.
    ``partial_spread_bp`` is diagnostic. The model-facing ``issuer_spread_bp``
    stays missing until every positive-balance bond is covered and no balance
    is unknown. A synthetic constant-tenor yield is not a primary coupon.
    """
    if not np.isfinite(target_tenor) or target_tenor <= 0:
        raise ValueError("target tenor must be positive and finite")
    bonds = _dated_frame(
        observations,
        ["date", "code"],
        ["balance", "yield_pct", "remaining_years"],
    ).reset_index(drop=True)
    curves = _dated_frame(
        industry_curve, ["date", "tenor_years"], ["tenor_years", "yield_pct"]
    )
    if bonds.balance.lt(0).any() or curves.tenor_years.le(0).any():
        raise ValueError("negative balance or nonpositive curve tenor")
    contributions = _matching_curves(bonds, curves, target_tenor)
    daily = pd.DataFrame(
        [_daily_summary(day, group) for day, group in contributions.groupby("date")]
    )
    return daily, contributions
