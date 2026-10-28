"""全市场两融日频数据、滚动预测标签与经济特征。"""

from __future__ import annotations

import warnings
from pathlib import Path

import numpy as np
import pandas as pd

from data import (
    MARGIN_BASE_SOURCE_GROUPS,
    MARGIN_EQUITY_FEATURES,
    MARGIN_OPTIONAL_SOURCE_GROUPS,
    FeatureBuildContext,
    build_feature_bundle,
)
from data.data import DATA_FILE

MARKET_MARGIN_SHEET = "两融"
DEFAULT_MARKET_MODEL_START = pd.Timestamp("2019-01-01")
FORECAST_HORIZONS = (1, 5, 20)

MARKET_FIELD_SPECS = {
    "market_margin": (("沪深合计:融资融券余额", "融资融券:余额"), "亿元"),
    "financing_balance": (("沪深合计:融资余额", "融资融券:融资余额"), "亿元"),
    "financing_buy": (("沪深合计:融资买入额", "融资融券:融资买入额"), "亿元"),
    "financing_repayment": (("沪深合计:融资偿还额",), "亿元"),
    "securities_lending_balance": (("融资融券:融券余额",), "亿元"),
    "securities_lending_sell": (("融资融券:融券卖出额",), "亿元"),
    "active_investors": (("融资融券:参与交易的投资者数量",), "名"),
    "individual_investors": (("融资融券:个人投资者数量",), "万名"),
    "institutional_investors": (("融资融券:机构投资者数量",), "家"),
    "indebted_investors": (("融资融券:有融资融券负债的投资者数量",), "名"),
    "collateral_value": (("融资融券:担保物总价值",), "亿元"),
    "collateral_cash": (("融资融券:担保资金",), "亿元"),
    "eligible_securities_value": (("融资融券:可充抵保证金证券市值",), "亿元"),
    "maintenance_ratio_pct": (("融资融券:平均维持担保比例",), "%"),
    "margin_turnover": (("融资融券:交易额",), "亿元"),
    "margin_turnover_share_pct": (("融资融券:两融交易额占A股交易额比重",), "%"),
    "margin_float_mcap_share_pct": (("融资融券:两融余额占A股流通市值比重",), "%"),
}
MARKET_MARGIN_UNIT = "亿元"

# 核心 25 个经济结构特征按经济含义分组，组间顺序即 CORE_ECONOMIC_FEATURES
# 与生产模型的输入顺序（模型口径冻结，不得调整）。特征的展示与文档分类
# 见 FEATURE_TAXONOMY。
FEATURE_GROUPS = {
    "余额惯性": (
        "market_ret_1d",
        "market_ret_5d",
        "market_ret_20d",
        "market_z_60d",
        "market_vol_20d",
    ),
    "交易与客户需求": (
        "financing_buy_to_balance",
        "margin_turnover_to_balance",
        "active_investors_chg_5d",
        "indebted_investors_chg_5d",
        "margin_turnover_share",
    ),
    "担保与杠杆结构": (
        "securities_lending_share",
        "collateral_coverage",
        "collateral_cash_share",
        "maintenance_ratio",
        "balance_to_float_mcap",
    ),
    "权益风险偏好": (
        "csi300_ret_5d",
        "csi300_ret_20d",
        "csi300_vol_20d",
        "equity_bond_spread_z_252d",
        "vix_chg_5d",
    ),
    "资金价格": (
        "dr007_vs_policy",
        "dr007_chg_5d",
        "r007_dr007_spread",
    ),
    "日历约束": (
        "is_month_end",
        "is_quarter_end",
    ),
}

CORE_ECONOMIC_FEATURES = tuple(
    feature for group in FEATURE_GROUPS.values() for feature in group
)
MARGIN_BEHAVIOR_FEATURES = (
    "margin_balance_ret_3d",
    "margin_balance_ret_10d",
    "margin_balance_ret_60d",
    "margin_balance_ma20_dev",
    "margin_balance_ma60_dev",
    "margin_balance_accel_5d",
    "margin_balance_drawdown_60d",
    "margin_balance_pctile_252d",
    "financing_net_flow_10d_to_balance",
    "financing_net_flow_20d_to_balance",
    "financing_repay_buy_ratio_5d",
    "financing_buy_market_turnover_5d",
    "financing_net_flow_z_60d",
    "financing_net_flow_accel_5d",
    "balance_to_float_mcap_pctile_504d",
    "market_turnover_log_z_60d",
    "downside_return_volatility",
    "saturation_drawdown",
    "financing_participation_momentum",
    "market_turnover_return_interaction",
    "maintenance_ratio_chg_5d",
)
OPTIONAL_ECONOMIC_FEATURES = {
    "macro": (
        "CPI",
        "PPI",
        "PMI",
        "SOCIAL_FINANCE",
        "M2",
        "pmi_above_50",
    ),
    "margin_equity": MARGIN_EQUITY_FEATURES,
    "margin_behavior": MARGIN_BEHAVIOR_FEATURES,
}
MARGIN_DERIVED_FEATURE_GROUPS = ("margin_behavior",)
MARGIN_OPTIONAL_FEATURE_GROUPS = (
    MARGIN_OPTIONAL_SOURCE_GROUPS + MARGIN_DERIVED_FEATURE_GROUPS
)

FLOW_DECOMPOSITION_FEATURES = (
    "financing_repayment_to_balance",
    "financing_buy_5d_to_balance",
    "financing_repayment_5d_to_balance",
    "financing_net_flow_5d_to_balance",
    "securities_lending_flow_5d_to_balance",
    "financing_repayment_acceleration",
)
PRODUCTION_ECONOMIC_FEATURES = (
    CORE_ECONOMIC_FEATURES + MARGIN_EQUITY_FEATURES + MARGIN_BEHAVIOR_FEATURES
)
PRODUCTION_THREE_LAYER_FEATURES = (
    CORE_ECONOMIC_FEATURES
    + FLOW_DECOMPOSITION_FEATURES
    + MARGIN_EQUITY_FEATURES
    + MARGIN_BEHAVIOR_FEATURES
)

# 引擎内为三层方案显式构造的 7 个衍生特征，不在注册表内，由
# state_direction_quantile_experiment._design_matrix 按本常量生成。
STATE_FEATURES = ("state_bear", "state_bull")
DOWNSIDE_RETURN_FEATURES = ("downside_ret_5d", "downside_ret_20d")
DERIVED_STATE_FEATURES = STATE_FEATURES + DOWNSIDE_RETURN_FEATURES
INTERACTION_FEATURES = (
    "downside_volatility",
    "bear_repayment_pressure",
    "bear_net_flow",
)
ENGINE_DERIVED_FEATURES = DERIVED_STATE_FEATURES + INTERACTION_FEATURES

# 特征分类目录（主题 × 加工层次）。两融特征源自“两融”工作表，市场&宏观特征
# 源自公共权益市场、资金价格、日历与可选宏观源；原始 = 直接比值/份额/单期收益/
# 利差/日历标识，无滚动窗口统计或跨期差分；衍生 = 变化率、滚动统计、波动、加速度、
# 标准分、历史分位、回撤等时序加工；交互特征 = 两个特征乘积，表达状态条件效应；
# 派生特征 = 引擎为三层方案显式构造的状态标识与截断下跌收益。
# 该目录只用于展示与口径说明，不参与模型输入顺序（顺序由各 *_FEATURES 常量冻结）。
FEATURE_TAXONOMY: dict[str, tuple[str, ...]] = {
    "两融特征_原始": (
        "financing_buy_to_balance",
        "margin_turnover_to_balance",
        "margin_turnover_share",
        "securities_lending_share",
        "collateral_coverage",
        "collateral_cash_share",
        "maintenance_ratio",
        "balance_to_float_mcap",
        "financing_repayment_to_balance",
    ),
    "两融特征_衍生": (
        "market_ret_1d",
        "market_ret_5d",
        "market_ret_20d",
        "market_z_60d",
        "market_vol_20d",
        "active_investors_chg_5d",
        "indebted_investors_chg_5d",
        "financing_buy_5d_to_balance",
        "financing_repayment_5d_to_balance",
        "financing_net_flow_5d_to_balance",
        "securities_lending_flow_5d_to_balance",
        "financing_repayment_acceleration",
        "margin_balance_ret_3d",
        "margin_balance_ret_10d",
        "margin_balance_ret_60d",
        "margin_balance_ma20_dev",
        "margin_balance_ma60_dev",
        "margin_balance_accel_5d",
        "margin_balance_drawdown_60d",
        "margin_balance_pctile_252d",
        "financing_net_flow_10d_to_balance",
        "financing_net_flow_20d_to_balance",
        "financing_repay_buy_ratio_5d",
        "financing_buy_market_turnover_5d",
        "financing_net_flow_z_60d",
        "financing_net_flow_accel_5d",
        "balance_to_float_mcap_pctile_504d",
        "market_turnover_log_z_60d",
        "maintenance_ratio_chg_5d",
    ),
    "市场宏观特征_原始": (
        "csi300_ret_5d",
        "csi300_ret_20d",
        "csi300_vol_20d",
        "dr007_vs_policy",
        "r007_dr007_spread",
        "is_month_end",
        "is_quarter_end",
        "all_a_ret_5d",
        "all_a_ret_20d",
        "growth_proxy_ret_5d",
        "growth_proxy_ret_20d",
    ),
    "市场宏观特征_衍生": (
        "equity_bond_spread_z_252d",
        "vix_chg_5d",
        "dr007_chg_5d",
        "all_a_ma60_dev",
        "all_a_drawdown_20d",
        "all_a_downside_vol_20d",
        "all_a_turnover_log_z_60d",
    ),
    "交互特征": (
        "downside_return_volatility",
        "saturation_drawdown",
        "financing_participation_momentum",
        "market_turnover_return_interaction",
    ) + INTERACTION_FEATURES,
    "派生特征": DERIVED_STATE_FEATURES,
}


def validate_feature_taxonomy() -> list[str]:
    """校验分类目录恰好覆盖三层模型全部 67 维输入且类间无重叠。

    返回问题列表；为空表示口径一致（60 个注册特征 + 7 个引擎衍生特征）。
    """
    problems: list[str] = []
    for name, members in FEATURE_TAXONOMY.items():
        duplicates = [feature for feature in members if members.count(feature) > 1]
        if duplicates:
            problems.append(f"{name} 内部重复: {sorted(set(duplicates))}")
    classified = [feature for members in FEATURE_TAXONOMY.values() for feature in members]
    if len(classified) != len(set(classified)):
        problems.append("分类目录存在跨类重复特征")
    expected = PRODUCTION_THREE_LAYER_FEATURES + ENGINE_DERIVED_FEATURES
    missing = [feature for feature in expected if feature not in set(classified)]
    if missing:
        problems.append(f"分类目录遗漏特征: {missing}")
    extra = [feature for feature in classified if feature not in set(expected)]
    if extra:
        problems.append(f"分类目录含非生产特征: {extra}")
    return problems

FEATURE_LABELS = {
    "market_ret_1d": "全市场两融余额近 1 日变化率",
    "market_ret_5d": "全市场两融余额近 5 日变化率",
    "market_ret_20d": "全市场两融余额近 20 日变化率",
    "market_z_60d": "全市场两融余额 60 日标准分",
    "market_vol_20d": "全市场两融余额近 20 日波动",
    "financing_buy_to_balance": "融资买入额/融资余额",
    "margin_turnover_to_balance": "两融交易额/两融余额",
    "active_investors_chg_5d": "参与交易投资者数近 5 日变化",
    "indebted_investors_chg_5d": "有两融负债投资者数近 5 日变化",
    "margin_turnover_share": "两融交易额占 A 股交易额比重",
    "securities_lending_share": "融券余额占两融余额比重",
    "collateral_coverage": "担保物价值/两融余额",
    "collateral_cash_share": "担保资金占担保物价值比重",
    "maintenance_ratio": "平均维持担保比例",
    "balance_to_float_mcap": "两融余额占 A 股流通市值比重",
    "csi300_ret_5d": "沪深 300 近 5 日收益",
    "csi300_ret_20d": "沪深 300 近 20 日收益",
    "csi300_vol_20d": "沪深 300 近 20 日波动",
    "equity_bond_spread_z_252d": "股债性价比（差值）252 日标准分",
    "vix_chg_5d": "VIX 近 5 日变化",
    "dr007_vs_policy": "DR007 相对政策利率",
    "dr007_chg_5d": "DR007 近 5 日变化",
    "r007_dr007_spread": "R007-DR007 利差",
    "CPI": "CPI 同比",
    "PPI": "PPI",
    "PMI": "制造业 PMI",
    "SOCIAL_FINANCE": "社会融资规模存量同比",
    "M2": "M2 同比",
    "pmi_above_50": "PMI 高于荣枯线",
    "is_month_end": "月末窗口",
    "is_quarter_end": "季末窗口",
    "financing_repayment_to_balance": "融资偿还额/融资余额",
    "financing_buy_5d_to_balance": "近 5 日融资买入额/融资余额",
    "financing_repayment_5d_to_balance": "近 5 日融资偿还额/融资余额",
    "financing_net_flow_5d_to_balance": "近 5 日融资净流入/融资余额",
    "securities_lending_flow_5d_to_balance": "近 5 日融券余额变化/两融余额",
    "financing_repayment_acceleration": "融资偿还额 5 日/20 日均值",
    "margin_balance_ret_3d": "全市场两融余额近 3 日变化率",
    "margin_balance_ret_10d": "全市场两融余额近 10 日变化率",
    "margin_balance_ret_60d": "全市场两融余额近 60 日变化率",
    "margin_balance_ma20_dev": "全市场两融余额相对 20 日均线偏离",
    "margin_balance_ma60_dev": "全市场两融余额相对 60 日均线偏离",
    "margin_balance_accel_5d": "全市场两融余额 5 日变化加速度",
    "margin_balance_drawdown_60d": "全市场两融余额距 60 日高点回撤",
    "margin_balance_pctile_252d": "全市场两融余额 252 日历史分位",
    "financing_net_flow_10d_to_balance": "近 10 日融资净流入/期初融资余额",
    "financing_net_flow_20d_to_balance": "近 20 日融资净流入/期初融资余额",
    "financing_repay_buy_ratio_5d": "近 5 日融资偿还额/融资买入额",
    "financing_buy_market_turnover_5d": "近 5 日融资买入额/A 股成交额",
    "financing_net_flow_z_60d": "融资净流入率 60 日标准分",
    "financing_net_flow_accel_5d": "融资净流入 5 日变化加速度",
    "balance_to_float_mcap_pctile_504d": "两融余额占流通市值比重两年分位",
    "market_turnover_log_z_60d": "A 股成交额对数 60 日标准分",
    "downside_return_volatility": "沪深 300 下跌收益与波动交互",
    "saturation_drawdown": "杠杆饱和度与下跌交互",
    "financing_participation_momentum": "融资参与度与市场趋势交互",
    "market_turnover_return_interaction": "成交活跃度与市场趋势交互",
    "maintenance_ratio_chg_5d": "平均维持担保比例近 5 日变化",
    "all_a_ret_5d": "东方财富全 A 近 5 日收益",
    "all_a_ret_20d": "东方财富全 A 近 20 日收益",
    "all_a_ma60_dev": "东方财富全 A 相对 60 日均线偏离",
    "all_a_drawdown_20d": "东方财富全 A 距 20 日高点回撤",
    "all_a_downside_vol_20d": "东方财富全 A 近 20 日下行波动",
    "all_a_turnover_log_z_60d": "东方财富全 A 成交额对数 60 日标准分",
    "growth_proxy_ret_5d": "成长高弹性指数近 5 日平均收益",
    "growth_proxy_ret_20d": "成长高弹性指数近 20 日平均收益",
    "state_bear": "熊市状态标识（规则识别）",
    "state_bull": "牛市状态标识（规则识别）",
    "downside_ret_5d": "沪深 300 近 5 日下跌收益",
    "downside_ret_20d": "沪深 300 近 20 日下跌收益",
    "downside_volatility": "下跌收益 × 波动率交互",
    "bear_repayment_pressure": "熊市 × 融资偿还压力交互",
    "bear_net_flow": "熊市 × 融资净流入交互",
}


def resolve_economic_feature_names(
    additional_feature_groups: tuple[str, ...] = (),
) -> tuple[str, ...]:
    """返回默认 25 维特征及显式启用的源/派生增量特征。"""
    unknown = set(additional_feature_groups) - set(MARGIN_OPTIONAL_FEATURE_GROUPS)
    if unknown:
        raise ValueError(f"两融模型不支持增量特征组: {sorted(unknown)}")
    if len(additional_feature_groups) != len(set(additional_feature_groups)):
        raise ValueError("两融增量特征组不得重复。")
    optional = tuple(
        feature
        for group_name in additional_feature_groups
        for feature in OPTIONAL_ECONOMIC_FEATURES[group_name]
    )
    return CORE_ECONOMIC_FEATURES + optional


def _read_market_sheet(
    path: str | Path,
) -> tuple[pd.DataFrame, dict[str, str]]:
    frame = pd.read_excel(
        path,
        sheet_name=MARKET_MARGIN_SHEET,
        header=1,
        index_col=0,
    )
    unit_rows = frame.loc[frame.index.astype(str) == "单位"]
    if unit_rows.empty:
        raise ValueError("两融工作表缺少明确的单位行。")
    units = {
        str(column): str(unit_rows.iloc[0][column]).strip()
        for column in frame.columns
        if pd.notna(unit_rows.iloc[0][column])
    }
    return frame, units


def _resolve_market_source_columns(frame: pd.DataFrame) -> dict[str, str]:
    resolved = {}
    missing = {}
    for target, (aliases, _) in MARKET_FIELD_SPECS.items():
        source = next((alias for alias in aliases if alias in frame.columns), None)
        if source is None:
            missing[target] = list(aliases)
        else:
            resolved[target] = source
    if missing:
        raise ValueError(f"两融工作表缺少字段: {missing}")
    return resolved


def load_market_margin_data(
    path: str | Path = DATA_FILE,
) -> pd.DataFrame:
    """读取 Choice 全市场两融日频明细并验证字段和单位。"""
    frame, units = _read_market_sheet(path)
    source_columns = _resolve_market_source_columns(frame)

    unit_errors = {
        target: (units.get(source_columns[target]), expected_unit)
        for target, (_, expected_unit) in MARKET_FIELD_SPECS.items()
        if units.get(source_columns[target]) != expected_unit
    }
    if unit_errors:
        raise ValueError(f"两融工作表单位与模型约定不一致: {unit_errors}")

    frame = frame.copy()
    frame.index = pd.to_datetime(frame.index, errors="coerce", format="mixed")
    frame = frame[frame.index.notna()]
    frame = frame[~frame.index.duplicated(keep="last")].sort_index()
    renamed = {source: target for target, source in source_columns.items()}
    result = frame[list(source_columns.values())].rename(columns=renamed)
    result = result.apply(pd.to_numeric, errors="coerce")
    result = result.dropna(
        subset=[
            "market_margin",
            "financing_balance",
            "financing_buy",
            "financing_repayment",
        ]
    )
    if result.empty:
        raise ValueError("全市场两融余额没有可用数值。")
    if (result["market_margin"] <= 0).any():
        raise ValueError("全市场两融余额存在非正数，需先核对 Choice 数据口径。")
    result.index.name = "date"
    return result.sort_index()


def load_market_margin_units(
    path: str | Path = DATA_FILE,
) -> dict[str, str]:
    """返回以标准字段名表示的显式工作簿单位。"""
    frame, raw_units = _read_market_sheet(path)
    source_columns = _resolve_market_source_columns(frame)
    return {
        target: raw_units.get(source, "") for target, source in source_columns.items()
    }


def _merge_asof_on_index(
    left: pd.DataFrame,
    right: pd.DataFrame,
) -> pd.DataFrame:
    left_frame = left.sort_index().reset_index()
    right_frame = right.sort_index().reset_index()
    left_frame = left_frame.rename(columns={left_frame.columns[0]: "date"})
    right_frame = right_frame.rename(columns={right_frame.columns[0]: "date"})
    return pd.merge_asof(
        left_frame,
        right_frame,
        on="date",
        direction="backward",
    ).set_index("date")


def _rolling_zscore(
    series: pd.Series,
    window: int,
    min_periods: int,
) -> pd.Series:
    rolling = series.rolling(window, min_periods=min_periods)
    return (series - rolling.mean()) / rolling.std().replace(0, np.nan)


def _last_value_percentile(values: pd.Series) -> float:
    current = values.iloc[-1]
    if pd.isna(current):
        return float("nan")
    valid = values.dropna()
    return float((valid <= current).mean())


def _add_margin_behavior_features(
    result: pd.DataFrame,
    balance: pd.Series,
) -> None:
    """原地加入只使用当日及历史数据的两融行为候选特征。"""
    result["margin_balance_ret_3d"] = balance.pct_change(3)
    result["margin_balance_ret_10d"] = balance.pct_change(10)
    result["margin_balance_ret_60d"] = balance.pct_change(60)
    result["margin_balance_ma20_dev"] = balance / balance.rolling(20).mean() - 1
    result["margin_balance_ma60_dev"] = balance / balance.rolling(60).mean() - 1
    balance_change_5d = balance.diff(5)
    result["margin_balance_accel_5d"] = (
        balance_change_5d - balance_change_5d.shift(5)
    ) / balance.shift(10)
    result["margin_balance_drawdown_60d"] = balance / balance.rolling(60).max() - 1
    result["margin_balance_pctile_252d"] = balance.rolling(252, min_periods=60).apply(
        _last_value_percentile
    )

    financing_buy_5d = result["financing_buy"].rolling(5, min_periods=3).sum()
    financing_repayment_5d = (
        result["financing_repayment"].rolling(5, min_periods=3).sum()
    )
    financing_net_flow = result["financing_buy"] - result["financing_repayment"]
    net_flow_5d = financing_net_flow.rolling(5, min_periods=3).sum()
    for window in (10, 20):
        result[f"financing_net_flow_{window}d_to_balance"] = financing_net_flow.rolling(
            window, min_periods=window // 2
        ).sum() / result["financing_balance"].shift(window)
    result["financing_repay_buy_ratio_5d"] = (
        financing_repayment_5d / financing_buy_5d.replace(0, np.nan)
    )
    market_turnover = result["margin_turnover"] / (
        result["margin_turnover_share_pct"] / 100
    ).replace(0, np.nan)
    result["financing_buy_market_turnover_5d"] = (
        financing_buy_5d
        / market_turnover.rolling(5, min_periods=3).sum().replace(0, np.nan)
    )
    net_flow_rate = financing_net_flow / result["financing_balance"].shift(1)
    result["financing_net_flow_z_60d"] = _rolling_zscore(net_flow_rate, 60, 20)
    result["financing_net_flow_accel_5d"] = (
        net_flow_5d - net_flow_5d.shift(5)
    ) / result["financing_balance"].shift(10)
    result["balance_to_float_mcap_pctile_504d"] = (
        result["balance_to_float_mcap"]
        .rolling(504, min_periods=120)
        .apply(_last_value_percentile)
    )
    log_market_turnover = np.log1p(market_turnover.clip(lower=0))
    result["market_turnover_log_z_60d"] = _rolling_zscore(log_market_turnover, 60, 20)
    negative_return_5d = result["csi300_ret_5d"].clip(upper=0)
    negative_return_20d = result["csi300_ret_20d"].clip(upper=0)
    result["downside_return_volatility"] = negative_return_5d * result["csi300_vol_20d"]
    result["saturation_drawdown"] = (
        result["balance_to_float_mcap"] * negative_return_20d
    )
    result["financing_participation_momentum"] = (
        result["financing_buy_market_turnover_5d"] * result["csi300_ret_5d"]
    )
    result["market_turnover_return_interaction"] = (
        result["market_turnover_log_z_60d"] * result["csi300_ret_5d"]
    )
    result["maintenance_ratio_chg_5d"] = result["maintenance_ratio"].diff(5)


def _add_market_features(daily: pd.DataFrame) -> pd.DataFrame:
    result = daily.copy()
    balance = result["market_margin"].astype(float)

    result["market_ret_1d"] = balance.pct_change(1)
    result["market_ret_5d"] = balance.pct_change(5)
    result["market_ret_20d"] = balance.pct_change(20)
    result["market_z_60d"] = _rolling_zscore(balance, 60, 20)
    result["market_vol_20d"] = result["market_ret_1d"].rolling(20).std()

    result["financing_buy_to_balance"] = (
        result["financing_buy"] / result["financing_balance"]
    )
    result["margin_turnover_to_balance"] = (
        result["margin_turnover"] / result["market_margin"]
    )
    result["active_investors_chg_5d"] = result["active_investors"].pct_change(5)
    result["indebted_investors_chg_5d"] = result["indebted_investors"].pct_change(5)
    result["margin_turnover_share"] = result["margin_turnover_share_pct"] / 100

    result["securities_lending_share"] = (
        result["securities_lending_balance"] / result["market_margin"]
    )
    result["collateral_coverage"] = result["collateral_value"] / result["market_margin"]
    result["collateral_cash_share"] = (
        result["collateral_cash"] / result["collateral_value"]
    )
    result["maintenance_ratio"] = result["maintenance_ratio_pct"] / 100
    result["balance_to_float_mcap"] = result["margin_float_mcap_share_pct"] / 100

    result["financing_repayment_proxy"] = (
        result["financing_balance"].shift(1)
        + result["financing_buy"]
        - result["financing_balance"]
    )
    financing_buy_5d = result["financing_buy"].rolling(5, min_periods=3).sum()
    financing_repayment_5d = (
        result["financing_repayment"]
        .rolling(
            5,
            min_periods=3,
        )
        .sum()
    )
    repayment_mean_5d = (
        result["financing_repayment"]
        .rolling(
            5,
            min_periods=3,
        )
        .mean()
    )
    repayment_mean_20d = (
        result["financing_repayment"]
        .rolling(
            20,
            min_periods=10,
        )
        .mean()
    )
    result["financing_repayment_to_balance"] = (
        result["financing_repayment"] / result["financing_balance"]
    )
    result["financing_buy_5d_to_balance"] = (
        financing_buy_5d / result["financing_balance"]
    )
    result["financing_repayment_5d_to_balance"] = (
        financing_repayment_5d / result["financing_balance"]
    )
    result["financing_net_flow_5d_to_balance"] = (
        financing_buy_5d - financing_repayment_5d
    ) / result["financing_balance"]
    result["securities_lending_flow_5d_to_balance"] = (
        result["securities_lending_balance"].diff().rolling(5, min_periods=3).sum()
        / result["market_margin"]
    )
    result["financing_repayment_acceleration"] = (
        repayment_mean_5d / repayment_mean_20d - 1
    )

    _add_margin_behavior_features(result, balance)

    result["equity_bond_spread_z_252d"] = _rolling_zscore(
        result["equity_bond_spread"],
        252,
        60,
    )
    index_series = pd.Series(result.index, index=result.index)
    for horizon in FORECAST_HORIZONS:
        result[f"target_amount_t{horizon}"] = balance.shift(-horizon) - balance
        result[f"target_pct_t{horizon}"] = balance.shift(-horizon) / balance - 1
        result[f"target_date_t{horizon}"] = index_series.shift(-horizon)
    for block_number, (start, end) in enumerate(
        ((0, 5), (5, 10), (10, 15), (15, 20)),
        start=1,
    ):
        start_balance = balance if start == 0 else balance.shift(-start)
        result[f"target_amount_t20_block{block_number}"] = (
            balance.shift(-end) - start_balance
        )
        result[f"target_pct_t20_block{block_number}"] = (
            balance.shift(-end) - start_balance
        ) / balance
    return result.replace([np.inf, -np.inf], np.nan)


def build_market_margin_daily_dataset(
    path: str | Path = DATA_FILE,
    model_start: str | pd.Timestamp = DEFAULT_MARKET_MODEL_START,
    additional_feature_groups: tuple[str, ...] = (),
) -> tuple[pd.DataFrame, dict]:
    """按交易日构造 T+1、T+5、T+20 滚动预测数据集。"""
    model_feature_names = resolve_economic_feature_names(additional_feature_groups)
    source_extensions = tuple(
        group
        for group in additional_feature_groups
        if group in MARGIN_OPTIONAL_SOURCE_GROUPS
    )
    source_groups = MARGIN_BASE_SOURCE_GROUPS + source_extensions
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="Could not infer format",
            category=UserWarning,
        )
        market = load_market_margin_data(path)
        units = load_market_margin_units(path)
        feature_bundle = build_feature_bundle(
            source_groups,
            FeatureBuildContext(data_path=Path(path)),
        )

    daily = market.copy()
    for frame in feature_bundle.frames.values():
        daily = _merge_asof_on_index(daily, frame)
    daily = _add_market_features(daily)

    model_start = pd.Timestamp(model_start)
    model = daily.loc[daily.index >= model_start].copy()
    missing_core = set(model_feature_names) - set(model.columns)
    if missing_core:
        raise ValueError(f"全市场两融研究缺少核心特征: {sorted(missing_core)}")

    metadata = {
        "raw_rows": int(len(market)),
        "raw_columns": int(len(MARKET_FIELD_SPECS)),
        "raw_start": market.index.min(),
        "raw_end": market.index.max(),
        "model_rows": int(len(model)),
        "model_start": model.index.min(),
        "model_end": model.index.max(),
        "units": units,
        "unit_explicit_in_workbook": units.get("market_margin") == MARKET_MARGIN_UNIT,
        "numeric_missing": {
            column: int(market[column].isna().sum()) for column in market.columns
        },
        "horizons": list(FORECAST_HORIZONS),
        "feature_names": list(model_feature_names),
        "additional_feature_groups": list(additional_feature_groups),
        "feature_missing": {
            column: int(model[column].isna().sum()) for column in model_feature_names
        },
        "flow_decomposition_feature_names": list(FLOW_DECOMPOSITION_FEATURES),
        "financing_repayment_source": "沪深合计:融资偿还额",
        "financing_repayment_proxy_mae": float(
            (model["financing_repayment"] - model["financing_repayment_proxy"])
            .abs()
            .mean()
        ),
        "financing_repayment_proxy_correlation": float(
            model["financing_repayment"].corr(model["financing_repayment_proxy"])
        ),
        "feature_source_groups": list(source_groups),
    }
    return model, metadata
