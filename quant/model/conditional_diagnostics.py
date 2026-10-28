"""条件漂移的市场增益、事前信号与配对成本概率研究；不激活生产。"""

import hashlib
from pathlib import Path

import numpy as np
import pandas as pd

from .export import write_json
from .rate_diagnostics import block_mean_interval, policy_summary, yearly_error_table
from .rate_evaluation import (
    evaluate_rate_candidates,
    rate_metric_table,
    evaluate_fixed_origin_policy,
)
from .rate_forecast import RATE_CANDIDATES
from .rate_intervals import calibrate_rate_intervals
from .rate_policy import evaluate_rolling_policy
from .statistical_validity import market_validity, policy_validity, adjust_test_family


CONDITIONAL_COMPARISON = (
    "random_walk",
    "historical_drift",
    "conditional_drift",
    "recent_drift",
    "robust_drift",
    "smooth_conditional_drift",
    "lgb_anchor_drift",
)


def conditional_protocol():
    return {
        "candidates": CONDITIONAL_COMPARISON,
        "new_candidates": {
            "recent_drift": "1-year mean; fallback to 3-year mean if fewer than 240 mature quote labels",
            "robust_drift": "3-year median, aligned with MAE",
            "smooth_conditional_drift": "3-year ridge alpha1000, six funding/trend/vol/credit/curve inputs; all preprocessing train-only",
        },
        "statistical_protocol": "prespecified h30; 4999 moving-block resamples; 95% CI and one-sided centered-bootstrap p; Holm over all candidate/baseline comparisons per period; no automatic activation",
        "target": "AAA_3Y secondary yield, not issuer coupon",
        "horizons": list(range(31)),
        "training": "quarterly frozen; all labels and deadlines mature before quarter; conditional and drift use same 3-year window",
        "state": "DR007-OMO below -10bp / +/-10bp / above 10bp; 20-quote trend divided by daily vol*sqrt(20), cut +/-1; vol above training median",
        "shrinkage": "state n/(n+120), fallback unconditional mean if n<30 or missing state",
        "overlap": "state sample count is quote count, not independent count; 31-row moving-block intervals and nonoverlap policy windows",
        "signals": "prediction<-2bp; denominator never filtered by future actual direction",
        "periods": "2022-2025 development; 2026 observed reference, no new holdout",
        "policy": "full 0..30 grid; fixed-origin and daily remaining-window; 2bp expected threshold; secondary proxy only",
        "uncertainty": "mature paired h/0 OOS residuals; 252 most recent, minimum120; cost0 and0.1bp/day; P(net>0), P(net>2), Q10",
        "publication": "research_only",
    }


def market_comparisons(predictions):
    rows = []
    frame = predictions.copy()
    frame["period"] = np.where(
        frame.origin.dt.year < 2026, "development", "observed_reference"
    )
    for (period, horizon), group in frame.groupby(["period", "horizon"]):
        if group.groupby("origin").change_bp.nunique(dropna=False).ne(1).any():
            raise ValueError("market candidates have inconsistent actual outcomes")
        actual = group.drop_duplicates("origin").set_index("origin").change_bp
        wide = group.pivot(
            index="origin", columns="candidate", values="prediction_bp"
        ).sort_index()
        if wide.reindex(columns=CONDITIONAL_COMPARISON).isna().any().any():
            raise ValueError("market candidates must cover identical origins")
        actual = actual.reindex(wide.index)
        for name in CONDITIONAL_COMPARISON:
            errors = (wide[name] - actual).abs()
            direction = np.sign(wide[name].where(wide[name].abs() > 0.5, 0))
            realized = np.sign(actual.where(actual.abs() > 0.5, 0))
            signal = wide[name] < -2
            for baseline in ("random_walk", "historical_drift"):
                delta = errors - (wide[baseline] - actual).abs()
                low, high = block_mean_interval(delta)
                rows.append(
                    {
                        "period": period,
                        "horizon": horizon,
                        "candidate": name,
                        "baseline": baseline,
                        "samples": len(group) // len(CONDITIONAL_COMPARISON),
                        "mae_bp": errors.mean(),
                        "mae_difference_bp": delta.mean(),
                        "difference_low90_bp": low,
                        "difference_high90_bp": high,
                        "direction_accuracy": direction.eq(realized).mean(),
                        "always_down_accuracy": realized.eq(-1).mean(),
                        "signal_samples": int(signal.sum()),
                        "actual_decline_given_signal": actual.loc[signal].lt(0).mean(),
                        "mean_actual_change_given_signal_bp": actual.loc[signal].mean(),
                    }
                )
    return pd.DataFrame(rows)


def paired_saving_probabilities(predictions, *, cost=0.0):
    """Calibrate endpoint-minus-today cost using matched mature OOS residuals."""
    rows = []
    for name, group in predictions.groupby("candidate"):
        now = group.loc[group.horizon.eq(0)].set_index("origin")
        for horizon, future in group.loc[group.horizon.isin([5, 10, 20, 30])].groupby(
            "horizon"
        ):
            paired = (
                future.set_index("origin")
                .join(
                    now[["prediction_bp", "change_bp", "label_end", "deadline"]],
                    rsuffix="_now",
                    how="inner",
                    validate="one_to_one",
                )
                .sort_index()
            )
            paired["saving_error"] = (paired.change_bp_now - paired.change_bp) - (
                paired.prediction_bp_now - paired.prediction_bp
            )
            for origin, row in paired.iterrows():
                pool = paired.loc[
                    (paired.index < origin)
                    & paired.label_end.lt(origin)
                    & paired.label_end_now.lt(origin)
                    & paired.deadline.lt(origin)
                    & paired.deadline_now.lt(origin)
                ].tail(252)
                expected = row.prediction_bp_now - row.prediction_bp - horizon * cost
                savings = expected + pool.saving_error
                enough = len(pool) >= 120
                rows.append(
                    {
                        "candidate": name,
                        "origin": origin,
                        "horizon": horizon,
                        "waiting_cost_bp_day": cost,
                        "expected_net_saving_bp": expected,
                        "probability_net_saving_gt0": savings.gt(0).mean()
                        if enough
                        else np.nan,
                        "probability_net_saving_gt2": savings.gt(2).mean()
                        if enough
                        else np.nan,
                        "saving_p10_bp": savings.quantile(0.1) if enough else np.nan,
                        "pair_samples": len(pool),
                        "calibration_deadline": pool.deadline.max(),
                        "actual_net_saving_bp": row.change_bp_now
                        - row.change_bp
                        - horizon * cost,
                        "status": "calibrated_secondary_proxy"
                        if enough
                        else "insufficient_history",
                    }
                )
    return pd.DataFrame(rows)


def run_conditional_research(rates, directory):
    directory.mkdir(parents=True, exist_ok=True)
    write_json(directory / "protocol.json", conditional_protocol())
    candidates = [c for c in RATE_CANDIDATES if c.name in CONDITIONAL_COMPARISON]
    # Separate end boundaries prevent late-December development origins from
    # being scored with next year's observed-reference outcomes.
    predictions = pd.concat(
        [
            evaluate_rate_candidates(
                rates, start=start, end=end, targets=("AAA_3Y",), candidates=candidates
            )
            for start, end in (
                ("2022-01-01", "2026-01-01"),
                ("2026-01-01", "2027-01-01"),
            )
        ],
        ignore_index=True,
    )
    predictions.to_csv(directory / "predictions.csv", index=False)
    comparisons = market_comparisons(predictions)
    comparisons.to_csv(directory / "comparisons.csv", index=False)
    market_validity(predictions).to_csv(
        directory / "statistical-market.csv", index=False
    )
    rate_metric_table(predictions).to_csv(directory / "metrics.csv", index=False)
    yearly_error_table(predictions).to_csv(directory / "years.csv", index=False)
    policies, statistical_policies = [], []
    for mode in ("fixed", "rolling"):
        policy = (
            evaluate_fixed_origin_policy(predictions)
            if mode == "fixed"
            else evaluate_rolling_policy(
                predictions, threshold_bp=2.0, mode="remaining_window"
            )
        )
        policy["mode"] = mode
        policy.to_csv(directory / f"{mode}-policy.csv", index=False)
        policy["period"] = np.where(
            policy.origin.dt.year < 2026, "development", "observed_reference"
        )
        for period, group in policy.groupby("period"):
            valid = (
                group
                if "status" not in group
                else group.loc[group.status.eq("evaluated")]
            )
            summary = policy_summary(valid)
            requested = (
                group.groupby(["target", "candidate"]).size().rename("requested_starts")
            )
            summary = summary.merge(
                requested.reset_index(),
                on=["target", "candidate"],
                validate="one_to_one",
            )
            summary["missing_forecast_starts"] = (
                summary.requested_starts - summary.starts
            )
            summary["mode"], summary["period"] = mode, period
            policies.append(summary)
            tested = policy_validity(valid)
            tested["mode"], tested["period"] = mode, period
            statistical_policies.extend(tested.to_dict(orient="records"))
            tested.to_csv(
                directory / f"statistical-policy-{mode}-{period}.csv", index=False
            )
    pd.concat(policies).to_csv(directory / "policy-summary.csv", index=False)
    adjust_test_family(statistical_policies).to_csv(
        directory / "statistical-policy-all.csv", index=False
    )
    probabilities = pd.concat(
        [paired_saving_probabilities(predictions, cost=c) for c in (0.0, 0.1)]
    )
    probabilities.to_csv(directory / "saving-probabilities.csv", index=False)
    intervals = calibrate_rate_intervals(
        predictions.loc[predictions.horizon.isin([0, 5, 10, 20, 30])], predictions
    )
    intervals.to_csv(directory / "intervals.csv", index=False)
    _interval_summary(intervals).to_csv(
        directory / "interval-coverage.csv", index=False
    )
    _write_conditional_report(comparisons, directory)
    code = [
        "conditional_drift.py",
        "conditional_diagnostics.py",
        "rate_forecast.py",
        "rate_evaluation.py",
        "rate_diagnostics.py",
        "rate_policy.py",
        "rate_intervals.py",
        "statistical_validity.py",
    ]
    write_json(
        directory / "manifest.json",
        {
            "protocol": conditional_protocol(),
            "rates_sha256": hashlib.sha256(
                pd.util.hash_pandas_object(rates.levels_bp).values.tobytes()
            ).hexdigest(),
            "features_sha256": hashlib.sha256(
                pd.util.hash_pandas_object(rates.features).values.tobytes()
            ).hexdigest(),
            "code": {
                name: hashlib.sha256(
                    (Path(__file__).parent / name).read_bytes()
                ).hexdigest()
                for name in code
            },
            "outputs": {
                p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                for p in directory.glob("*.csv")
            },
            "production_replacement": False,
        },
    )
    return comparisons


def _interval_summary(intervals):
    frame = intervals.copy()
    frame["period"] = np.where(
        frame.origin.dt.year < 2026, "development", "observed_reference"
    )
    frame["covered"] = np.where(
        frame.interval_status.eq("calibrated"),
        frame.change_bp.between(frame.lower_change_bp, frame.upper_change_bp),
        np.nan,
    )
    frame["width_bp"] = frame.upper_change_bp - frame.lower_change_bp
    return frame.groupby(["period", "candidate", "horizon"], as_index=False).agg(
        requested=("origin", "size"),
        calibrated=("covered", "count"),
        coverage=("covered", "mean"),
        mean_width_bp=("width_bp", "mean"),
    )


def _write_conditional_report(comparisons, directory):
    lines = [
        "# 条件历史漂移验证",
        "",
        "条件漂移使用资金、趋势和波动18个粗状态；不足30个报价样本回退同窗口无条件漂移，"
        "其余按n/(n+120)收缩。仅训练期估计波动阈值，逐季度冻结；不加入缺少时点历史的事件或询价数据。",
        "",
        "以下是AAA3Y二级市场30自然日变化，不是发行人最终票面。负的MAE差表示优于历史漂移。"
        "90%区间使用31行moving-block bootstrap保留重叠相关性；仍不消除模型搜索偏差。",
        "正式统计准入另见statistical-market.csv的95%区间与Holm校正p值；"
        "策略准入使用statistical-policy-all.csv的完整校正家族，不能用下表90%描述区间代替。",
        "",
        "| 期间 | 模型 | 样本 | MAE(bp) | 较漂移MAE差 | 90%差区间 | 方向准确率 | 预测<-2bp样本 | 条件下跌比例 |",
        "|---|---|---:|---:|---:|---|---:|---:|---:|",
    ]
    selected = comparisons.loc[
        comparisons.horizon.eq(30) & comparisons.baseline.eq("historical_drift")
    ]
    for r in selected.itertuples():
        lines.append(
            f"| {r.period} | {r.candidate} | {r.samples} | {r.mae_bp:.3f} | {r.mae_difference_bp:.3f} | [{r.difference_low90_bp:.3f}, {r.difference_high90_bp:.3f}] | {r.direction_accuracy:.1%} | {r.signal_samples} | {r.actual_decline_given_signal:.1%} |"
        )
    lines += [
        "",
        "2026是已观察参考，不能用本表重选状态阈值。方向分母包括中性行情，信号集合只按事前预测筛选；"
        "不可先筛掉实际未下跌的日子。",
        "",
        "policy-summary.csv分别记录完整窗口固定选日和每日停止策略，相对立即/截止日、最差年份、"
        "31行块区间和非重叠起点。saving-probabilities.csv给出净节约超过0/2bp及10%分位，"
        "只来自当时已成熟的同起点配对误差；interval-coverage.csv检验区间实际覆盖与宽度。",
        "",
        "这些都是二级收益率代理，无执行成本、流动性和一级溢价动态验证，不能当成公司实际省钱概率。"
        "未通过稳定增益与前向验证前不激活生产，也不放宽80%概率及尾部风险门槛。",
    ]
    (directory / "report.md").write_text("\n".join(lines) + "\n")
