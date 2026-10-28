"""Reproducible decision-learning evidence, separate from the three-field result."""

import hashlib
from pathlib import Path

import numpy as np
import pandas as pd

from data.issuance_calendar import IssuanceCalendar
from .export import write_json
from .statistical_validity import adjust_test_family, paired_block_test
from .timing_policy import (
    ACTION_HORIZONS,
    current_timing_signal,
    evaluate_timing_policies,
    nonoverlap_indices,
    timing_protocol,
)


def timing_statistics(policies, *, start="2022-01-01", days=30):
    """All candidates, costs and periods retained, with familywise error control."""
    evaluation = policies.loc[policies.origin.ge(start)].copy()
    baseline_horizons = tuple(dict.fromkeys((0, 7, days)))
    if evaluation.duplicated(["policy", "origin"]).any():
        raise ValueError("duplicate timing policy origins")
    if (
        evaluation.groupby("origin")
        .policy.nunique()
        .ne(evaluation.policy.nunique())
        .any()
    ):
        raise ValueError("timing policies must share complete origins")
    if (
        not np.isfinite(
            evaluation[
                ["realized_cost_bp", *[f"baseline_{h}_bp" for h in baseline_horizons]]
            ]
        )
        .all()
        .all()
    ):
        raise ValueError("nonfinite timing costs")
    evaluation["period"] = np.where(
        evaluation.origin.dt.year < 2026, "development", "observed_reference"
    )
    records, summaries = [], []
    family_size = sum(
        3
        for (_, name), _ in evaluation.groupby(["period", "policy"])
        for horizon in baseline_horizons
        if name != f"fixed_{horizon}"
    )
    repetitions = max(4999, family_size * 200 - 1)
    for (period, name), group in evaluation.groupby(["period", "policy"]):
        group = group.sort_values("origin")
        buckets = group.get("action_bucket", group.chosen_horizon).fillna(
            group.chosen_horizon
        )
        sparse = group.loc[nonoverlap_indices(group)]
        summaries.append(
            {
                "period": period,
                "policy": name,
                "origins": len(group),
                "nonoverlap_windows": len(sparse),
                "cost_bp": group.realized_cost_bp.mean(),
                "regret_bp": group.regret_bp.mean(),
                "cost_p90_bp": group.realized_cost_bp.quantile(0.9),
                **{
                    f"action_{h}_count": int(buckets.eq(h).sum())
                    for h in baseline_horizons
                },
            }
        )
        for horizon in baseline_horizons:
            if name == f"fixed_{horizon}":
                continue
            for method, observations, block in (
                (f"daily_block{days + 1}", group, days + 1),
                (f"daily_block{2 * days + 3}", group, 2 * days + 3),
                ("nonoverlap_block3", sparse, 3),
            ):
                gain = (
                    observations[f"baseline_{horizon}_bp"]
                    - observations.realized_cost_bp
                )
                records.append(
                    {
                        "period": period,
                        "policy": name,
                        "baseline": f"fixed_{horizon}",
                        "method": method,
                        **paired_block_test(
                            gain, block_size=block, repetitions=repetitions
                        ),
                        "bootstrap_repetitions": repetitions,
                    }
                )
    tests = adjust_test_family(records)
    yearly = (
        evaluation.assign(year=evaluation.origin.dt.year)
        .groupby(["policy", "year"])
        .agg(
            origins=("origin", "size"),
            cost_bp=("realized_cost_bp", "mean"),
            regret_bp=("regret_bp", "mean"),
            fixed_0_bp=("baseline_0_bp", "mean"),
            fixed_7_bp=("baseline_7_bp", "mean"),
            fixed_deadline_bp=(f"baseline_{days}_bp", "mean"),
        )
        .reset_index()
    )
    return tests, pd.DataFrame(summaries), yearly


def research_admission(tests, days=30):
    primary = tests.loc[
        tests.policy.eq("nested_cost_policy") & tests.period.eq("development")
    ]
    expected = {f"fixed_{h}" for h in (0, 7, days)}
    passed = (
        len(primary) == 3 * len(expected)
        and set(primary.baseline) == expected
        and primary.significant_95.all()
        and primary.gain_bp.ge(1.0).all()
    )
    return {
        "historical_proxy_gate_passed": bool(passed),
        "issuer_timing_effectiveness_established": False,
        "production_activation": False,
        "reason": "historical proxy result requires new forward and issuer evidence"
        if passed
        else "nested policy did not robustly beat every fixed-date baseline",
    }


def _signal_artifact(engine, policies, date, terms, waiting_cost):
    calendar = IssuanceCalendar()
    end = date + pd.Timedelta(days=30)
    dates = calendar.issuance_dates(date, end)
    if dates.empty:
        raise ValueError("no executable date in 30-day window")
    chosen_dates = [
        dates[dates <= date + pd.Timedelta(days=h)][-1]
        if len(dates[dates <= date + pd.Timedelta(days=h)])
        else dates[0]
        for h in ACTION_HORIZONS
    ]
    # Reuse current forecaster freshness/calendar checks and actual TreeSHAP.
    engine.window(date, 30, terms)
    signal = current_timing_signal(engine.rates, policies, date, waiting_cost)
    quote_origin = calendar.quote_dates(date, end)[0]
    target = pd.Timestamp(chosen_dates[signal["action_index"]])
    forecast = engine.predict_one(date, quote_origin, target, terms)
    explanation = engine.explain(date, quote_origin, target, terms)
    result = {
        "发行建议": f"研究信号（未经有效性验证）：{signal['action']}",
        "预测发行利率": forecast["coupon_percent"],
        "驱动因素SHAP": explanation,
    }
    signal["scope"] = (
        "research action; AAA3Y proxy; coupon/SHAP are separate reference model"
    )
    signal["calendar_mapping"] = (
        "research signal keeps 0/7/30 quote clock; reference coupon alone mapped to exchange day"
    )
    signal["reference_coupon_date"] = target
    return result, signal


def write_timing_review(directory, summaries, tests, yearly, admission):
    lines = [
        "# 债券融资择时：直接决策学习",
        "",
        "诊断目标为同一起点的发行成本差；0/7/30自然日是三个固定发行期限，不代表完整业务中的尽快、等待、暂缓。",
        "一级票面与SHAP沿用独立参考模型，不把定价误差改善当成择时收益。",
        "",
        "季度训练和季度选择均冻结。先产生逐季度样本外预测，再仅用当时已成熟的最近两年预测损益调参；不足12个非重叠窗口回退固定7日。",
        "原始及波动标准化模型、固定等权组合、0/2bp平局规则和三个固定期限基准全部保留；选择依据为成本，不使用分类准确率。",
        "",
        "## 滚动选择策略",
        "",
        "|时期|起点数|非重叠窗口|当日/第7日/第30日|相对当日成本(bp)|事后最优后悔损失(bp)|",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for row in summaries.loc[summaries.policy.eq("nested_cost_policy")].itertuples():
        lines.append(
            f"|{row.period}|{row.origins}|{row.nonoverlap_windows}|"
            f"{row.action_0_count}/{row.action_7_count}/{row.action_30_count}|"
            f"{row.cost_bp:.3f}|{row.regret_bp:.3f}|"
        )
    lines += [
        "",
        "## 统计检验",
        "",
        "正差值表示成本低于基准。全部模型、时期、基准和三种相关性检验组成同一Holm家族；不从多个期限里挑显著结果。",
        "",
        "|时期|基准|方法|成本改善(bp)|95%区间|Holm p|",
        "|---|---|---|---:|---|---:|",
    ]
    for row in tests.loc[tests.policy.eq("nested_cost_policy")].itertuples():
        lines.append(
            f"|{row.period}|{row.baseline}|{row.method}|{row.gain_bp:.3f}|"
            f"[{row.low95_bp:.3f}, {row.high95_bp:.3f}]|{row.p_holm:.4f}|"
        )
    lines += [
        "",
        "## 年度稳定性",
        "",
        "|年|实际相对当日成本(bp)|固定7日(bp)|固定30日(bp)|",
        "|---|---:|---:|---:|",
    ]
    for row in yearly.loc[yearly.policy.eq("nested_cost_policy")].itertuples():
        lines.append(
            f"|{row.year}|{row.cost_bp:.3f}|{row.fixed_7_bp:.3f}|{row.fixed_deadline_bp:.3f}|"
        )
    lines += [
        "",
        "## 结论与边界",
        "",
        f"历史代理准入：{'通过' if admission['historical_proxy_gate_passed'] else '未通过'}。真实一级发行择时有效性尚未确立。",
        "2019起数据仅约8年；2022—2026已在先前研究中被观察，滚动预测不能消除研究者选择偏差。",
        "日频AAA3Y是市场代理，并非发行人每天都能成交的一级票面；历史报价日也不是完整交易所发行日历。",
        "同日市场变化从等待收益中扣除，消除原模型把短期票面定价能力误计为择时能力的问题。",
        "research-result.json仅为三字段研究信号；准入失败不生成result.json或覆盖生产。通过代理检验后仍需新前向冻结和真实发行验证。",
        "",
        "方法依据：[嵌套验证](https://scikit-learn.org/stable/auto_examples/model_selection/plot_nested_cross_validation_iris.html)、"
        "[回测过拟合](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)。",
        "",
    ]
    (directory / "review.md").write_text("\n".join(lines))


def run_timing_research(engine, directory, date, terms, waiting_cost=0.0):
    if not np.isfinite(waiting_cost) or waiting_cost < 0:
        raise ValueError("waiting cost must be finite and nonnegative")
    directory.mkdir(parents=True, exist_ok=True)
    protocol = timing_protocol()
    protocol["version"] = "timing-cost-v3-statistics"
    protocol["inference"] = (
        "circular blocks, minimum eight blocks, all direct comparisons in one Holm family"
    )
    protocol["waiting_cost_bp_day"] = waiting_cost
    protocol["waiting_cost_role"] = (
        "fixed business input, not a hyperparameter; comparisons across separate runs are descriptive only"
    )
    protocol["scope"] = (
        f"previously observed historical market proxy through {date.date()}; not issuer execution evidence"
    )
    protocol["as_of"] = date
    protocol["data_audit"] = engine.rates.audit
    protocol["data_sha256"] = hashlib.sha256(
        pd.util.hash_pandas_object(engine.rates.levels_bp).values.tobytes()
    ).hexdigest()
    protocol["features_sha256"] = hashlib.sha256(
        pd.util.hash_pandas_object(engine.rates.features).values.tobytes()
    ).hexdigest()
    root = Path(__file__).resolve().parents[1]
    protocol["code_sha256"] = {
        p: hashlib.sha256((root / p).read_bytes()).hexdigest()
        for p in (
            "model/timing_policy.py",
            "model/timing_research.py",
            "model/rate_forecast.py",
            "data/rate_data.py",
            "data/feature_engineering.py",
            "model/statistical_validity.py",
        )
    }
    # Never silently replace an experiment after seeing its result.
    if (directory / "protocol.json").exists():
        raise ValueError(
            "experiment directory already frozen; use a new output directory"
        )
    write_json(directory / "protocol.json", protocol)
    policies, selections = evaluate_timing_policies(
        engine.rates, end=date, waiting_cost=waiting_cost
    )
    policies.to_csv(directory / "policies.csv", index=False)
    selections.to_csv(directory / "selections.csv", index=False)
    tests, summary, yearly = timing_statistics(policies)
    tests.to_csv(directory / "statistics.csv", index=False)
    summary.to_csv(directory / "summary.csv", index=False)
    yearly.to_csv(directory / "yearly.csv", index=False)
    admission = research_admission(tests)
    write_json(directory / "admission.json", admission)
    result, signal = _signal_artifact(engine, policies, date, terms, waiting_cost)
    write_json(directory / "research-result.json", result)
    write_json(directory / "signal-evidence.json", signal)
    write_timing_review(directory, summary, tests, yearly, admission)
    print(
        f"[timing] evidence saved to {directory}; historical gate={admission['historical_proxy_gate_passed']}"
    )
    return result
