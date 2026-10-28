"""一级层有限候选与逐时点选择；复用真实事件预测，不建立另一套市场模型。"""

import hashlib
from pathlib import Path

import numpy as np
import pandas as pd

from .export import write_json
from .primary_pricing import primary_history_statistics, coupon_predictions


BASELINE = "issuer_absolute"
PRIMARY_CHALLENGERS = (
    BASELINE,
    "issuer_recent_30",
    "issuer_last_blend",
    "issuer_curve_adjusted",
    "issuer_shrink_3",
    "issuer_relative_3",
)
EVENT_KEYS = ["issuer", "pricing_date"]
TERM_KEYS = ["issuer", "rating", "tenor", "bond_type"]


def optimization_protocol():
    return {
        "candidates": [*PRIMARY_CHALLENGERS, "walk_forward_primary"],
        "market": "unchanged lgb_anchor_drift predictions on identical origins",
        "recent_half_life_days": 30,
        "last_blend_weight": 0.5,
        "curve_adjustment": "piecewise linear GOV 1/3/10Y slope proxy; historical premium net of pricing-date slope, add prior-quote slope",
        "selector": {
            "lookback_days": 730,
            "minimum_events": 8,
            "minimum_gain_bp": 1.0,
            "pool": "same issuer/rating/tenor/type, event-weighted mature past losses",
            "fallback": BASELINE,
        },
        "development": "2022-01-01 <= pricing_date < 2026-01-01",
        "reference": "2026 previously observed; never a new holdout",
        "shortlist_gate": {
            "minimum_events": 12,
            "minimum_years": 3,
            "minimum_gain_bp": 1.0,
            "maximum_annual_deterioration_bp": 1.0,
            "event_cluster_low95_bp": "> 0 versus current AND fixed flat baseline",
            "coverage": "all baseline-valid cases, no candidate-specific exclusions",
        },
        "activation": "research only; fresh forward evidence and runtime parity required",
        "timing": "primary-level changes cancel in same-origin cost differences; no timing alpha claim",
    }


def tenor_curve_gap(features, tenors):
    """Same-date government slope proxy relative to 3Y, in bp; not an AAA curve."""
    tenors = np.asarray(tenors, dtype=float)
    short = features.short_term_spread.to_numpy() * 100
    long = (features.term_spread - features.short_term_spread).to_numpy() * 100
    return np.where(tenors <= 3, (tenors - 3) / 2 * short, (tenors - 3) / 7 * long)


def primary_challenger_paths(paths, engine):
    """Change only the premium; preserve the exact market path and sample set."""
    frame = paths.loc[
        paths.candidate.eq("lgb_anchor_drift") & paths.status.eq("estimated")
    ].copy()
    for column in ("as_of", "pricing_date", "label_available_date"):
        frame[column] = pd.to_datetime(frame[column])
    if frame.empty:
        raise ValueError("optimization needs baseline-valid issuance paths")
    curve_history = engine.history.copy()
    curves = engine.rates.market_features.loc[curve_history.market_anchor_date]
    curve_history["premium_bp"] -= tenor_curve_gap(curves, curve_history.tenor)
    cache, rows = {}, []
    for row in frame.to_dict(orient="records"):
        key = (row["as_of"], *(row[k] for k in TERM_KEYS))
        if key not in cache:
            stats = engine.context(row["as_of"], row)
            recent = primary_history_statistics(
                engine.history, row, row["as_of"], half_life_days=30
            )
            premiums = coupon_predictions(stats, 0.0)
            premiums["issuer_recent_30"] = coupon_predictions(recent, 0.0)[BASELINE]
            last = stats["last_issuer_premium_bp"]
            if not np.isfinite(last):
                last = stats["peer_premium_bp"]
            premiums["issuer_last_blend"] = (premiums[BASELINE] + last) / 2
            adjusted = primary_history_statistics(curve_history, row, row["as_of"])
            source = pd.Timestamp(row["market_source_date"])
            gap = tenor_curve_gap(
                engine.rates.market_features.loc[[source]], [row["tenor"]]
            )[0]
            premiums["issuer_curve_adjusted"] = (
                coupon_predictions(adjusted, 0.0)[BASELINE] + gap
            )
            cache[key] = premiums
        premiums = cache[key]
        current = row["prediction_coupon_bp"]
        reconstructed = (
            row["source_market_bp"] + row["market_change_bp"] + premiums[BASELINE]
        )
        if not np.isclose(current, reconstructed, atol=1e-7, rtol=0):
            raise ValueError("primary optimization baseline differs from replay")
        for name in PRIMARY_CHALLENGERS:
            prediction = (
                row["source_market_bp"] + row["market_change_bp"] + premiums[name]
            )
            rows.append(
                {
                    **row,
                    "primary_candidate": name,
                    "prediction_bp": prediction,
                    "baseline_prediction_bp": current,
                    "baseline_flat_bp": row["flat_coupon_bp"],
                }
            )
    return pd.DataFrame(rows)


def walk_forward_primary(predictions):
    """Select from earlier matured events only; duplicate bonds/origins add no votes."""
    frame = predictions.copy()
    frame["loss"] = (frame.prediction_bp - frame.actual_coupon_bp).abs()
    keys = ["date_basis", *TERM_KEYS, "pricing_date", "primary_candidate"]
    events = frame.groupby(keys, as_index=False).agg(
        loss=("loss", "mean"),
        requested=("loss", "size"),
        covered=("loss", "count"),
        label_available_date=("label_available_date", "max"),
        last_origin=("as_of", "max"),
    )
    events.loc[events.covered.ne(events.requested), "loss"] = np.nan
    groups = ["date_basis", *TERM_KEYS]
    pools = {key: group for key, group in events.groupby(groups)}
    choices, rows = {}, []
    identity = ["date_basis", "bond_code", "as_of", "event_lead_days"]
    for _, group in frame.groupby(identity, sort=False):
        baseline = group.loc[group.primary_candidate.eq(BASELINE)].iloc[0]
        pool_key = tuple(baseline[k] for k in groups)
        key = (pool_key, baseline.as_of)
        if key not in choices:
            past = pools[pool_key]
            past = past.loc[
                past.label_available_date.lt(baseline.as_of)
                & past.last_origin.lt(baseline.as_of)
                & past.label_available_date.ge(baseline.as_of - pd.Timedelta(days=730))
            ]
            losses = past.pivot(
                index="pricing_date", columns="primary_candidate", values="loss"
            )
            losses = losses.reindex(columns=PRIMARY_CHALLENGERS).dropna()
            name = BASELINE
            if len(losses) >= 8:
                means = losses.mean()
                best = means.idxmin()
                if means[BASELINE] - means[best] >= 1.0:
                    name = best
            choices[key] = (name, len(losses), past.label_available_date.max())
        name, count, latest = choices[key]
        selected = group.loc[group.primary_candidate.eq(name)].iloc[0].to_dict()
        if not np.isfinite(selected["prediction_bp"]):
            selected, name = baseline.to_dict(), BASELINE
        rows.append(
            {
                **selected,
                "primary_candidate": "walk_forward_primary",
                "selected_primary": name,
                "selection_events": count,
                "selection_latest_label": latest,
            }
        )
    return pd.DataFrame(rows).drop(columns="loss")


def _event_scores(group):
    frame = group.copy()
    frame["loss"] = (frame.prediction_bp - frame.actual_coupon_bp).abs()
    frame["baseline_loss"] = (
        frame.baseline_prediction_bp - frame.actual_coupon_bp
    ).abs()
    frame["flat_loss"] = (frame.baseline_flat_bp - frame.actual_coupon_bp).abs()
    # A missing challenger prediction must not improve its denominator.
    finite = np.isfinite(
        frame[["prediction_bp", "baseline_prediction_bp", "baseline_flat_bp"]]
    ).all(axis=1)
    events = frame.groupby(EVENT_KEYS)[["loss", "baseline_loss", "flat_loss"]].mean()
    return frame, events, bool(finite.all())


def _gain_interval(gains):
    if not len(gains):
        return np.nan, np.nan
    rng = np.random.default_rng(20260921)
    samples = rng.choice(gains, (2000, len(gains)), replace=True).mean(axis=1)
    return tuple(np.quantile(samples, [0.025, 0.975]))


def optimization_metrics(predictions):
    frame = predictions.copy()
    frame["year"] = frame.pricing_date.dt.year
    frame["period"] = np.where(frame.year.lt(2026), "development", "observed_reference")
    frame = frame.loc[frame.year.ge(2022)]
    rows = []
    for keys, group in frame.groupby(["date_basis", "period", "primary_candidate"]):
        detail, events, complete = _event_scores(group)
        gains = events.baseline_loss - events.loss
        low, high = _gain_interval(gains.to_numpy())
        flat_low, _ = _gain_interval((events.flat_loss - events.loss).to_numpy())
        annual = (
            detail.groupby(["year", *EVENT_KEYS])[["loss", "baseline_loss"]]
            .mean()
            .groupby("year")
            .mean()
        )
        worst = (annual.loss - annual.baseline_loss).max()
        rows.append(
            {
                "date_basis": keys[0],
                "period": keys[1],
                "primary_candidate": keys[2],
                "requested": len(group),
                "predictions": int(group.prediction_bp.notna().sum()),
                "events": len(events),
                "years": len(annual),
                "complete_coverage": complete,
                "row_mae_bp": detail.loss.mean(),
                "event_mae_bp": events.loss.mean(),
                "baseline_event_mae_bp": events.baseline_loss.mean(),
                "flat_event_mae_bp": events.flat_loss.mean(),
                "event_gain_bp": gains.mean(),
                "gain_low95_bp": low,
                "gain_high95_bp": high,
                "gain_vs_flat_low95_bp": flat_low,
                "worst_annual_deterioration_bp": worst,
                "research_gate_passed": bool(
                    keys[1] == "development"
                    and complete
                    and len(events) >= 12
                    and len(annual) >= 3
                    and gains.mean() >= 1.0
                    and low > 0
                    and flat_low > 0
                    and worst <= 1.0
                ),
            }
        )
    return pd.DataFrame(rows)


def save_primary_optimization(paths, engine, directory):
    candidates = primary_challenger_paths(paths, engine)
    combined = pd.concat(
        [candidates, walk_forward_primary(candidates)], ignore_index=True
    )
    combined.to_csv(directory / "primary-optimization-paths.csv", index=False)
    metrics = optimization_metrics(combined)
    metrics.to_csv(directory / "primary-optimization-metrics.csv", index=False)
    detail, _, _ = _event_scores(combined)
    detail["year"] = detail.pricing_date.dt.year
    annual = (
        detail.groupby(["date_basis", "primary_candidate", "year", *EVENT_KEYS])[
            ["loss", "baseline_loss", "flat_loss"]
        ]
        .mean()
        .groupby(["date_basis", "primary_candidate", "year"])
        .mean()
    )
    annual.to_csv(directory / "primary-optimization-years.csv")
    passed = (
        metrics.loc[metrics.research_gate_passed]
        .groupby("primary_candidate")
        .date_basis.nunique()
    )
    assessment = {
        "protocol": optimization_protocol(),
        "research_shortlist": passed[passed.eq(2)].index.tolist(),
        "production_replacement": False,
        "timing_alpha": "not_established",
        "limitation": "event bootstrap is descriptive after historical model search; fresh forward evidence still required",
        "metrics": metrics.to_dict(orient="records"),
    }
    write_json(directory / "primary-optimization-assessment.json", assessment)
    _write_optimization_report(metrics, directory)
    outputs = sorted(directory.glob("primary-optimization-*"))
    write_json(
        directory / "primary-optimization-manifest.json",
        {
            "code_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "paths_sha256": hashlib.sha256(
                pd.util.hash_pandas_object(paths).values.tobytes()
            ).hexdigest(),
            "history_sha256": hashlib.sha256(
                pd.util.hash_pandas_object(engine.history).values.tobytes()
            ).hexdigest(),
            "files": {
                p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                for p in outputs
                if p.name != "primary-optimization-manifest.json"
            },
        },
    )
    return assessment


def _write_optimization_report(metrics, directory):
    lines = [
        "# 一级票面预测优化对照",
        "",
        "固定同一发行事件、预测时点和LightGBM市场预测，只改变一级溢价估计。"
        "30日半衰期、最近溢价与原估计各半、期限曲线修正、同类收缩及相对溢价均事先登记；"
        "滚动选择只用同发行人同方案、730日内已经成熟的至少8个事件，历史改善不足1bp时保留原估计。",
        "",
        "MAE按发行人/定价日先聚合，再对事件等权。开发期为2022—2025年，2026年仅为已观察参考。"
        "以下发行日口径覆盖所有原模型有效行，不按候选删除困难样本；簿记日口径另见CSV。",
        "期限修正复用共享注册表的国债1/3/10年曲线斜率，历史溢价先扣除当时期限差，"
        "当前再加上前一完整报价的期限差；国债斜率只是代理，不代表已获得证券公司全期限信用曲线。",
        "",
        "| 期间 | 候选 | 事件数 | 有效/请求 | 事件MAE(bp) | 较原模型改善(bp) | 改善95%区间 | 研究准入 |",
        "|---|---|---:|---:|---:|---:|---|---|",
    ]
    for row in metrics.loc[metrics.date_basis.eq("issue_date")].itertuples():
        period = "2022—2025开发" if row.period == "development" else "2026已观察参考"
        lines.append(
            f"| {period} | {row.primary_candidate} | {row.events} | {row.predictions}/{row.requested} | "
            f"{row.event_mae_bp:.3f} | {row.event_gain_bp:.3f} | [{row.gain_low95_bp:.3f}, {row.gain_high95_bp:.3f}] | "
            f"{'通过' if row.research_gate_passed else '未通过/不适用'} |"
        )
    lines += [
        "",
        "研究准入要求两种事件日期口径同时通过：开发期至少12个事件和3个年份，"
        "事件MAE改善至少1bp，较原模型和固定不变基准的改善区间下界均大于0，"
        "任一年退化不超过1bp且覆盖完整。它只是前向验证的候选筛选，不是生产激活授权。",
        "",
        "一级溢价在同一预测起点的所有日期使用相同估计，改变它会平移票面路径，"
        "不会改善市场方向或同起点等待节约。市场择时能力必须单独检验；"
        "两次真实发行的配对回放不能代替完整窗口选日的收益证据。",
        "",
        "有限历史事件、模型搜索、相邻事件相关性、缺少历史数据版本及发行方式字段仍限制外推。"
        "本次不自动切换生产模型，不降低等待门槛。",
    ]
    (directory / "primary-optimization-report.md").write_text("\n".join(lines) + "\n")
