"""开发期滚动评估与冻结参数后的留出检验，保留逐预测证据。"""

from dataclasses import asdict
from pathlib import Path
import hashlib
import json

import numpy as np
import pandas as pd

from data.rate_data import RateDataset, horizon_labels, purged_training_index
from .rate_diagnostics import (
    COMPONENT_CANDIDATES,
    add_decomposed_predictions,
    policy_summary,
    yearly_error_table,
)
from .rate_forecast import (
    RATE_CANDIDATES,
    candidate_features,
    fit_rate_candidate,
    predict_rate_candidate,
    candidate_training_index,
)


def _evaluate_candidate_fold(
    data, labels, cutoff, test_index, candidate, target, horizon
):
    fit_labels = labels
    if candidate.anchor_horizon is not None:
        fit_labels = horizon_labels(
            data, target, min(horizon, candidate.anchor_horizon)
        )
    selected = candidate_training_index(fit_labels, cutoff, candidate)
    columns = candidate_features(data.features, target, candidate.feature_set)
    model = fit_rate_candidate(
        candidate,
        data.features.loc[selected, columns],
        fit_labels.loc[selected, "change_bp"],
    )
    prediction = predict_rate_candidate(
        model, data.features.loc[test_index, columns], candidate
    )
    if candidate.drift_extension:
        shared = selected.intersection(purged_training_index(labels, cutoff))
        prediction += float(
            (
                labels.loc[shared, "change_bp"] - fit_labels.loc[shared, "change_bp"]
            ).mean()
        )
    result = labels.loc[test_index].copy()
    result["prediction_bp"] = prediction
    result["origin"] = test_index
    result["target"] = target
    result["horizon"] = horizon
    result["candidate"] = candidate.name
    result["fold"] = str(cutoff.date())
    result["train_label_end"] = fit_labels.loc[selected, "label_end"].max()
    result["train_samples"] = len(selected)
    result["train_start"] = selected.min()
    result["recent_window_fallback"] = (
        candidate.name == "recent_drift"
        and selected.min() < cutoff - pd.DateOffset(years=1)
    )
    return result.reset_index(drop=True)


def evaluate_rate_candidates(
    data: RateDataset,
    *,
    start: str = "2022-01-01",
    end: str = "2026-01-01",
    horizons: tuple[int, ...] = tuple(range(31)),
    targets: tuple[str, ...] = ("GOV_3Y", "AAA_3Y", "CREDIT_3Y"),
    candidates=RATE_CANDIDATES,
) -> pd.DataFrame:
    """季度初重训、季度内固定模型；训练终点严格 purge，各期原始预测落盘。"""
    records = []
    boundaries = pd.date_range(start, end, freq="QS")
    if len(boundaries) < 2 or str(boundaries[-1].date()) != end:
        raise ValueError("start/end must delimit full calendar quarters")
    for target in targets:
        for horizon in horizons:
            labels = horizon_labels(data, target, horizon)
            for cutoff, stop in zip(boundaries[:-1], boundaries[1:]):
                test_index = labels.index[
                    (labels.index >= cutoff) & (labels.index < stop)
                ]
                # 只评估 end 前成熟的标签，绝不通过长 horizon 读到封存年。
                test_index = test_index[
                    (labels.loc[test_index, "label_end"] < pd.Timestamp(end))
                    & (labels.loc[test_index, "deadline"] < pd.Timestamp(end))
                ]
                train_index = purged_training_index(labels, cutoff)
                if len(train_index) < 240 or test_index.empty:
                    continue
                for candidate in candidates:
                    records.append(
                        _evaluate_candidate_fold(
                            data, labels, cutoff, test_index, candidate, target, horizon
                        )
                    )
            print(f"[rates] {target} horizon={horizon}: completed", flush=True)
    if not records:
        raise ValueError("no eligible out-of-sample predictions")
    return pd.concat(records, ignore_index=True)


def rate_metric_table(predictions: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for key, group in predictions.groupby(["target", "horizon", "candidate"]):
        actual = group["change_bp"].to_numpy()
        prediction = group["prediction_bp"].to_numpy()
        error = prediction - actual
        rows.append(
            {
                "target": key[0],
                "horizon": key[1],
                "candidate": key[2],
                "n": len(group),
                "mae_bp": float(np.abs(error).mean()),
                "rmse_bp": float(np.sqrt(np.square(error).mean())),
                "rw_mae_bp": float(np.abs(actual).mean()),
                "skill_mae": float(
                    1 - np.abs(error).mean() / max(np.abs(actual).mean(), 1e-12)
                ),
                "direction_accuracy": float(
                    (np.sign(prediction) == np.sign(actual)).mean()
                ),
                "bias_bp": float(error.mean()),
            }
        )
    return pd.DataFrame(rows)


def evaluate_fixed_origin_policy(
    predictions: pd.DataFrame, threshold_bp: float = 2.0
) -> pd.DataFrame:
    """在起点一次性选择未来发行日；实际变化只用于事后评分，不参与选日。

    保存的成本是二级收益率代理成本，不能标成真实发行票面节约。
    每个起点的窗口须完整，零日基准和所有候选期限都必须存在。
    """
    rows = []
    for (target, name), group in predictions.groupby(["target", "candidate"]):
        expected = group.horizon.nunique()
        for origin, path in group.groupby("origin"):
            if len(path) != expected or 0 not in path.horizon.values:
                continue
            path = path.sort_values("horizon")
            immediate = path.loc[path.horizon.eq(0)].iloc[0]
            chosen = path.loc[path.prediction_bp.idxmin()]
            predicted_saving = immediate.prediction_bp - chosen.prediction_bp
            if predicted_saving <= threshold_bp:
                chosen = immediate
            rows.append(
                {
                    "target": target,
                    "candidate": name,
                    "origin": origin,
                    "chosen_horizon": int(chosen.horizon),
                    "chosen_date": chosen.label_end,
                    "deadline": path.deadline.max(),
                    "predicted_saving_bp": float(
                        immediate.prediction_bp - chosen.prediction_bp
                    ),
                    "saving_vs_immediate_bp": float(
                        immediate.target_bp - chosen.target_bp
                    ),
                    "saving_vs_deadline_bp": float(
                        path.iloc[-1].target_bp - chosen.target_bp
                    ),
                    "regret_bp": float(chosen.target_bp - path.target_bp.min()),
                    "threshold_bp": threshold_bp,
                }
            )
    return pd.DataFrame(rows)


def save_rate_experiment(
    output_dir: Path, data: RateDataset, predictions: pd.DataFrame, config: dict
) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    predictions = add_decomposed_predictions(predictions)
    predictions.to_csv(output_dir / "predictions.csv", index=False)
    metrics = rate_metric_table(predictions)
    metrics.to_csv(output_dir / "metrics.csv", index=False)
    policy = evaluate_fixed_origin_policy(predictions)
    policy.to_csv(output_dir / "policy.csv", index=False)
    policy_summary(policy).to_csv(output_dir / "policy-summary.csv", index=False)
    yearly_error_table(predictions).to_csv(
        output_dir / "yearly-metrics.csv", index=False
    )
    manifest = {
        "schema_version": "rate-research-v1",
        "phase": "development_only",
        "held_out_start": "2026-01-01",
        "data": data.audit,
        "config": config,
        "candidates": [
            asdict(candidate)
            for candidate in RATE_CANDIDATES
            if candidate.name in set(predictions.candidate)
        ],
        "component_candidates": [
            candidate
            for candidate in COMPONENT_CANDIDATES
            if candidate[0] in set(predictions.candidate)
        ],
        "source_sha256": hashlib.sha256(
            Path(data.audit["source"]).read_bytes()
        ).hexdigest(),
        "predictions_sha256": hashlib.sha256(
            (output_dir / "predictions.csv").read_bytes()
        ).hexdigest(),
        "limitations": [
            "Development metrics are used for selection, not independent final evidence.",
            "Historical quote snapshots do not prove unrevised point-in-time data.",
            "Policy uses exactly the horizons in config; sparse grids are not full daily strategies.",
            "No issuer coupon, execution cost, liquidity constraint or holiday forecast acceptance yet.",
        ],
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2)
    )
    return manifest
