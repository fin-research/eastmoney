"""
预测与评分：特征填充、SHAP 驱动因子、推荐接口、市场打分、公司就绪度。
"""

import lightgbm as lgb
import numpy as np
import pandas as pd
import shap

_RATING_MAP = {"AAA": 5, "AA+": 4, "AA": 3, "AA-": 2, "A+": 1}


def tenor_bucket(tenor: float) -> str:
    """将期限映射到分桶：<=1Y / 2Y / 3Y / 5Y / >=7Y"""
    if tenor <= 1:
        return "<=1Y"
    elif tenor <= 2:
        return "2Y"
    elif tenor <= 3:
        return "3Y"
    elif tenor <= 5:
        return "5Y"
    return ">=7Y"


def fill_features(
    x: "pd.Series | np.ndarray",
    train_med: pd.Series,
    feature_names: list[str],
) -> np.ndarray:
    """将特征向量中的 NaN 用训练集中位数填充，返回无 NaN 的 float64 数组。"""
    if isinstance(x, pd.Series):
        x_vec = x.reindex(feature_names).values.astype(float)
    else:
        x_vec = np.asarray(x, dtype=float).copy()

    nan_mask = np.isnan(x_vec)
    if nan_mask.any():
        x_vec[nan_mask] = train_med.values.astype(float)[nan_mask]
    return x_vec


def shap_top_drivers(
    model: lgb.LGBMRegressor,
    x: np.ndarray,
    feature_names: list[str],
    top_n: int = 5,
) -> list[dict]:
    """用 SHAP 解释单个样本，返回按绝对值排序的 Top-N 驱动因子。"""
    explainer = shap.TreeExplainer(model)
    sv = explainer.shap_values(x.reshape(1, -1))[0]
    top_idx = np.argsort(np.abs(sv))[-top_n:][::-1]
    return [
        {
            "feature": feature_names[i],
            "shap": round(float(sv[i]), 3),
            "value": round(float(x[i]), 4),
            "direction": "推高成本" if sv[i] > 0 else "降低成本",
        }
        for i in top_idx
    ]


def predict_with_fillna(
    model: lgb.LGBMRegressor,
    train_med: pd.Series,
    threshold: float,
    x: "pd.Series | np.ndarray",
    feature_names: list[str],
) -> tuple[float, bool]:
    """对单个样本预测，NaN 特征自动用训练集中位数填充。"""
    x_vec = fill_features(x, train_med, feature_names)
    y_pred = float(model.predict(x_vec.reshape(1, -1))[0])
    return y_pred, y_pred <= threshold


def build_market_feature_vec(
    mkt: pd.Series,
    tenor: float,
    peer_med: float,
    train_med: pd.Series,
    feature_names: list[str],
    has_option: float = 0.0,
    is_subordinated: float = 0.0,
    issue_size: float | None = None,
    rating: str = "AAA",
    implied_rating: str | None = None,
    peer_spread_std: float | None = None,
    peer_count: float | None = None,
    issuer_frequency_30d: float = 0.0,
) -> np.ndarray:
    """从 T-1 日市场特征 + 债券属性构建完整特征向量（无 NaN）。"""
    x_dict = dict(mkt)
    x_dict["tenor_feat"] = float(tenor)
    x_dict["has_option_feat"] = float(has_option)
    x_dict["is_subordinated_feat"] = float(is_subordinated)
    if issue_size is not None:
        x_dict["log_issue_size_feat"] = float(np.log1p(max(issue_size, 0.0)))
    explicit_score = _RATING_MAP.get(str(rating), 0)
    implied_score = _RATING_MAP.get(str(implied_rating or rating), explicit_score)
    x_dict["rating_score_feat"] = float(explicit_score)
    x_dict["implied_vs_explicit_feat"] = float(implied_score - explicit_score)
    x_dict["peer_spread_median"] = float(peer_med)
    x_dict["peer_spread_std"] = float(
        peer_spread_std
        if peer_spread_std is not None
        else train_med.get("peer_spread_std", 0.0)
    )
    x_dict["peer_count"] = float(
        peer_count if peer_count is not None else train_med.get("peer_count", 1.0)
    )
    x_dict["issuer_frequency_30d"] = float(issuer_frequency_30d)
    if "credit_spread" in x_dict:
        x_dict["tenor_x_credit_spread"] = float(tenor) * float(x_dict["credit_spread"])
    if "dr007_pctile_60d" in x_dict:
        x_dict["tenor_x_dr007_pctile"] = float(tenor) * float(
            x_dict["dr007_pctile_60d"]
        )

    x_vec = np.array(
        [x_dict.get(col, float(train_med[col])) for col in feature_names],
        dtype=float,
    )
    return fill_features(x_vec, train_med, feature_names)


def lookup_group_threshold(
    group_thresholds: dict,
    global_threshold: float,
    bond_type: str,
    tenor: float,
) -> float:
    """查找分组阈值，不存在则回退到全局阈值。"""
    key = (bond_type, tenor_bucket(tenor))
    return group_thresholds.get(key, global_threshold)


def recommend_issue(
    model: lgb.LGBMRegressor,
    train_med: pd.Series,
    global_threshold: float,
    group_thresholds: dict,
    market_features: pd.Series,
    feature_names: list[str],
    tenor: float,
    bond_type: str,
    has_option: bool = False,
    is_subordinated: bool = False,
    peer_spread_median: "float | None" = None,
    issue_size: float | None = None,
    rating: str = "AAA",
    implied_rating: str | None = None,
    peer_spread_std: float | None = None,
    peer_count: float | None = None,
    issuer_frequency_30d: float = 0.0,
) -> dict:
    """输入债券发行要素 + 当日市场数据 → 输出择时建议。"""
    peer_med = (
        peer_spread_median
        if peer_spread_median is not None
        else float(train_med.get("peer_spread_median", 0.0))
    )
    x_vec = build_market_feature_vec(
        market_features,
        tenor,
        peer_med,
        train_med,
        feature_names,
        has_option=float(has_option),
        is_subordinated=float(is_subordinated),
        issue_size=issue_size,
        rating=rating,
        implied_rating=implied_rating,
        peer_spread_std=peer_spread_std,
        peer_count=peer_count,
        issuer_frequency_30d=issuer_frequency_30d,
    )
    pred = float(model.predict(x_vec.reshape(1, -1))[0])
    threshold = lookup_group_threshold(
        group_thresholds, global_threshold, bond_type, tenor
    )
    key = (bond_type, tenor_bucket(tenor))
    return {
        "pred_bp": round(pred, 2),
        "threshold_bp": round(threshold, 2),
        "threshold_type": "分组" if key in group_thresholds else "全局(fallback)",
        "recommend": pred <= threshold,
        "bond_type": bond_type,
        "tenor": tenor,
    }


def score_market(
    model: lgb.LGBMRegressor,
    train_med: pd.Series,
    threshold_p25: float,
    threshold_p50: float,
    train_preds: np.ndarray,
    market_features_df: pd.DataFrame,
    market_feat_names: list[str],
    target_date: "pd.Timestamp | None" = None,
) -> dict:
    """对指定日期进行纯市场维度择时评分。"""
    if target_date is None:
        target_date = pd.Timestamp.today().normalize()

    all_trading_days = market_features_df.index
    idx = all_trading_days.searchsorted(target_date, side="left") - 1
    if idx < 0:
        raise ValueError("无可用市场特征数据")

    latest_date = all_trading_days[idx]
    mkt_today = market_features_df.iloc[idx]
    x_today = fill_features(mkt_today, train_med, market_feat_names)
    y_pred = float(model.predict(x_today.reshape(1, -1))[0])
    pctile = float((train_preds <= y_pred).mean() * 100)
    top5 = shap_top_drivers(model, x_today, market_feat_names, top_n=5)

    if y_pred <= threshold_p25:
        recommend = "strong_buy"
    elif y_pred <= threshold_p50:
        recommend = "neutral"
    else:
        recommend = "wait"

    return {
        "date": target_date.strftime("%Y-%m-%d"),
        "market_data_date": latest_date.strftime("%Y-%m-%d"),
        "pred_bp": round(y_pred, 2),
        "threshold_p25": round(threshold_p25, 2),
        "threshold_p50": round(threshold_p50, 2),
        "percentile": round(pctile, 1),
        "recommend": recommend,
        "top5_drivers": top5,
    }


def _resolve_asof_date(
    df: pd.DataFrame, target_date: "pd.Timestamp | None"
) -> "pd.Timestamp | None":
    if target_date is None:
        return df.index[-1]
    target_date = pd.Timestamp(target_date)
    valid = df.index[df.index <= target_date]
    return valid[-1] if len(valid) else None


def _subject_spread_snapshot(
    subject_spread_df: "pd.DataFrame | None",
    target_date: pd.Timestamp,
    lookback: int,
) -> tuple[float, float, "pd.Timestamp | None"]:
    if subject_spread_df is None or subject_spread_df.empty:
        return float("nan"), float("nan"), None

    spread_df = subject_spread_df.sort_index()
    valid_dates = spread_df.index[spread_df.index <= target_date]
    if len(valid_dates) == 0:
        return float("nan"), float("nan"), None

    spread_date = valid_dates[-1]
    spread_bp = spread_df.loc[spread_date].get("ef_subject_spread_bp", float("nan"))
    history = (
        spread_df[spread_df.index < spread_date]
        .tail(lookback)["ef_subject_spread_bp"]
        .dropna()
    )
    percentile = float("nan")
    if len(history) and not pd.isna(spread_bp):
        percentile = float((history < float(spread_bp)).mean())
    return spread_bp, percentile, spread_date


def _readiness_label_and_interpretation(
    composite: float, funding_gap: float
) -> tuple[str, str]:
    if np.isnan(composite):
        label, interpretation = "数据不足", "专有指标缺失，无法评估"
    elif composite >= 0.6:
        label, interpretation = "宽裕", "流动性充裕，可从容等待最优市场窗口"
    elif composite >= 0.35:
        label, interpretation = "适中", "流动性尚可，结合市场信号决策"
    else:
        label, interpretation = "偏紧", "流动性偏紧，存在主动发行压力"

    if not np.isnan(funding_gap):
        if funding_gap < -100:
            interpretation += "；建议近期安排融资"
        elif funding_gap > 50:
            interpretation += "；资金面暂无压力"
    return label, interpretation


def compute_company_readiness(
    prop_df: pd.DataFrame,
    target_date: "pd.Timestamp | None" = None,
    lookback: int = 252,
    subject_spread_df: "pd.DataFrame | None" = None,
) -> dict:
    """基于东方财富专有业务指标计算当前公司就绪度。"""
    df = prop_df.sort_index()
    target_date = _resolve_asof_date(df, target_date)
    if target_date is None:
        return {}

    row = df.loc[target_date]
    ef_lcr = row.get("ef_lcr_pctile_60d", float("nan"))
    ef_nsfr = row.get("ef_nsfr_pctile_60d", float("nan"))
    ef_margin = row.get("ef_margin_zscore_60d", float("nan"))
    ef_gap = row.get("ef_funding_gap", float("nan"))
    ef_pressure = row.get("ef_funding_pressure", float("nan"))
    subject_spread_bp, subject_spread_pctile, subject_spread_date = (
        _subject_spread_snapshot(subject_spread_df, target_date, lookback)
    )

    valid_scores = [s for s in [ef_lcr, ef_nsfr] if not np.isnan(s)]
    composite = float(np.mean(valid_scores)) if valid_scores else float("nan")
    readiness_label, interpretation = _readiness_label_and_interpretation(
        composite, ef_gap
    )

    return {
        "date": target_date.strftime("%Y-%m-%d"),
        "ef_lcr": row.get("ef_lcr", float("nan")),
        "ef_nsfr": row.get("ef_nsfr", float("nan")),
        "ef_lcr_pctile_60d": ef_lcr,
        "ef_nsfr_pctile_60d": ef_nsfr,
        "ef_funding_gap": ef_gap,
        "ef_margin_zscore_60d": ef_margin,
        "ef_funding_pressure": ef_pressure,
        "ef_subject_spread_bp": subject_spread_bp,
        "ef_subject_spread_pctile": subject_spread_pctile,
        "ef_subject_spread_date": (
            subject_spread_date.strftime("%Y-%m-%d")
            if subject_spread_date is not None
            else None
        ),
        "composite_score": composite,
        "readiness_label": readiness_label,
        "interpretation": interpretation,
    }
