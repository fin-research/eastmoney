"""当日逐笔发行评分及未来 14 天窗口构建。"""

from dataclasses import dataclass

import pandas as pd

from data.data import (
    FeatureEngineer,
    compute_peer_stats,
    load_subject_spread_features,
)
from issue_report import build_score_today_report, driver_structure, market_drivers
from model.features import split_feature_names
from model.scoring import (
    build_market_feature_vec,
    compute_company_readiness,
    shap_top_drivers,
    tenor_bucket,
)
from model.train import train_issue_horizon_models, train_issue_model


@dataclass(frozen=True, slots=True)
class _IssueTerms:
    """主流程使用的固定发行方案。"""

    issue_size: float = 30.0
    tenor: float = 3.0
    rating: str = "AAA"
    bond_type: str = "证券公司债"


_PRODUCT_SCENARIOS = (
    _IssueTerms(tenor=3.0, bond_type="证券公司债"),
    _IssueTerms(tenor=5.0, bond_type="证券公司债"),
    _IssueTerms(tenor=3.0, bond_type="证券公司次级债"),
    _IssueTerms(tenor=5.0, bond_type="证券公司次级债"),
)


def _calendar_feature_values(feature_date: pd.Timestamp) -> dict[str, float]:
    month_end = feature_date + pd.offsets.MonthEnd(0)
    quarter_month = min(month for month in [3, 6, 9, 12] if month >= feature_date.month)
    quarter_end = pd.Timestamp(
        feature_date.year, quarter_month, 1
    ) + pd.offsets.MonthEnd(0)
    return {
        "day_of_week": feature_date.dayofweek,
        "month": feature_date.month,
        "is_month_end": int(feature_date.day >= 25),
        "is_quarter_end": int(feature_date.month % 3 == 0 and feature_date.day >= 20),
        "is_year_end": int(feature_date.month == 12 and feature_date.day >= 15),
        "days_to_month_end": (month_end - feature_date).days,
        "days_to_quarter_end": (quarter_end - feature_date).days,
        "is_mlf_week": int(13 <= feature_date.day <= 17),
    }


def _issue_label(recommendation: str) -> str:
    return {
        "strong_buy": "建议发行",
        "neutral": "建议等待",
        "wait": "暂缓发行",
    }[recommendation]


def _recommendation_for_percentile(percentile: float) -> str:
    """按历史预测分位三等分；低偏离对应更有利的发行成本。"""
    if percentile <= 100 / 3:
        return "strong_buy"
    if percentile <= 200 / 3:
        return "neutral"
    return "wait"


def _window_zone(recommendation: str) -> str:
    return {
        "strong_buy": "较优",
        "neutral": "中枢",
        "wait": "较劣",
    }[recommendation]


def _latest_market_row(
    feature_engineer: FeatureEngineer,
    target_date: pd.Timestamp,
) -> tuple[pd.Series, pd.Timestamp]:
    trading_days = feature_engineer.all_market_features_.index
    position = trading_days.searchsorted(target_date, side="left") - 1
    if position < 0:
        raise ValueError("无可用市场特征数据")
    return feature_engineer.all_market_features_.iloc[position].copy(), trading_days[
        position
    ]


def _score_issue(
    issue_model: dict,
    dataset: pd.DataFrame,
    feature_engineer: FeatureEngineer,
    target_date: pd.Timestamp,
    market_features: pd.Series,
    market_data_date: pd.Timestamp,
    terms: _IssueTerms,
    include_drivers: bool = False,
) -> dict:
    model = issue_model["model"]
    train_medians = issue_model["train_med"]
    group_key = (terms.bond_type, tenor_bucket(terms.tenor))
    group_stats = issue_model["group_stats"].get(group_key)

    peer = compute_peer_stats(
        dataset,
        target_date,
        terms.tenor,
        terms.rating,
        terms.bond_type,
    )
    peer_median = (
        float(peer["median"])
        if peer is not None
        else float(train_medians.get("peer_spread_median", 0.0))
    )
    peer_std = (
        float(peer["std"])
        if peer is not None
        else float(train_medians.get("peer_spread_std", 0.0))
    )
    peer_count = (
        float(peer["count"])
        if peer is not None
        else float(train_medians.get("peer_count", 1.0))
    )
    feature_vector = build_market_feature_vec(
        market_features,
        terms.tenor,
        peer_median,
        train_medians,
        feature_engineer.feature_names,
        has_option=0.0,
        is_subordinated=float(terms.bond_type == "证券公司次级债"),
        issue_size=terms.issue_size,
        rating=terms.rating,
        implied_rating=terms.rating,
        peer_spread_std=peer_std,
        peer_count=peer_count,
        issuer_frequency_30d=0.0,
    )
    prediction = float(model.predict(feature_vector.reshape(1, -1))[0])

    reference_predictions = (
        issue_model["train_preds"] if group_stats is None else group_stats["preds"]
    )
    percentile = float((reference_predictions <= prediction).mean() * 100)
    recommendation = _recommendation_for_percentile(percentile)

    result = {
        "market_data_date": market_data_date.strftime("%Y-%m-%d"),
        "pred_bp": prediction,
        "peer_spread_median": peer_median,
        "percentile": percentile,
        "recommend": recommendation,
        "label": _issue_label(recommendation),
        "window_zone": _window_zone(recommendation),
        "issue_size": terms.issue_size,
        "tenor": terms.tenor,
        "rating": terms.rating,
        "bond_type": terms.bond_type,
    }
    if include_drivers:
        result["top_drivers"] = shap_top_drivers(
            model,
            feature_vector,
            feature_engineer.feature_names,
            top_n=len(feature_engineer.feature_names),
        )
    return result


def _product_display_name(terms: _IssueTerms) -> str:
    product = "次级债" if terms.bond_type == "证券公司次级债" else "公募债"
    return f"{terms.tenor:g}Y {product}"


def _build_product_recommendation(
    issue_model: dict,
    dataset: pd.DataFrame,
    feature_engineer: FeatureEngineer,
    target_date: pd.Timestamp,
    market_features: pd.Series,
    market_data_date: pd.Timestamp,
) -> dict:
    """逐一输入四种标准发行方案，并按预测利差偏离由低到高排序。"""
    scenarios = []
    for terms in _PRODUCT_SCENARIOS:
        score = _score_issue(
            issue_model,
            dataset,
            feature_engineer,
            target_date=target_date,
            market_features=market_features,
            market_data_date=market_data_date,
            terms=terms,
        )
        scenarios.append(
            {
                "display_name": _product_display_name(terms),
                "tenor_years": terms.tenor,
                "bond_type": terms.bond_type,
                "pred_bp": round(score["pred_bp"], 2),
                "peer_spread_median_bp": round(score["peer_spread_median"], 2),
                "historical_percentile": round(score["percentile"], 1),
                "recommendation": score["recommend"],
                "recommendation_label": score["label"],
            }
        )

    ranked = sorted(
        range(len(scenarios)),
        key=lambda index: scenarios[index]["pred_bp"],
    )
    best_index = ranked[0]
    best_prediction = scenarios[best_index]["pred_bp"]
    ranks = {scenario_index: rank for rank, scenario_index in enumerate(ranked, 1)}
    for index, scenario in enumerate(scenarios):
        scenario["rank"] = ranks[index]
        scenario["cost_vs_best_bp"] = round(scenario["pred_bp"] - best_prediction, 2)
        scenario["is_recommended"] = index == best_index

    best = scenarios[best_index]
    return {
        "recommended_product": best["display_name"],
        "recommended_tenor_years": best["tenor_years"],
        "recommended_bond_type": best["bond_type"],
        "scenarios": scenarios,
    }


def _finalize_window_df(
    result_df: pd.DataFrame,
    issue_size: float,
) -> pd.DataFrame:
    window_median = float(result_df["pred_bp"].median())
    result_df["savings_bp_vs_window_median"] = (
        result_df["pred_bp"] - window_median
    ).round(2)
    result_df["savings_万元/年"] = (
        result_df["savings_bp_vs_window_median"] * issue_size
    ).round(1)
    return result_df


def _future_feature_plan(
    feature_engineer: FeatureEngineer,
    today: pd.Timestamp,
    days: int,
) -> tuple[list[pd.Timestamp], list[pd.Timestamp], pd.Series, pd.Timestamp]:
    latest_market, latest_date = _latest_market_row(feature_engineer, today)
    future_dates = [
        date for date in pd.date_range(start=today, periods=days) if date.weekday() < 5
    ]
    feature_dates = []
    for forecast_date in future_dates:
        feature_cutoff = forecast_date - pd.Timedelta(days=1)
        future_feature_days = pd.bdate_range(
            latest_date + pd.offsets.BDay(1),
            feature_cutoff,
        )
        feature_dates.append(
            latest_date if len(future_feature_days) == 0 else future_feature_days[-1]
        )
    return future_dates, feature_dates, latest_market, latest_date


def _build_forecast_window(
    issue_model: dict,
    horizon_models: dict[int, dict],
    dataset: pd.DataFrame,
    feature_engineer: FeatureEngineer,
    days: int,
    terms: _IssueTerms,
    as_of_date: str | None = None,
) -> pd.DataFrame:
    today = (
        pd.Timestamp(as_of_date).normalize()
        if as_of_date
        else pd.Timestamp.today().normalize()
    )
    market_feature_names = feature_engineer.all_market_features_.columns.tolist()
    _, calendar_feature_names = split_feature_names(market_feature_names)
    future_dates, feature_dates, latest_market, latest_date = _future_feature_plan(
        feature_engineer,
        today,
        days,
    )

    rows = []
    weekdays = ["周一", "周二", "周三", "周四", "周五"]
    for forecast_date, feature_date in zip(future_dates, feature_dates):
        horizon_days = int((forecast_date - today).days)
        row_model = horizon_models.get(horizon_days, issue_model)
        market_features = latest_market.reindex(market_feature_names).copy()
        if horizon_days > 0:
            calendar_values = _calendar_feature_values(feature_date)
            for feature_name in calendar_feature_names:
                if feature_name in calendar_values:
                    market_features.loc[feature_name] = float(
                        calendar_values[feature_name]
                    )

        score = _score_issue(
            row_model,
            dataset,
            feature_engineer,
            target_date=forecast_date,
            market_features=market_features,
            market_data_date=latest_date,
            terms=terms,
        )
        rows.append(
            {
                "date": forecast_date.strftime("%Y-%m-%d"),
                "weekday": weekdays[forecast_date.weekday()],
                "percentile": round(score["percentile"], 1),
                "label": score["label"],
                "pred_bp": round(score["pred_bp"], 2),
            }
        )
    return _finalize_window_df(pd.DataFrame(rows), terms.issue_size)


def run_today_assessment(
    dataset: pd.DataFrame,
    feature_engineer: FeatureEngineer,
    tscv_median_n: int,
    *,
    models: tuple[dict, dict[int, dict]] | None = None,
    as_of_date: str | None = None,
) -> dict:
    """训练逐笔/直接 horizon 模型并输出默认发行方案的当日评估。"""
    today = (
        pd.Timestamp(as_of_date).normalize()
        if as_of_date
        else pd.Timestamp.today().normalize()
    )
    terms = _IssueTerms()
    issue_model = (
        models[0]
        if models
        else train_issue_model(
            dataset,
            feature_engineer.feature_names,
            n_estimators=tscv_median_n,
        )
    )
    market_today, market_data_date = _latest_market_row(feature_engineer, today)
    result = _score_issue(
        issue_model,
        dataset,
        feature_engineer,
        target_date=today,
        market_features=market_today,
        market_data_date=market_data_date,
        terms=terms,
        include_drivers=True,
    )
    product_recommendation = _build_product_recommendation(
        issue_model,
        dataset,
        feature_engineer,
        target_date=today,
        market_features=market_today,
        market_data_date=market_data_date,
    )

    readiness = None
    if getattr(feature_engineer, "proprietary_features_", None) is not None:
        try:
            subject_spread_df = load_subject_spread_features()
        except Exception as exc:
            print(f"[WARN] 公司主体利差读取失败，本次不纳入公司业务指标: {exc}")
            subject_spread_df = None
        readiness = compute_company_readiness(
            feature_engineer.proprietary_features_,
            target_date=today,
            subject_spread_df=subject_spread_df,
        )

    horizon_models = (
        models[1]
        if models
        else train_issue_horizon_models(
            dataset=dataset,
            feature_names=feature_engineer.feature_names,
            market_features_df=feature_engineer.all_market_features_,
            n_estimators=tscv_median_n,
        )
    )
    forecast_df = _build_forecast_window(
        issue_model,
        horizon_models,
        dataset,
        feature_engineer,
        days=14,
        terms=terms,
        as_of_date=as_of_date,
    )
    driver_rows = market_drivers(result, feature_engineer)
    driver_group_rows = driver_structure(result, feature_engineer)
    result["decision"] = result["label"]
    result["report_text"] = build_score_today_report(
        result=result,
        readiness=readiness,
        market_driver_rows=driver_rows,
        validation_summary=getattr(feature_engineer, "validation_summary_", {}),
        forecast_df=forecast_df,
    )
    result["as_of_date"] = today.strftime("%Y-%m-%d")
    result["company_metrics"] = readiness
    result["market_drivers"] = driver_rows
    result["driver_structure"] = driver_group_rows
    result["product_recommendation"] = product_recommendation
    result["validation_summary"] = getattr(feature_engineer, "validation_summary_", {})
    result["forecast_window"] = forecast_df.to_dict(orient="records")

    print(f"\n{'=' * 60}")
    print(f"今日发行择时评估（{today.strftime('%Y-%m-%d')}）")
    print(f"{'=' * 60}")
    print(result["report_text"])
    print(f"{'=' * 60}")
    return result
