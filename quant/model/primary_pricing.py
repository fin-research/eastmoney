"""一级票面定价：同类市场定价与发行人历史溢价的时点一致收缩估计。"""

import numpy as np
import pandas as pd


PRIMARY_CANDIDATES = (
    "secondary_only",
    "same_peer",
    "issuer_absolute",
    "issuer_shrink_3",
    "issuer_shrink_10",
    "issuer_relative_3",
    "last_issuer_coupon",
)
PRIMARY_HALF_LIFE_DAYS = 90
PRIMARY_SELECTED_CANDIDATE = "issuer_absolute"


def weighted_location(values, dates, as_of, half_life_days=PRIMARY_HALF_LIFE_DAYS):
    """按日期衰减的加权中位数与 Kish 有效样本数，不用发行量夸大置信度。"""
    values = np.asarray(values, dtype=float)
    dates = pd.DatetimeIndex(dates)
    valid = np.isfinite(values) & dates.notna()
    if not valid.any():
        return np.nan, 0.0
    values, dates = values[valid], dates[valid]
    weights = np.exp2(
        -np.asarray((pd.Timestamp(as_of) - dates).days, dtype=float) / half_life_days
    )
    order = np.argsort(values)
    position = np.searchsorted(np.cumsum(weights[order]), weights.sum() / 2)
    effective_n = weights.sum() ** 2 / np.square(weights).sum()
    return float(values[order[position]]), float(effective_n)


def primary_history_statistics(
    history, terms, as_of, *, half_life_days=PRIMARY_HALF_LIFE_DAYS, lookback_days=730
):
    available = history.loc[
        history.label_available_date.lt(as_of)
        & history.label_available_date.ge(
            pd.Timestamp(as_of) - pd.Timedelta(days=lookback_days)
        )
        & history.rating.eq(terms["rating"])
        & history.bond_type.eq(terms["bond_type"])
        & np.isclose(history.tenor, terms["tenor"], rtol=0, atol=1e-6)
    ]
    # 同发行人同日多券只计一个独立发行观察。
    available = available.groupby(
        ["issuer", "label_available_date"], as_index=False
    ).agg(
        premium_bp=("premium_bp", "median"),
        coupon_bp=("coupon_bp", "median"),
        peer_residual_bp=("peer_residual_bp", "median"),
    )
    peer, peer_n = weighted_location(
        available.premium_bp, available.label_available_date, as_of, half_life_days
    )
    own = available.loc[available.issuer.eq(terms["issuer"])].sort_values(
        "label_available_date"
    )
    absolute, own_n = weighted_location(
        own.premium_bp, own.label_available_date, as_of, half_life_days
    )
    relative, relative_n = weighted_location(
        own.peer_residual_bp, own.label_available_date, as_of, half_life_days
    )
    return {
        "peer_premium_bp": peer if len(available) >= 3 else np.nan,
        "peer_n": len(available),
        "peer_effective_n": peer_n,
        "own_premium_bp": absolute,
        "own_n": len(own),
        "own_effective_n": own_n,
        "own_relative_bp": relative,
        "relative_effective_n": relative_n,
        "last_issuer_coupon_bp": float(own.coupon_bp.iloc[-1]) if len(own) else np.nan,
        "last_issuer_premium_bp": float(own.premium_bp.iloc[-1])
        if len(own)
        else np.nan,
        "history_latest_date": available.label_available_date.max(),
    }


def coupon_predictions(stats: dict, market_bp: float) -> dict:
    peer = stats["peer_premium_bp"]
    own = stats["own_premium_bp"] if np.isfinite(stats["own_premium_bp"]) else peer
    n = stats["own_effective_n"]
    relative = (
        stats["own_relative_bp"] if np.isfinite(stats["own_relative_bp"]) else 0.0
    )
    relative_n = stats["relative_effective_n"]
    return {
        "secondary_only": market_bp,
        "same_peer": market_bp + peer,
        "issuer_absolute": market_bp + own,
        "issuer_shrink_3": market_bp + (n * own + 3 * peer) / (n + 3),
        "issuer_shrink_10": market_bp + (n * own + 10 * peer) / (n + 10),
        "issuer_relative_3": market_bp
        + peer
        + relative_n / (relative_n + 3) * relative,
        "last_issuer_coupon": stats["last_issuer_coupon_bp"],
    }


def evaluate_primary_pricing(
    dataset: pd.DataFrame, *, half_life_days=PRIMARY_HALF_LIFE_DAYS
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """逐发行事件展开；结果日未过去的票面和同日其他券一律不可用。"""
    frame = (
        dataset.sort_values(["decision_date", "bond_code"])
        .reset_index(drop=True)
        .copy()
    )
    frame["peer_residual_bp"] = np.nan
    records = []
    for index, row in frame.iterrows():
        stats = primary_history_statistics(
            frame, row, row.decision_date, half_life_days=half_life_days
        )
        frame.loc[index, "peer_residual_bp"] = row.premium_bp - stats["peer_premium_bp"]
        predictions = coupon_predictions(stats, row.known_market_bp)
        for name, prediction in predictions.items():
            records.append(
                {
                    "bond_code": row.bond_code,
                    "issuer": row.issuer,
                    "tenor": row.tenor,
                    "rating": row.rating,
                    "bond_type": row.bond_type,
                    "origin": row.decision_date,
                    "label_available_date": row.label_available_date,
                    "source_date": row.source_date,
                    "coupon_bp": row.coupon_bp,
                    "prediction_bp": prediction,
                    "candidate": name,
                    "status": "estimated"
                    if np.isfinite(prediction)
                    else "insufficient_history",
                    **stats,
                }
            )
    return pd.DataFrame(records), frame


def primary_pricing_metrics(
    predictions: pd.DataFrame, start="2022-01-01", end="2026-01-01"
) -> pd.DataFrame:
    frame = predictions.loc[
        predictions.origin.ge(pd.Timestamp(start))
        & predictions.label_available_date.lt(pd.Timestamp(end))
    ].copy()
    # 所有基线和候选共享同一组可比较发行，另报未覆盖数量。
    counts = (
        frame.loc[frame.status.eq("estimated")].groupby("bond_code").candidate.nunique()
    )
    common = set(counts[counts.eq(len(PRIMARY_CANDIDATES))].index)
    rows = []
    for (name, year), group in frame.groupby(["candidate", frame.origin.dt.year]):
        eligible = group.loc[group.bond_code.isin(common)]
        errors = eligible.prediction_bp - eligible.coupon_bp
        rows.append(
            {
                "candidate": name,
                "year": int(year),
                "all_cases": len(group),
                "estimated_cases": int(group.status.eq("estimated").sum()),
                "common_cases": len(eligible),
                "mae_bp": float(errors.abs().mean()),
                "rmse_bp": float(np.sqrt(np.square(errors).mean())),
                "bias_bp": float(errors.mean()),
            }
        )
    return pd.DataFrame(rows)


def primary_error_interval(oos, terms, candidate, as_of):
    reference = oos.loc[
        oos.candidate.eq(candidate)
        & oos.rating.eq(terms["rating"])
        & oos.tenor.eq(terms["tenor"])
        & oos.bond_type.eq(terms["bond_type"])
        & oos.label_available_date.lt(as_of)
        & oos.origin.lt(as_of)
        & oos.status.eq("estimated")
    ].copy()
    reference["error"] = reference.coupon_bp - reference.prediction_bp
    calibration = (
        reference.groupby(["issuer", "origin"], as_index=False)
        .agg(
            error=("error", "median"),
            label_available_date=("label_available_date", "max"),
        )
        .sort_values("origin")
        .tail(252)
    )
    errors = calibration.error
    low, high = (
        np.quantile(errors, [0.05, 0.95]) if len(errors) >= 30 else (np.nan, np.nan)
    )
    return {
        "error_low_bp": low,
        "error_high_bp": high,
        "calibration_samples": len(errors),
        "calibration_latest_label": calibration.label_available_date.max(),
    }


def evaluate_primary_intervals(predictions):
    selected = predictions.loc[
        predictions.candidate.eq(PRIMARY_SELECTED_CANDIDATE)
        & predictions.status.eq("estimated")
    ]
    rows = []
    for row in selected.itertuples():
        interval = primary_error_interval(
            predictions, row._asdict(), row.candidate, row.origin
        )
        lower = row.prediction_bp + interval["error_low_bp"]
        upper = row.prediction_bp + interval["error_high_bp"]
        calibrated = np.isfinite(lower) and np.isfinite(upper)
        rows.append(
            {
                "bond_code": row.bond_code,
                "issuer": row.issuer,
                "origin": row.origin,
                "coupon_bp": row.coupon_bp,
                "lower_bp": lower,
                "upper_bp": upper,
                "interval_status": "calibrated"
                if calibrated
                else "insufficient_history",
                "covered": bool(lower <= row.coupon_bp <= upper)
                if calibrated
                else None,
                **interval,
            }
        )
    return pd.DataFrame(rows)


def current_primary_quotes(
    history, oos, rates, as_of, issuer="东方财富证券股份有限公司"
) -> pd.DataFrame:
    """当前一级票面候选与历史误差区间；不将跨发行人的区间标成保证覆盖。"""
    observations = rates.levels_bp.loc[rates.levels_bp.index < as_of]
    if observations.empty:
        raise ValueError("no market quote before pricing as-of date")
    market_date = observations.index[-1]
    market_bp = float(observations.AAA_3Y.iloc[-1])
    rows = []
    for tenor in (3.0, 5.0):
        for bond_type in ("证券公司债", "证券公司次级债"):
            terms = {
                "issuer": issuer,
                "rating": "AAA",
                "tenor": tenor,
                "bond_type": bond_type,
            }
            stats = primary_history_statistics(history, terms, as_of)
            for name, value in coupon_predictions(stats, market_bp).items():
                interval = primary_error_interval(oos, terms, name, as_of)
                low, high = interval["error_low_bp"], interval["error_high_bp"]
                rows.append(
                    {
                        **terms,
                        "candidate": name,
                        "selected": name == PRIMARY_SELECTED_CANDIDATE,
                        "as_of": as_of,
                        "market_date": market_date,
                        "quote_age_days": (as_of - market_date).days,
                        "coupon_percent": value / 100,
                        "lower_percent": (value + low) / 100,
                        "upper_percent": (value + high) / 100,
                        "calibration_samples": interval["calibration_samples"],
                        "peer_n": stats["peer_n"],
                        "own_n": stats["own_n"],
                        "status": "pricing_research"
                        if np.isfinite(value)
                        else "insufficient_history",
                    }
                )
    return pd.DataFrame(rows)
