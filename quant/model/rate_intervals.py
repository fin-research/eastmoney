"""从已成熟样本外残差校准收益率区间与相对当日的成本概率。"""

import numpy as np
import pandas as pd


def _interval_row(
    row, reference, zero_errors, now_prediction, coverage, max_history, min_history
):
    mature = reference.label_end.lt(row.origin)
    if "deadline" in reference:
        mature &= reference.deadline.lt(row.origin)
    available = (
        reference.loc[mature & reference.origin.lt(row.origin)]
        .sort_values("origin")
        .tail(max_history)
    )
    result = {
        "calibration_samples": len(available),
        "calibration_label_end": available.label_end.max(),
        "interval_status": "insufficient_calibration",
        "lower_change_bp": np.nan,
        "upper_change_bp": np.nan,
        "lower_rate_percent": np.nan,
        "upper_rate_percent": np.nan,
        "probability_below_last_quote": np.nan,
        "probability_cheaper_than_today": np.nan,
    }
    if len(available) < min_history:
        return result
    errors = available.change_bp - available.prediction_bp
    tail = (1 - coverage) / 2
    low, high = row.prediction_bp + np.quantile(errors, [tail, 1 - tail])
    result.update(
        interval_status="calibrated",
        lower_change_bp=float(low),
        upper_change_bp=float(high),
        lower_rate_percent=float((row.current_bp + low) / 100),
        upper_rate_percent=float((row.current_bp + high) / 100),
        probability_below_last_quote=float((row.prediction_bp + errors < 0).mean()),
    )
    # 使用同一起点的成对误差差，不能把未来日与当日预测误差当成独立变量。
    paired = errors.to_numpy() - zero_errors.reindex(available.origin).to_numpy()
    paired = paired[np.isfinite(paired)]
    if len(paired) >= min_history and now_prediction is not None:
        result["probability_cheaper_than_today"] = float(
            (row.prediction_bp - now_prediction + paired < 0).mean()
        )
    return result


def calibrate_rate_intervals(
    predictions: pd.DataFrame,
    history: pd.DataFrame,
    *,
    coverage: float = 0.9,
    max_history: int = 252,
    min_history: int = 120,
) -> pd.DataFrame:
    """逐起点只读取 label_end < origin 的历史；名义覆盖必须再样本外检验。"""
    if not 0 < coverage < 1 or not 1 <= min_history <= max_history:
        raise ValueError("invalid interval coverage or calibration sample limits")
    keys = ["target", "candidate", "horizon", "origin"]
    if predictions.duplicated(keys).any() or history.duplicated(keys).any():
        raise ValueError("duplicate forecast origins in interval calibration")
    rows = []
    for (target, candidate), group in predictions.groupby(["target", "candidate"]):
        pool = history.loc[history.target.eq(target) & history.candidate.eq(candidate)]
        zero = pool.loc[pool.horizon.eq(0)].set_index("origin")
        zero_errors = zero.change_bp - zero.prediction_bp
        now = group.loc[group.horizon.eq(0)].set_index("origin").prediction_bp
        for horizon, horizon_group in group.groupby("horizon"):
            reference = pool.loc[pool.horizon.eq(horizon)]
            for row in horizon_group.itertuples():
                interval = _interval_row(
                    row,
                    reference,
                    zero_errors,
                    now.get(row.origin),
                    coverage,
                    max_history,
                    min_history,
                )
                result = row._asdict()
                result.pop("Index", None)
                result.update(interval)
                rows.append(result)
    return pd.DataFrame(rows)
