"""Fixed-origin full-window selection research and four-field business artifact."""

from dataclasses import asdict
import hashlib
from pathlib import Path

import numpy as np
import pandas as pd

from data.issuance_calendar import IssuanceCalendar
from .export import write_json
from .primary_pricing import primary_history_statistics
from .rate_curve import (
    CURVE_CANDIDATES,
    curve_labels,
    evaluate_curves,
    explain_curve,
    fit_curve,
    predict_curve,
)
from .timing_policy import select_policy
from .timing_research import timing_statistics, research_admission


def peer_position(history, terms, as_of):
    stats = primary_history_statistics(history, terms, as_of)
    own = stats["own_premium_bp"]
    peer = stats["peer_premium_bp"]
    pool = (
        history.loc[
            history.label_available_date.lt(as_of)
            & history.label_available_date.ge(as_of - pd.Timedelta(days=730))
            & history.rating.eq(terms["rating"])
            & history.bond_type.eq(terms["bond_type"])
            & np.isclose(history.tenor, terms["tenor"])
        ]
        .groupby(["issuer", "label_available_date"])
        .peer_residual_bp.median()
        .dropna()
    )
    relative = float(own - peer) if np.isfinite(own) and np.isfinite(peer) else None
    percentile = (
        float(pool.le(relative).mean())
        if relative is not None and len(pool) >= 30
        else None
    )
    return {
        "同业超额利差bp": relative,
        "历史分位": percentile,
        "历史事件数": len(pool),
        "用途": "参考；未证实分位阈值能改善未来选日",
        "口径": "真实簿记票面减同日市场锚，再减当时已成熟同业溢价",
    }


def _choose_current_dates(selected, horizons, net):
    near = np.flatnonzero(net <= net.min() + 0.5)
    if selected.startswith("fixed_"):
        fixed = int(selected.split("_")[1])
        eligible = np.flatnonzero(horizons <= fixed)
        near = np.asarray([int(eligible[-1]) if len(eligible) else 0])
    return int(near[0]), near


def selected_cost_uncertainty(policies, policy, as_of, expected_cost, target):
    """Diagnostic selected-rule residuals; no marginal-independence assumption."""
    if policy.startswith("fixed_") or target != "AAA_3Y":
        return {"status": "not_calibrated", "samples": 0}
    past = (
        policies.loc[
            policies.policy.eq(policy)
            & policies.deadline.lt(as_of)
            & policies.origin.lt(as_of)
        ]
        .sort_values("origin")
        .tail(252)
    )
    errors = past.realized_cost_bp - past.predicted_selected_bp
    if len(errors) < 120 or not np.isfinite(errors).all():
        return {"status": "insufficient_history", "samples": len(errors)}
    realized_cost = expected_cost + errors
    return {
        "status": "historical_selected_rule_residuals",
        "samples": len(errors),
        "latest_deadline": past.deadline.max(),
        "saving_probability": float(realized_cost.lt(0).mean()),
        "saving_p10_bp": float(np.quantile(-realized_cost, 0.1)),
        "scope": "market proxy; overlapping historical OOS residuals; not issuer execution probability",
    }


def current_curve_result(
    engine,
    rates,
    policies,
    as_of,
    days,
    terms,
    waiting_cost,
    admission,
    target="AAA_3Y",
):
    cutoff = as_of.to_period("Q").start_time
    selection_years = max(2, int(np.ceil(days * 13 / 365)) + 1)
    selected, count, last = select_policy(
        policies, cutoff, lookback_years=selection_years
    )
    # A fixed action baseline has no predictive curve. Provide the registered
    # drift reference explicitly, without attributing its curve to that baseline.
    names = [selected] if selected.startswith("curve_") else ["curve_drift"]
    if selected == "curve_ensemble":
        names = [c.name for c in CURVE_CANDIDATES if c.kind not in ("zero", "mean")]
    source = rates.levels_bp.index[rates.levels_bp.index < as_of][-1]
    X = rates.market_features.loc[[source]].copy()
    X["decision_weekday"] = as_of.weekday()
    X["decision_month_end"] = as_of.days_in_month - as_of.day
    labels, costs = curve_labels(rates, days, target)
    fits = [
        fit_curve(rates, labels, costs, cutoff, c, target)
        for c in CURVE_CANDIDATES
        if c.name in names
    ]
    path = np.mean([predict_curve(f, X)[0] for f in fits], axis=0)
    government_path = np.zeros(days + 1)
    if target == "CREDIT_3Y":
        gov_labels, gov_costs = curve_labels(rates, days, "GOV_3Y")
        gov_fit = fit_curve(
            rates, gov_labels, gov_costs, cutoff, CURVE_CANDIDATES[1], "GOV_3Y"
        )
        government_path = predict_curve(gov_fit, X)[0]
    calendar = IssuanceCalendar()
    dates = calendar.issuance_dates(as_of, as_of + pd.Timedelta(days=days))
    if dates.empty:
        raise ValueError("no eligible issuance dates in window")
    first = dates[0]
    engine.window(as_of, min(days, 30), terms)  # freshness and pricing checks
    quote_origin = calendar.quote_dates(as_of, first)[0]
    anchor = (
        engine.predict_one(as_of, quote_origin, first, terms)["coupon_percent"] * 100
    )
    horizons = (dates - as_of).days.to_numpy()
    total_path = path + government_path
    forecast = anchor + total_path[horizons] - total_path[horizons[0]]
    net = path[horizons] + (horizons - horizons[0]) * waiting_cost
    chosen, near = _choose_current_dates(selected, horizons, net)
    action = "尽快" if (dates[chosen] - first).days <= 3 else "等待"
    position = peer_position(engine.history, terms, as_of)
    # No unvalidated percentile veto. Retain 'defer' as a research condition,
    # rather than inventing a horizon-outside-window return.
    explanations = [explain_curve(f, X, int(horizons[chosen])) for f in fits]
    starts = [explain_curve(f, X, int(horizons[0])) for f in fits]
    contributors = {}
    for explanation, initial in zip(explanations, starts, strict=True):
        start_contrib = {r["feature"]: r["shap_bp"] for r in initial["features"]}
        for row in explanation["features"]:
            contributors[row["feature"]] = contributors.get(row["feature"], 0.0) + (
                row["shap_bp"] - start_contrib[row["feature"]]
            ) / len(explanations)
    baseline = (
        anchor
        + government_path[horizons[chosen]]
        - government_path[horizons[0]]
        + float(
            np.mean(
                [
                    e["base_bp"] - s["base_bp"]
                    for e, s in zip(explanations, starts, strict=True)
                ]
            )
        )
    )
    if not np.isclose(
        baseline + sum(contributors.values()), forecast[chosen], atol=1e-7
    ):
        raise ValueError("final coupon curve SHAP does not reconstruct forecast")
    shap = {
        "解释目标": "候选日发行票面；当前票面锚和固定一级溢价计入基准",
        "单位": "bp",
        "基准": float(baseline),
        "预测值": float(forecast[chosen]),
        "方法": sorted({e["method"] for e in explanations}),
        "因子": [{"feature": k, "shap_bp": v} for k, v in contributors.items()],
    }
    result = {
        "发行建议": {
            "建议": action,
            "候选日期": [str(dates[i].date()) for i in near],
            "状态": "研究信号，尚未证明真实发行择时有效",
            "历史代理准入": admission["historical_proxy_gate_passed"],
            "同业定价参考": position,
        },
        "预测发行利率": {
            "日期": str(dates[chosen].date()),
            "百分数": float(forecast[chosen]) / 100,
        },
        "未来窗口走势": [
            {"日期": str(date.date()), "预测发行利率": float(value) / 100}
            for date, value in zip(dates, forecast, strict=True)
        ],
        "驱动因素SHAP": shap,
    }
    audit = {
        "as_of": as_of,
        "source_date": source,
        "selected_policy": selected,
        "curve_models": names,
        "selection_windows": count,
        "selection_latest_deadline": last,
        "warning": "fixed-policy selection and reference curve selection are distinct; research only",
        "primary_premium": "held fixed across horizon; daily primary outcomes unavailable",
        "curve_target": target,
        "selected_cost_uncertainty": selected_cost_uncertainty(
            policies, selected, as_of, float(net[chosen] - net[0]), target
        ),
    }
    return result, audit


def run_curve_research(
    engine, rates, directory, as_of, days, terms, waiting_cost=0.0, target="AAA_3Y"
):
    if not np.isfinite(waiting_cost) or waiting_cost < 0:
        raise ValueError("waiting cost must be finite and nonnegative")
    directory.mkdir(parents=True, exist_ok=True)
    if (directory / "protocol.json").exists():
        raise ValueError("experiment already frozen; choose a new directory")
    root = Path(__file__).resolve().parents[1]
    first_year = max(2013, int(rates.levels_bp.index[0].year) + 3)
    evaluation_start = f"{first_year}-01-01"
    protocol = {
        "version": "joint-curve-v2",
        "curve_target": target,
        "evaluation_target": "AAA3Y absolute financing cost, including when signal target is credit spread",
        "as_of": as_of,
        "window_days": days,
        "first_oos_fold": evaluation_start,
        "candidates": [asdict(c) for c in CURVE_CANDIDATES],
        "basis": "x, x(1-x), x(1-x)(x-0.5); fixed before fitting",
        "objective": "predict complete future-minus-current cost path; earliest executable day within 0.5bp of predicted minimum",
        "selection": "quarterly frozen models, past five years mature full paths; nested mature OOS costs",
        "waiting_cost_bp_day": waiting_cost,
        "phase": "retrospective research; 2010-2018 newly retrieved, 2019-2026 previously observed",
        "calendar": "historical quoted weekdays proxy; live verified exchange calendar",
        "data_audit": rates.audit,
        "data_sha256": hashlib.sha256(
            pd.util.hash_pandas_object(rates.levels_bp).values.tobytes()
        ).hexdigest(),
        "features_sha256": hashlib.sha256(
            pd.util.hash_pandas_object(rates.features).values.tobytes()
        ).hexdigest(),
        "code_sha256": {
            p: hashlib.sha256((root / p).read_bytes()).hexdigest()
            for p in (
                "model/rate_curve.py",
                "model/curve_research.py",
                "data/rate_data.py",
                "data/feature_engineering.py",
                "model/rate_forecast.py",
                "model/primary_pricing.py",
                "model/timing_policy.py",
                "pipeline.py",
                "model/statistical_validity.py",
                "model/timing_research.py",
            )
        },
    }
    write_json(directory / "protocol.json", protocol)
    policies, selections = evaluate_curves(
        rates,
        days=days,
        start=evaluation_start,
        waiting_cost=waiting_cost,
        target=target,
        path_directory=directory / "paths",
    )
    policies.to_csv(directory / "policies.csv", index=False)
    selections.to_csv(directory / "selections.csv", index=False)
    tests, summary, yearly = timing_statistics(
        policies, start=f"{first_year + 1}-01-01", days=days
    )
    tests.to_csv(directory / "statistics.csv", index=False)
    summary.to_csv(directory / "summary.csv", index=False)
    yearly.to_csv(directory / "yearly.csv", index=False)
    admission = research_admission(tests, days)
    write_json(directory / "admission.json", admission)
    result, audit = current_curve_result(
        engine, rates, policies, as_of, days, terms, waiting_cost, admission, target
    )
    write_json(directory / "research-result.json", result)
    write_json(directory / "current-evidence.json", audit)
    print(
        f"[curve] saved {directory}; historical gate={admission['historical_proxy_gate_passed']}"
    )
    return result
