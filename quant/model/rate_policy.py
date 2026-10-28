"""每天重估的发行停止策略；选日过程中只读取当时可用的预测。"""

import numpy as np
import pandas as pd
from pathlib import Path

from .rate_diagnostics import policy_summary


def _choose_rolling_date(origin, deadline, dates, forecast, threshold, mode):
    path = dates[(dates >= origin) & (dates <= deadline)]
    for index, current in enumerate(path):
        if index == len(path) - 1:
            return current
        remaining = (
            path[index + 1 : index + 2] if mode == "next_quote" else path[index + 1 :]
        )
        horizons = [(date - current).days for date in remaining]
        predictions = [forecast.get((current, horizon)) for horizon in horizons]
        now = forecast.get((current, 0))
        if (
            now is None
            or not np.isfinite(now)
            or any(value is None or not np.isfinite(value) for value in predictions)
        ):
            return None
        if now - min(predictions) <= threshold:
            return current
    return None


def evaluate_rolling_policy(
    predictions: pd.DataFrame,
    planning_days: int = 30,
    threshold_bp: float = 0.0,
    mode: str = "next_quote",
) -> pd.DataFrame:
    """每日在发行/等待中选择，到期强制发行；未来实际值仅用于评价。"""
    if mode not in ("next_quote", "remaining_window"):
        raise ValueError("unknown rolling decision mode")
    if not 1 <= planning_days <= 30:
        raise ValueError("planning_days must be between 1 and 30")
    rows = []
    for (target, candidate), group in predictions.groupby(["target", "candidate"]):
        immediate = group.loc[group.horizon.eq(0)].sort_values("origin")
        dates = pd.DatetimeIndex(immediate.origin)
        actual = dict(zip(dates, immediate.target_bp))
        forecast = {
            (row.origin, row.horizon): row.prediction_bp for row in group.itertuples()
        }
        starts = group.loc[group.horizon.eq(planning_days)]
        for start in starts.itertuples():
            chosen = _choose_rolling_date(
                start.origin, start.label_end, dates, forecast, threshold_bp, mode
            )
            # 缺预测的起点保留明确状态，不能静默缩小策略分母。
            valid = chosen is not None and start.label_end in actual
            realized = actual[chosen] if valid else np.nan
            rows.append(
                {
                    "target": target,
                    "candidate": candidate,
                    "origin": start.origin,
                    "deadline": start.deadline,
                    "chosen_date": chosen,
                    "chosen_horizon": (chosen - start.origin).days if valid else np.nan,
                    "saving_vs_immediate_bp": actual[start.origin] - realized,
                    "saving_vs_deadline_bp": actual.get(start.label_end, np.nan)
                    - realized,
                    "regret_bp": realized
                    - min(
                        value
                        for date, value in actual.items()
                        if start.origin <= date <= start.label_end
                    ),
                    "status": "evaluated" if valid else "missing_forecast",
                    "threshold_bp": threshold_bp,
                    "mode": mode,
                }
            )
    return pd.DataFrame(rows)


def save_rolling_policy_diagnostics(
    predictions: pd.DataFrame, output_dir: Path
) -> pd.DataFrame:
    """开发期预登记的六种策略比较，保留逐窗口证据与全部失败状态。"""
    output_dir.mkdir(parents=True, exist_ok=True)
    summaries = []
    target_predictions = predictions.loc[predictions.target.eq("AAA_3Y")]
    for mode in ("next_quote", "remaining_window"):
        for threshold in (0.0, 1.0, 2.0):
            result = evaluate_rolling_policy(
                target_predictions, threshold_bp=threshold, mode=mode
            )
            result.to_csv(
                output_dir / f"rolling-{mode}-{threshold:g}bp.csv", index=False
            )
            summary = policy_summary(result.loc[result.status.eq("evaluated")])
            counts = (
                result.groupby(["target", "candidate"]).size().rename("eligible_starts")
            )
            if summary.empty:
                summary = pd.DataFrame(columns=["target", "candidate", "starts"])
            summary = counts.reset_index().merge(
                summary, on=["target", "candidate"], how="left", validate="one_to_one"
            )
            summary["starts"] = summary.starts.fillna(0).astype(int)
            summary["missing_forecast_starts"] = (
                summary.eligible_starts - summary.starts
            )
            summary["mode"] = mode
            summary["threshold_bp"] = threshold
            summaries.append(summary)
            print(
                f"[rates] rolling policy {mode} threshold={threshold:g}bp completed",
                flush=True,
            )
    combined = pd.concat(summaries, ignore_index=True)
    combined.to_csv(output_dir / "rolling-policy-summary.csv", index=False)
    return combined
