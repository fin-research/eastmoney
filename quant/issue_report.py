"""
逐笔发行择时的中文报告和表格格式化。
"""

import unicodedata

import pandas as pd

from data.data import FeatureEngineer


_FEATURE_LABELS = {
    "SOCIAL_FINANCE": "社融存量同比（%）",
    "SOCIAL_FINANCE_mom": "社融存量同比一日变化（百分点）",
    "SOCIAL_FINANCE_3m_chg": "社融存量同比三日变化（百分点）",
    "dr007": "DR007",
    "dr007_vs_policy": "DR007相对政策利率",
    "r007_dr007_spread": "R007-DR007",
    "shibor_3m": "3M Shibor",
    "gov_10y": "10Y国债",
    "term_spread": "国债期限利差",
    "dr007_ma5": "DR007五日均值",
    "dr007_ma20": "DR007二十日均值",
    "dr007_vs_ma5_dev": "DR007相对五日均值",
    "dr007_chg_5d": "DR007五日变化",
    "dr007_chg_20d": "DR007二十日变化",
    "dr007_vol_5d": "DR007五日波动",
    "dr007_vol_20d": "DR007二十日波动",
    "dr007_vol_trend": "DR007波动趋势",
    "term_spread_chg_5d": "期限利差五日变化",
    "term_spread_chg_20d": "期限利差二十日变化",
    "term_spread_slope_chg": "期限利差斜率变化",
    "credit_spread": "信用利差",
    "credit_spread_chg_5d": "信用利差五日变化",
    "credit_spread_chg_20d": "信用利差二十日变化",
    "credit_spread_pctile_60d": "信用利差六十日分位",
    "credit_spread_vol_20d": "信用利差二十日波动",
    "cdb_gov_spread": "国开债-国债利差",
    "yield_vol_5d": "收益率五日波动",
    "curve_curvature": "收益率曲线曲率",
    "short_term_spread": "短端期限利差",
    "gov_10y_chg_20d": "10Y国债二十日变化",
    "dr007_pctile_60d": "DR007六十日分位",
    "term_spread_pctile_60d": "期限利差六十日分位",
    "gov_10y_pctile_60d": "10Y国债六十日分位",
    "csi300_ret_5d": "沪深300五日收益",
    "csi300_ret_20d": "沪深300二十日收益",
    "csi300_ret_60d": "沪深300六十日收益",
    "csi300_vol_20d": "沪深300二十日波动",
    "turnover_rate": "股票换手率",
    "equity_bond_spread": "股债性价比（差值）",
    "vix": "VIX",
    "vix_chg_5d": "VIX五日变化",
    "vix_pctile_60d": "VIX六十日分位",
    "bond_volume_20d_avg": "债券成交量二十日均值",
    "bond_volume_chg_5d": "债券成交量五日变化",
    "bond_volume_pctile_60d": "债券成交量六十日分位",
    "credit_bond_volume_ratio": "信用债成交占比",
    "credit_volume_chg_5d": "信用债成交五日变化",
    "rate_credit_volume_ratio": "利率债/信用债成交比",
    "supply_5d": "五日一级供给",
    "supply_20d": "二十日一级供给",
    "issue_count_5d": "五日发行笔数",
    "issue_count_20d": "二十日发行笔数",
    "weighted_cost": "一级加权成本",
    "supply_5d_zscore": "五日供给强度",
    "supply_20d_zscore": "二十日供给强度",
    "weighted_cost_chg_5d": "一级成本五日变化",
    "weighted_cost_chg_20d": "一级成本二十日变化",
    "net_financing_5d": "五日净融资",
    "net_financing_20d": "二十日净融资",
    "net_financing_zscore": "净融资强度",
    "maturity_wall_20d": "二十日到期压力",
    "redemption_pressure": "赎回及到期压力",
    "day_of_week": "星期效应",
    "month": "月份效应",
    "is_month_end": "月末效应",
    "is_quarter_end": "季末效应",
    "is_year_end": "年末效应",
    "days_to_month_end": "距月末天数",
    "days_to_quarter_end": "距季末天数",
    "is_mlf_week": "MLF周",
    "funding_credit_stress": "资金与信用双重压力",
    "risk_appetite": "股债风险偏好",
    "supply_funding_pressure": "供给与资金压力",
    "tenor_feat": "发行期限",
    "has_option_feat": "含权结构",
    "is_subordinated_feat": "次级债因子",
    "log_issue_size_feat": "发行规模",
    "rating_score_feat": "主体评级",
    "implied_vs_explicit_feat": "隐含评级相对主体评级",
    "peer_spread_median": "近30日可比债中位利差",
    "peer_spread_std": "近30日可比债利差波动",
    "peer_count": "近30日可比债数量",
    "issuer_frequency_30d": "发行人近30日发行频次",
    "tenor_x_credit_spread": "期限与信用利差交互",
    "tenor_x_dr007_pctile": "期限与DR007分位交互",
}

_EXCLUDED_REPORT_DRIVER_FEATURES = frozenset(
    {
        "tenor_feat",
        "has_option_feat",
        "is_subordinated_feat",
        "log_issue_size_feat",
        "rating_score_feat",
        "implied_vs_explicit_feat",
        "issuer_frequency_30d",
        "tenor_x_credit_spread",
        "tenor_x_dr007_pctile",
    }
)

_DRIVER_GROUPS = (
    ("macro", "宏观基本面"),
    ("funding", "资金面"),
    ("equity", "权益市场"),
    ("primary_bond", "供给压力"),
    ("secondary_bond", "二级市场"),
    ("calendar", "日历效应"),
)

_DRIVER_GROUP_OVERRIDES = {
    "funding_credit_stress": "funding",
    "risk_appetite": "equity",
    "supply_funding_pressure": "primary_bond",
    "peer_spread_median": "secondary_bond",
    "peer_spread_std": "secondary_bond",
    "peer_count": "secondary_bond",
}


def market_drivers(result: dict, fe: FeatureEngineer, top_n: int = 5) -> list[dict]:
    """筛选并格式化报告中允许展示的 SHAP 因子。"""
    drivers = result.get("top_drivers", [])
    filtered = []
    for driver in drivers:
        feature = driver["feature"]
        if feature in _EXCLUDED_REPORT_DRIVER_FEATURES:
            continue
        filtered.append(
            {
                **driver,
                "display_name": _feature_display_name(feature),
                "impact": "推高成本" if driver["shap"] > 0 else "降低成本",
            }
        )
        if len(filtered) >= top_n:
            break
    return filtered


def driver_structure(result: dict, fe: FeatureEngineer) -> list[dict]:
    """按正式特征组汇总局部 SHAP，并转换为发行支持度雷达分值。"""
    feature_groups = {
        feature: group_name
        for group_name, features in getattr(fe, "feature_group_columns_", {}).items()
        for feature in features
    }
    feature_groups.update(_DRIVER_GROUP_OVERRIDES)

    grouped = {
        group_name: {"signed_shap": 0.0, "absolute_shap": 0.0}
        for group_name, _ in _DRIVER_GROUPS
    }
    for item in result.get("top_drivers", []):
        feature = item["feature"]
        if feature in _EXCLUDED_REPORT_DRIVER_FEATURES:
            continue
        group_name = feature_groups.get(feature)
        if group_name not in grouped:
            continue
        shap_value = float(item["shap"])
        grouped[group_name]["signed_shap"] += shap_value
        grouped[group_name]["absolute_shap"] += abs(shap_value)

    total_absolute = sum(item["absolute_shap"] for item in grouped.values())
    rows = []
    for group_name, display_name in _DRIVER_GROUPS:
        signed_shap = grouped[group_name]["signed_shap"]
        absolute_shap = grouped[group_name]["absolute_shap"]
        support_bp = -signed_shap
        support_score = (
            50.0
            if total_absolute == 0
            else max(0.0, min(100.0, 50.0 + 50.0 * support_bp / total_absolute))
        )
        rows.append(
            {
                "category": group_name,
                "display_name": display_name,
                "support_score": round(support_score, 2),
                "support_bp": round(support_bp, 3),
                "importance_weight": round(
                    absolute_shap / total_absolute if total_absolute else 0.0,
                    6,
                ),
            }
        )
    return rows


def _forecast_table_columns() -> list[tuple[str, int, str]]:
    return [
        ("日期", 12, "left"),
        ("星期", 4, "left"),
        ("历史分位", 8, "right"),
        ("建议", 6, "left"),
        ("节约bp", 8, "right"),
        ("万元/年", 10, "right"),
    ]


def _table_row(values: list, columns: list[tuple[str, int, str]]) -> str:
    return "  ".join(
        _cell(value, width, align) for value, (_, width, align) in zip(values, columns)
    )


def build_score_today_report(
    result: dict,
    readiness: dict | None,
    market_driver_rows: list[dict],
    validation_summary: dict,
    forecast_df: pd.DataFrame,
) -> str:
    """生成固定三段式中文业务报告。"""
    if result["recommend"] == "strong_buy":
        decision_note = "当前处于历史较优发行窗口。"
    elif result["recommend"] == "neutral":
        decision_note = "当前成本处于历史中间区间，建议等待更优窗口并结合资金需求安排。"
    else:
        decision_note = "当前窗口不占优，若无刚性资金需求建议等待。"

    lines = [
        f"发行方案: {result['tenor']:g}Y {result['rating']} {result['bond_type']}，规模 {result['issue_size']:g} 亿。",
        "",
        "一、发行建议",
        (
            f"市场数据：截至{_fmt_month_day(result['market_data_date'])}，"
            f"模型预测当日发行利差偏离可比债中位数 {_fmt_bp(result['pred_bp'])}，"
            f"处于历史 P{result['percentile']:.0f}。"
        ),
    ]

    if readiness:
        subject_spread_text = _subject_spread_text(readiness)
        lines.append(
            f"公司业务指标：截至{_fmt_month_day(readiness['date'])}，"
            f"LCR六十日百分位 {_fmt_pct(readiness.get('ef_lcr_pctile_60d'))}，"
            f"NSFR六十日百分位 {_fmt_pct(readiness.get('ef_nsfr_pctile_60d'))}"
            f"{subject_spread_text}。{_company_readiness_sentence(readiness)}。"
        )
    else:
        lines.append("公司业务指标：暂无可用公司业务指标，本次仅使用市场择时信号。")

    lines.append(f"整体结论: {result['decision']}。{decision_note}")

    lines.extend(["", "二、驱动因子"])
    if market_driver_rows:
        for idx, driver in enumerate(market_driver_rows, 1):
            lines.append(
                f"{idx}. {driver['display_name']}：{driver['value']:.4f}（{driver['impact']}）"
            )
    else:
        lines.append("- 本次 Top SHAP 因子未筛出可展示因子。")

    lines.extend(
        [
            "",
            "三、置信度与区间预测",
            _ic_window_analysis(validation_summary),
            _forecast_table_text(forecast_df),
        ]
    )
    return "\n".join(lines)


def _fmt_bp(value) -> str:
    if value is None or pd.isna(value):
        return "NA"
    return f"{float(value):+.2f} bp"


def _fmt_pct(value) -> str:
    if value is None or pd.isna(value):
        return "NA"
    return f"{float(value):.1%}"


def _fmt_rank(value) -> str:
    if value is None or pd.isna(value):
        return "NA"
    return f"P{float(value) * 100:.0f}"


def _fmt_signed(value, digits: int = 2) -> str:
    if value is None or pd.isna(value):
        return "NA"
    value = float(value)
    if abs(value) < 0.5 * 10 ** (-digits):
        value = 0.0
    return f"{value:+.{digits}f}"


def _feature_display_name(feature: str) -> str:
    return _FEATURE_LABELS.get(feature, feature)


def _fmt_month_day(value) -> str:
    dt = pd.Timestamp(value)
    return f"{dt.month}月{dt.day}日"


def _subject_spread_text(readiness: dict) -> str:
    spread = readiness.get("ef_subject_spread_bp")
    pctile = readiness.get("ef_subject_spread_pctile")
    date = readiness.get("ef_subject_spread_date")
    if spread is None or pd.isna(spread):
        return ""

    date_prefix = f"；截至{_fmt_month_day(date)}，" if date else "；"
    pctile_text = _fmt_rank(pctile)
    if pctile_text == "NA":
        return f"{date_prefix}主体利差 {float(spread):.2f} bp，历史分位 NA"

    return (
        f"{date_prefix}主体利差 {float(spread):.2f} bp，"
        f"近一年历史分位 {pctile_text}，{_subject_spread_sentence(pctile)}"
    )


def _subject_spread_sentence(pctile) -> str:
    if pctile is None or pd.isna(pctile):
        return "主体定价位置不明"
    pctile = float(pctile)
    if pctile >= 0.75:
        return "主体信用定价偏贵，发行成本压力偏高"
    if pctile >= 0.55:
        return "主体信用定价略偏贵"
    if pctile <= 0.25:
        return "主体信用定价处于低位，对发行较友好"
    if pctile <= 0.45:
        return "主体信用定价略偏低"
    return "主体信用定价接近中枢"


def _company_readiness_sentence(readiness: dict) -> str:
    label = readiness.get("readiness_label", "数据不足")
    if label == "宽裕":
        liquidity = "公司流动性充裕"
    elif label == "适中":
        liquidity = "公司流动性尚可"
    elif label == "偏紧":
        liquidity = "公司流动性偏紧"
    else:
        liquidity = "公司流动性数据不足"

    return liquidity


def _forecast_table_text(result_df: pd.DataFrame) -> str:
    columns = _forecast_table_columns()
    line_width = sum(width for _, width, _ in columns) + 2 * (len(columns) - 1)
    lines = [
        "注：节约bp/万元年为负值表示成本节约，正值表示成本增加。",
        _table_row([name for name, _, _ in columns], columns),
        "-" * line_width,
    ]
    for _, row in result_df.iterrows():
        lines.append(
            _table_row(
                [
                    row["date"],
                    row["weekday"],
                    f"P{row['percentile']:.1f}",
                    row["label"],
                    _fmt_signed(row["savings_bp_vs_window_median"], 2),
                    _fmt_signed(row["savings_万元/年"], 0),
                ],
                columns,
            )
        )
    return "\n".join(lines)


def _ic_window_analysis(validation_summary: dict) -> str:
    tscv = validation_summary.get("tscv", {}) if validation_summary else {}
    ic = tscv.get("ic")
    if ic is None or pd.isna(ic):
        return (
            "IC暂无可用验证值；下表仍按历史分位和建议做窗口排序参考，"
            "不把单点bp预测作为精确报价。"
        )
    ic = float(ic)
    if ic >= 0.6:
        level = "较强"
    elif ic >= 0.4:
        level = "中等偏强"
    elif ic >= 0.2:
        level = "一般"
    else:
        level = "偏弱"
    return f"IC={ic:.3f}，说明模型对发行窗口优劣的排序能力{level}。"


def _display_width(value) -> int:
    text = str(value)
    return sum(
        2 if unicodedata.east_asian_width(ch) in {"F", "W"} else 1 for ch in text
    )


def _cell(value, width: int, align: str = "left") -> str:
    text = str(value)
    pad = max(0, width - _display_width(text))
    if align == "right":
        return " " * pad + text
    if align == "center":
        left = pad // 2
        return " " * left + text + " " * (pad - left)
    return text + " " * pad
