"""全市场两融模型的标准化效果评估。"""

from __future__ import annotations

import numpy as np
import pandas as pd

METRIC_COLUMNS = (
    "model",
    "input_scope",
    "evaluation_set",
    "horizon",
    "samples",
    "start_date",
    "end_date",
    "direction_accuracy",
    "mae",
    "relative_error_pct",
)


def _direction_accuracy(actual: np.ndarray, predicted: np.ndarray) -> float:
    mask = actual != 0
    if not mask.any():
        return float("nan")
    return float((np.sign(actual[mask]) == np.sign(predicted[mask])).mean())


def evaluate_predictions(predictions: pd.DataFrame) -> pd.DataFrame:
    """按模型和期限汇总方向正确率、MAE 与余额口径相对误差。"""
    required = {
        "model",
        "input_scope",
        "evaluation_set",
        "horizon",
        "origin_date",
        "origin_balance",
        "actual_change",
        "predicted_change",
    }
    missing = required - set(predictions.columns)
    if missing:
        raise ValueError(f"评估输入缺少字段: {sorted(missing)}")

    records = []
    grouped = predictions.groupby(
        ["model", "input_scope", "evaluation_set", "horizon"],
        sort=False,
    )
    for (model, input_scope, evaluation_set, horizon), group in grouped:
        actual = group["actual_change"].to_numpy(dtype=float)
        predicted = group["predicted_change"].to_numpy(dtype=float)
        origin_balance = group["origin_balance"].to_numpy(dtype=float)
        if (origin_balance <= 0).any():
            raise ValueError("相对误差分母必须是正的 T 日全市场两融余额。")
        absolute_error = np.abs(predicted - actual)
        records.append(
            {
                "model": model,
                "input_scope": input_scope,
                "evaluation_set": evaluation_set,
                "horizon": int(horizon),
                "samples": int(len(group)),
                "start_date": pd.Timestamp(group["origin_date"].min()),
                "end_date": pd.Timestamp(group["origin_date"].max()),
                "direction_accuracy": _direction_accuracy(actual, predicted),
                "mae": float(absolute_error.mean()),
                "relative_error_pct": float(
                    np.mean(absolute_error / origin_balance) * 100
                ),
            }
        )
    result = pd.DataFrame(records, columns=METRIC_COLUMNS)
    evaluation_order = pd.Categorical(
        result["evaluation_set"],
        categories=["validation", "test"],
        ordered=True,
    )
    return (
        result.assign(_evaluation_order=evaluation_order)
        .sort_values(["horizon", "model", "_evaluation_order"])
        .drop(columns="_evaluation_order")
        .reset_index(drop=True)
    )
