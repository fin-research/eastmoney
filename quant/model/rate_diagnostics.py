"""收益率分解候选与保留时间相关性的研究诊断。"""

import numpy as np
import pandas as pd

from .statistical_validity import paired_block_test


COMPONENT_CANDIDATES = (
    ("decomposed_short", "random_walk", "lgb_anchor_1"),
    ("decomposed_drift_short", "historical_drift", "lgb_anchor_1"),
    ("decomposed_drift_direct", "historical_drift", "lgb_shallow"),
    ("decomposed_drift_ridge", "historical_drift", "ridge_all_10000"),
)


def add_decomposed_predictions(predictions: pd.DataFrame) -> pd.DataFrame:
    """以同一起点、终点的国债变化加信用利差变化，重建 AAA 收益率变化。"""
    rows = [predictions]
    keys = ["origin", "horizon", "fold"]
    base = predictions.loc[
        predictions.target.eq("AAA_3Y") & predictions.candidate.eq("random_walk")
    ].set_index(keys)
    for name, gov_model, credit_model in COMPONENT_CANDIDATES:
        gov = predictions.loc[
            predictions.target.eq("GOV_3Y") & predictions.candidate.eq(gov_model)
        ].set_index(keys)
        credit = predictions.loc[
            predictions.target.eq("CREDIT_3Y") & predictions.candidate.eq(credit_model)
        ].set_index(keys)
        if gov.empty or credit.empty or base.empty:
            continue
        if not base.index.equals(gov.index) or not base.index.equals(credit.index):
            raise ValueError("component origin/horizon coverage differs")
        if not base.label_end.equals(gov.label_end) or not base.label_end.equals(
            credit.label_end
        ):
            raise ValueError("component quote endpoints differ")
        if not np.allclose(base.change_bp, gov.change_bp + credit.change_bp):
            raise ValueError("component targets or units do not reconstruct AAA yield")
        result = base.copy()
        result["prediction_bp"] = gov.prediction_bp + credit.prediction_bp
        result["candidate"] = name
        result["train_label_end"] = pd.concat(
            [gov.train_label_end, credit.train_label_end], axis=1
        ).max(axis=1)
        result["train_samples"] = pd.concat(
            [gov.train_samples, credit.train_samples], axis=1
        ).min(axis=1)
        rows.append(result.reset_index())
    return pd.concat(rows, ignore_index=True)


def block_mean_interval(
    values, block_size: int = 31, repetitions: int = 2000
) -> tuple[float, float]:
    """统一循环块90%区间；至少8块，不因增加抽样次数夸大小样本精度。"""
    result = paired_block_test(
        values, block_size=block_size, repetitions=repetitions, confidence=0.9
    )
    return result["low95_bp"], result["high95_bp"]


def policy_summary(policy: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for (target, candidate), group in policy.groupby(["target", "candidate"]):
        group = group.sort_values("origin")
        lower, upper = block_mean_interval(group.saving_vs_immediate_bp)
        end_lower, end_upper = block_mean_interval(group.saving_vs_deadline_bp)
        yearly = (
            group.assign(year=pd.to_datetime(group.origin).dt.year)
            .groupby("year")
            .saving_vs_immediate_bp.mean()
        )
        # 固定从首个有效起点开始，上一窗口到期后才能进入下一窗口。
        nonoverlap = []
        next_origin = pd.Timestamp.min
        for row in group.itertuples():
            if pd.Timestamp(row.origin) > next_origin:
                nonoverlap.append(row.saving_vs_immediate_bp)
                next_origin = pd.Timestamp(row.deadline)
        rows.append(
            {
                "target": target,
                "candidate": candidate,
                "starts": len(group),
                "wait_share": float(group.chosen_horizon.gt(0).mean()),
                "mean_wait_days": float(group.chosen_horizon.mean()),
                "cost_increase_share": float(group.saving_vs_immediate_bp.lt(0).mean()),
                "saving_p05_bp": float(group.saving_vs_immediate_bp.quantile(0.05)),
                "saving_vs_immediate_bp": float(group.saving_vs_immediate_bp.mean()),
                "saving_ci90_low": lower,
                "saving_ci90_high": upper,
                "saving_vs_deadline_bp": float(group.saving_vs_deadline_bp.mean()),
                "deadline_ci90_low": end_lower,
                "deadline_ci90_high": end_upper,
                "worst_year_saving_bp": float(yearly.min()),
                "nonoverlap_starts": len(nonoverlap),
                "nonoverlap_saving_bp": float(np.mean(nonoverlap)),
                "mean_regret_bp": float(group.regret_bp.mean()),
            }
        )
    return pd.DataFrame(rows)


def yearly_error_table(predictions: pd.DataFrame) -> pd.DataFrame:
    frame = predictions.copy()
    frame["year"] = pd.to_datetime(frame.origin).dt.year
    frame["absolute_error"] = (frame.prediction_bp - frame.change_bp).abs()
    frame["baseline_error"] = frame.change_bp.abs()
    result = (
        frame.groupby(["target", "horizon", "candidate", "year"])
        .agg(
            n=("origin", "size"),
            mae_bp=("absolute_error", "mean"),
            rw_mae_bp=("baseline_error", "mean"),
        )
        .reset_index()
    )
    result["skill_mae"] = 1 - result.mae_bp / result.rw_mae_bp.clip(lower=1e-12)
    return result
