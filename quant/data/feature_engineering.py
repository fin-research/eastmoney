"""跨模型复用的标准特征工程接口与特征组注册表。"""

from __future__ import annotations

import calendar
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import numpy as np
import pandas as pd

from .equity import (
    build_equity_features,
    load_equity_features,
    load_margin_equity_features,
)
from .online_company import apply_fund_report_gap

FeatureScope = Literal["market", "bond_market", "company", "calendar"]


@dataclass(frozen=True)
class FeatureBuildContext:
    """特征构建所需的数据路径与日频锚点。"""

    data_path: Path
    primary_data_path: Path | None = None
    business_data_path: Path | None = None
    date_index: pd.DatetimeIndex | None = None
    source_frames: Mapping[str, pd.DataFrame] | None = None


@dataclass(frozen=True)
class FeatureGroupSpec:
    """一个可注册、可复用的特征组定义。"""

    name: str
    scope: FeatureScope
    builder: Callable[[FeatureBuildContext], pd.DataFrame]
    requires_date_index: bool = False


@dataclass(frozen=True)
class FeatureBundle:
    """按组保留来源、同时提供统一拼接结果的标准特征产物。"""

    frames: Mapping[str, pd.DataFrame]
    specs: Mapping[str, FeatureGroupSpec]
    combined: pd.DataFrame
    feature_names: tuple[str, ...]

    def __getitem__(self, group_name: str) -> pd.DataFrame:
        return self.frames[group_name]


def clean_datetime_index(frame: pd.DataFrame) -> pd.DataFrame:
    """统一清理、去重并升序排列日频索引。"""
    result = frame.copy()
    result.index = pd.to_datetime(result.index, errors="coerce")
    result = result[result.index.notna()]
    result = result[~result.index.duplicated(keep="last")].sort_index()
    return result


def staleness_days(raw_series: pd.Series) -> pd.Series:
    """计算自上次非空观测以来经过的索引步数。"""
    is_fresh = raw_series.notna()
    episodes = is_fresh.cumsum()
    return episodes.groupby(episodes).cumcount()


def _last_value_empirical_percentile(values: pd.Series) -> float:
    """返回窗口末值在窗口有效样本中的经验分位。"""
    current = values.iloc[-1]
    if pd.isna(current):
        return float("nan")
    valid = values.dropna()
    return float((valid <= current).mean())


def _last_value_minmax_percentile(values: pd.Series) -> float:
    value_range = values.max() - values.min()
    return float((values.iloc[-1] - values.min()) / (value_range + 1e-8))


def build_funding_features(path: str | Path) -> pd.DataFrame:
    """构建资金价格、收益率曲线及信用利差特征。"""
    return funding_features_from_frame(load_funding_frame(path))


def load_funding_frame(path: str | Path) -> pd.DataFrame:
    """读取标准资金价格源表，保留缺失值供特征与预测标签分别处理。"""
    frame = pd.read_excel(
        path,
        sheet_name="资金面数据",
        header=1,
        skiprows=[2, 3, 4, 5],
        index_col=0,
        parse_dates=True,
    ).rename(
        columns={
            "DR007": "DR007",
            "R007": "R007",
            "SHIBOR3M": "SHIBOR_3M",
            "公开市场操作(OMO)逆回购利率:7天": "reverse_repo_rate",
            "中债国债到期收益率:1年": "GOV_1Y",
            "中债国债到期收益率:3年": "GOV_3Y",
            "中债国债到期收益率:10年": "GOV_10Y",
            "中债国开债到期收益率:3年": "CDB_3Y",
            "中债国开债到期收益率:10年": "CDB_10Y",
            "中债企业债到期收益率(AAA):3年": "AAA_3Y",
        }
    )
    return clean_datetime_index(frame).apply(pd.to_numeric, errors="coerce")


def funding_features_from_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """资金价格标准表的唯一计算实现，支持文件与线上来源。"""
    frame = clean_datetime_index(frame)
    market_rate_columns = [
        "DR007",
        "R007",
        "SHIBOR_3M",
        "GOV_1Y",
        "GOV_3Y",
        "GOV_10Y",
        "CDB_3Y",
        "CDB_10Y",
        "AAA_3Y",
    ]
    frame[market_rate_columns] = frame[market_rate_columns].replace(0, np.nan)
    frame["reverse_repo_rate"] = frame["reverse_repo_rate"].replace(0, np.nan).ffill()

    features = pd.DataFrame(index=frame.index)
    features["dr007"] = frame["DR007"]
    features["dr007_vs_policy"] = frame["DR007"] - frame["reverse_repo_rate"]
    features["r007_dr007_spread"] = frame["R007"] - frame["DR007"]
    features["shibor_3m"] = frame["SHIBOR_3M"]
    features["gov_10y"] = frame["GOV_10Y"]
    features["term_spread"] = frame["GOV_10Y"] - frame["GOV_1Y"]

    features["dr007_ma5"] = frame["DR007"].rolling(5).mean()
    features["dr007_ma20"] = frame["DR007"].rolling(20).mean()
    features["dr007_vs_ma5_dev"] = frame["DR007"] - features["dr007_ma5"]
    features["dr007_chg_5d"] = frame["DR007"].diff(5)
    features["dr007_chg_20d"] = frame["DR007"].diff(20)
    features["dr007_vol_5d"] = frame["DR007"].rolling(5).std()
    features["dr007_vol_20d"] = frame["DR007"].rolling(20).std()
    features["dr007_vol_trend"] = features["dr007_vol_5d"] / (
        features["dr007_vol_20d"] + 1e-8
    )

    features["term_spread_chg_5d"] = features["term_spread"].diff(5)
    features["term_spread_chg_20d"] = features["term_spread"].diff(20)
    features["term_spread_slope_chg"] = (
        features["term_spread_chg_5d"] - features["term_spread_chg_20d"]
    )

    features["credit_spread"] = frame["AAA_3Y"] - frame["GOV_3Y"]
    features["credit_spread_chg_5d"] = features["credit_spread"].diff(5)
    features["credit_spread_chg_20d"] = features["credit_spread"].diff(20)
    features["credit_spread_pctile_60d"] = (
        features["credit_spread"]
        .rolling(60, min_periods=20)
        .apply(_last_value_empirical_percentile)
    )
    features["credit_spread_vol_20d"] = features["credit_spread"].rolling(20).std()
    features["cdb_gov_spread"] = frame["CDB_10Y"] - frame["GOV_10Y"]
    features["yield_vol_5d"] = frame["AAA_3Y"].rolling(5).std()
    features["curve_curvature"] = (
        2 * frame["GOV_3Y"] - frame["GOV_1Y"] - frame["GOV_10Y"]
    )
    features["short_term_spread"] = frame["GOV_3Y"] - frame["GOV_1Y"]
    features["gov_10y_chg_20d"] = frame["GOV_10Y"].diff(20)
    features["dr007_pctile_60d"] = (
        frame["DR007"].rolling(60, min_periods=20).apply(_last_value_minmax_percentile)
    )
    features["term_spread_pctile_60d"] = (
        features["term_spread"]
        .rolling(60, min_periods=20)
        .apply(_last_value_minmax_percentile)
    )
    features["gov_10y_pctile_60d"] = (
        frame["GOV_10Y"]
        .rolling(60, min_periods=20)
        .apply(_last_value_minmax_percentile)
    )
    return features


def build_secondary_bond_features(path: str | Path) -> pd.DataFrame:
    """构建债券二级市场成交及结构特征。"""
    frame = pd.read_excel(
        path,
        sheet_name="二级成交量",
        header=1,
        skiprows=[2],
        index_col=0,
        parse_dates=True,
    ).rename(
        columns={
            "总成交量(亿元)": "VOL",
            "利率债成交量(亿元)": "RATE_VOL",
            "金融机构债成交量(亿元)": "FIN_VOL",
            "非金公司信用债成交量(亿元)": "CORP_VOL",
        }
    )
    return secondary_features_from_frame(frame)


def secondary_features_from_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """Compute secondary trading features from the same dated source frame online or offline."""
    frame = clean_datetime_index(frame)
    features = pd.DataFrame(index=frame.index)
    features["bond_volume_20d_avg"] = frame["VOL"].rolling(20).mean()
    features["bond_volume_chg_5d"] = frame["VOL"].diff(5)
    features["bond_volume_pctile_60d"] = (
        frame["VOL"].rolling(60, min_periods=20).apply(_last_value_minmax_percentile)
    )
    if {"FIN_VOL", "CORP_VOL", "RATE_VOL"} <= set(frame.columns):
        credit_volume = frame["FIN_VOL"] + frame["CORP_VOL"]
        rate_volume = frame["RATE_VOL"]
        total = frame["VOL"].replace(0, np.nan)
        features["credit_bond_volume_ratio"] = credit_volume / total
        features["credit_volume_chg_5d"] = credit_volume.diff(5)
        features["rate_credit_volume_ratio"] = rate_volume / credit_volume.replace(
            0, np.nan
        )
    return features


def build_primary_bond_features(path: str | Path) -> pd.DataFrame:
    """构建债券一级市场供给与偿付压力特征。"""
    frame = pd.read_excel(
        path,
        sheet_name="发行与到期统计表(债券口径)",
        header=0,
        index_col=0,
        parse_dates=True,
    ).rename(
        columns={
            "发行总额(亿)": "issue_size",
            "发行只数(只)": "issue_count",
            "加权融资成本(%)": "weighted_cost",
            "净融资额(亿)": "net_financing",
            "到期偿还额(亿)": "maturity_amount",
            "回售额(亿)": "redemption_amount",
        }
    )
    return primary_features_from_frame(frame)


def primary_features_from_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """按自然日计算已发生供给/偿付；无发行成本不等于没有偿付。

    输出日期为统计观察日，调用方须按决策日 T-1 对齐。缺失统计日和
    缺失金额保持未知，不能补零；历史 maturity_wall 是回看而非未来到期墙。
    """
    frame = clean_datetime_index(frame)
    if not frame.empty:
        frame = frame.reindex(pd.date_range(frame.index.min(), frame.index.max()))

    features = pd.DataFrame(index=frame.index)
    for window in (5, 20):
        features[f"supply_{window}d"] = frame["issue_size"].rolling(window).sum()
        features[f"issue_count_{window}d"] = frame["issue_count"].rolling(window).sum()
    features["weighted_cost"] = frame["weighted_cost"]
    supply_mean = frame["issue_size"].rolling(365).mean()
    supply_std = frame["issue_size"].rolling(365).std()
    features["supply_5d_zscore"] = (features["supply_5d"] - supply_mean * 5) / (
        supply_std * np.sqrt(5) + 1e-8
    )
    features["supply_20d_zscore"] = (features["supply_20d"] - supply_mean * 20) / (
        supply_std * np.sqrt(20) + 1e-8
    )
    features["weighted_cost_chg_5d"] = frame["weighted_cost"].diff(5)
    features["weighted_cost_chg_20d"] = frame["weighted_cost"].diff(20)

    if "net_financing" in frame.columns:
        net_financing = frame["net_financing"]
        features["net_financing_5d"] = net_financing.rolling(5).sum()
        features["net_financing_20d"] = net_financing.rolling(20).sum()
        net_mean = net_financing.rolling(365).mean()
        net_std = net_financing.rolling(365).std()
        features["net_financing_zscore"] = (
            features["net_financing_5d"] - net_mean * 5
        ) / (net_std * np.sqrt(5) + 1e-8)
    if "maturity_amount" in frame.columns:
        maturity = frame["maturity_amount"]
        features["maturity_wall_20d"] = maturity.rolling(20).sum()
    if {"redemption_amount", "maturity_amount"} <= set(frame.columns):
        # Existing source field is RESALE_AMT (putbacks), not all redemptions.
        redemption = frame["redemption_amount"]
        maturity = frame["maturity_amount"]
        features["redemption_pressure"] = (redemption + maturity).rolling(20).sum()
    return features


def build_macro_features(
    path: str | Path,
    date_index: pd.DatetimeIndex,
) -> pd.DataFrame:
    """构建按指定日频索引向前填充的宏观特征。"""
    frame = pd.read_excel(
        path,
        sheet_name="宏观数据",
        header=1,
        skiprows=[2, 3, 4, 5],
        index_col=0,
        parse_dates=True,
    ).rename(
        columns={
            "中国:GDP:不变价:当季同比": "GDP",
            "中国:CPI:同比": "CPI",
            "中国:PPI": "PPI",
            "中国:PMI": "PMI",
            "中国:社会融资规模存量:同比": "SOCIAL_FINANCE",
            "中国:M2:同比": "M2",
        }
    )
    frame = clean_datetime_index(frame)
    # This Choice workbook uses zero placeholders for unavailable GDP, PMI,
    # social-financing and M2 observations. CPI/PPI can legitimately equal zero.
    from .online_macro import real_gdp_on_dates

    gdp = real_gdp_on_dates(path, date_index)
    if gdp is None and "GDP" not in frame:
        raise ValueError("缺少 GDP 不变价同比缓存；请先运行主 pipeline 刷新线上 GDP")
    for column in ("GDP", "PMI", "SOCIAL_FINANCE", "M2"):
        if column not in frame:
            continue
        frame[column] = frame[column].replace({0: np.nan})

    return macro_features_from_frame(frame, date_index, gdp)


def macro_features_from_frame(
    frame: pd.DataFrame,
    date_index: pd.DatetimeIndex,
    gdp: pd.Series | None = None,
) -> pd.DataFrame:
    """输入索引为可得日期；保持既有日频差分和陈旧度定义。"""
    features = pd.DataFrame(index=date_index)
    levels = ("GDP", "CPI", "PPI", "PMI", "SOCIAL_FINANCE", "M2")
    for column in levels:
        if column == "GDP" and gdp is not None:
            features[column] = gdp
            continue
        # Fill on the source calendar first: reindexing before filling would
        # discard month-end observations on weekends or before the target range.
        features[column] = frame[column].ffill().reindex(date_index, method="ffill")
    for column in ("CPI", "PPI", "PMI", "M2", "SOCIAL_FINANCE"):
        features[f"{column}_mom"] = features[column].diff(1)
        features[f"{column}_3m_chg"] = features[column].diff(3)
    features["pmi_above_50"] = (
        (features["PMI"] > 50).where(features["PMI"].notna()).astype(float)
    )
    for column in ("PMI", "M2"):
        raw = frame[column].reindex(date_index)
        features[f"{column}_staleness"] = staleness_days(raw)
    return features


def build_calendar_features(date_index: pd.DatetimeIndex) -> pd.DataFrame:
    """构建可由目标日期确定的日历和季节性特征。"""
    features = pd.DataFrame(index=date_index)
    features["day_of_week"] = date_index.dayofweek
    features["month"] = date_index.month
    features["is_month_end"] = (date_index.day >= 25).astype(int)
    features["is_quarter_end"] = (
        (date_index.month % 3 == 0) & (date_index.day >= 20)
    ).astype(int)
    features["is_year_end"] = (
        (date_index.month == 12) & (date_index.day >= 15)
    ).astype(int)

    def days_to_month_end(value: pd.Timestamp) -> int:
        return calendar.monthrange(value.year, value.month)[1] - value.day

    def days_to_quarter_end(value: pd.Timestamp) -> int:
        quarter_end_month = ((value.month - 1) // 3 + 1) * 3
        last_day = calendar.monthrange(value.year, quarter_end_month)[1]
        return (pd.Timestamp(value.year, quarter_end_month, last_day) - value).days

    date_series = date_index.to_series()
    features["days_to_month_end"] = date_series.apply(days_to_month_end).values
    features["days_to_quarter_end"] = date_series.apply(days_to_quarter_end).values
    features["is_mlf_week"] = ((date_index.day >= 13) & (date_index.day <= 17)).astype(
        int
    )
    return features


def build_proprietary_features(path: str | Path) -> pd.DataFrame:
    """构建东方财富证券公司专有流动性与两融规模特征。"""
    frame = pd.read_excel(
        path,
        sheet_name="两融规模与流动性指标",
        index_col=0,
        parse_dates=True,
    )
    frame = clean_datetime_index(frame)
    frame.columns = ["lcr", "nsfr", "funding_gap", "margin_scale"]
    frame = apply_fund_report_gap(frame, Path(path).parent)
    features = pd.DataFrame(index=frame.index)

    def rolling_percentile(series: pd.Series, window: int = 60) -> pd.Series:
        return series.rolling(window, min_periods=20).apply(
            lambda values: (values[:-1] < values[-1]).mean(),
            raw=True,
        )

    features["ef_lcr"] = frame["lcr"]
    features["ef_nsfr"] = frame["nsfr"]
    features["ef_lcr_pctile_60d"] = rolling_percentile(frame["lcr"])
    features["ef_nsfr_pctile_60d"] = rolling_percentile(frame["nsfr"])
    features["ef_funding_gap"] = frame["funding_gap"]
    margin_rolling = frame["margin_scale"].rolling(60, min_periods=20)
    features["ef_margin_zscore_60d"] = (
        frame["margin_scale"] - margin_rolling.mean()
    ) / margin_rolling.std().replace(0, np.nan)
    features["ef_lcr_chg_5d"] = frame["lcr"].diff(5)
    features["ef_funding_gap_chg_5d"] = frame["funding_gap"].diff(5)
    features["ef_funding_pressure"] = (
        features["ef_margin_zscore_60d"] - features["ef_lcr_pctile_60d"]
    )
    return features.replace([np.inf, -np.inf], np.nan)


def build_bond_issue_features(
    bond_data: pd.DataFrame,
    rating_map: Mapping[str, int],
) -> pd.DataFrame:
    """构建逐笔债券发行方案特征。"""
    features = pd.DataFrame(index=bond_data.index)
    features["tenor"] = bond_data["tenor"]
    features["has_option"] = (bond_data["has_option"] == "是").astype(int)
    features["is_subordinated"] = (bond_data["bond_type"] == "证券公司次级债").astype(
        int
    )
    features["log_issue_size"] = np.log1p(bond_data["issue_size"].clip(lower=0))
    features["rating_score"] = bond_data["rating"].map(rating_map).fillna(0)
    if "implied_rating" in bond_data.columns:
        implied = bond_data["implied_rating"].map(rating_map)
        explicit = bond_data["rating"].map(rating_map)
        features["implied_vs_explicit"] = (implied - explicit).fillna(0)
    else:
        features["implied_vs_explicit"] = 0.0
    return features


def build_peer_features(bond_data: pd.DataFrame) -> pd.DataFrame:
    """构建严格使用历史同评级、同期限、同债券类型的可比债特征。"""
    frame = bond_data.sort_values("issue_date").copy()
    features = pd.DataFrame(
        np.nan,
        index=frame.index,
        columns=["peer_spread_median", "peer_spread_std", "peer_count"],
    )
    for _, group_indices in frame.groupby(
        ["rating", "tenor", "bond_type"]
    ).groups.items():
        group = frame.loc[group_indices].sort_values("issue_date")
        dates = group["issue_date"].values.astype("datetime64[D]")
        spreads = group["spread_to_benchmark"].values
        for index, row in group.iterrows():
            evaluation_date = np.datetime64(row["issue_date"], "D")
            days = (evaluation_date - dates).astype(float)
            peers = spreads[(days > 0) & (days <= 30)]
            if len(peers) < 1:
                continue
            features.loc[index, "peer_spread_median"] = float(np.median(peers))
            features.loc[index, "peer_spread_std"] = (
                float(np.std(peers)) if len(peers) >= 2 else 0.0
            )
            features.loc[index, "peer_count"] = len(peers)
    return features


def _add_cross_asset_features(features: pd.DataFrame) -> pd.DataFrame:
    """在已拼接的市场特征上构建跨资产交互项。"""
    if {"dr007_pctile_60d", "credit_spread_pctile_60d"} <= set(features):
        features["funding_credit_stress"] = (features["dr007_pctile_60d"] - 0.5) + (
            features["credit_spread_pctile_60d"] - 0.5
        )
    if {"csi300_ret_20d", "gov_10y_chg_20d"} <= set(features):
        equity_std = (
            features["csi300_ret_20d"].expanding(min_periods=20).std().clip(lower=1e-8)
        )
        bond_std = (
            features["gov_10y_chg_20d"].expanding(min_periods=20).std().clip(lower=1e-8)
        )
        features["risk_appetite"] = (
            features["csi300_ret_20d"] / equity_std
            + features["gov_10y_chg_20d"] / bond_std
        ) / 2
    if {"supply_20d_zscore", "dr007_pctile_60d"} <= set(features):
        centered_dr007 = (features["dr007_pctile_60d"] - 0.5) * 2
        features["supply_funding_pressure"] = (
            features["supply_20d_zscore"].fillna(0) + centered_dr007.fillna(0)
        ) / 2
    return features


def combine_market_features(
    feature_frames: Iterable[pd.DataFrame],
) -> pd.DataFrame:
    """拼接标准日频特征组并加入跨资产交互项。"""
    result = pd.concat(list(feature_frames), axis=1)
    duplicate_columns = result.columns[result.columns.duplicated()].tolist()
    if duplicate_columns:
        raise ValueError(f"特征组包含重复字段: {sorted(set(duplicate_columns))}")
    result = result.replace([np.inf, -np.inf], np.nan).sort_index()
    result.index.name = "feature_date"
    return _add_cross_asset_features(result)


def _merge_market_features_asof(
    bond_data: pd.DataFrame,
    market_features: pd.DataFrame,
) -> pd.DataFrame:
    """按发行日 T-1 向后查找最新市场观测。"""
    bonds = bond_data.copy()
    bonds["feature_date"] = bonds["issue_date"] - pd.Timedelta(days=1)
    result = pd.merge_asof(
        bonds.sort_values("feature_date"),
        market_features.reset_index(),
        on="feature_date",
        direction="backward",
    )
    return result.sort_values("issue_date").reset_index(drop=True)


def _add_issuer_frequency(result: pd.DataFrame) -> None:
    result["issuer_frequency_30d"] = 0.0
    for _, group in result.groupby("issuer"):
        dates = group["issue_date"].values.astype("datetime64[D]")
        counts = np.zeros(len(dates))
        for position in range(len(dates)):
            days_since_prior = (dates[position] - dates[:position]).astype(float)
            counts[position] = (days_since_prior <= 30).sum()
        result.loc[group.index, "issuer_frequency_30d"] = counts


def _add_issue_market_interactions(result: pd.DataFrame) -> list[str]:
    """原地加入逐笔发行方案与市场状态交互特征。"""
    if {"tenor_feat", "credit_spread"} <= set(result):
        result["tenor_x_credit_spread"] = result["tenor_feat"] * result["credit_spread"]
    if {"tenor_feat", "dr007_pctile_60d"} <= set(result):
        result["tenor_x_dr007_pctile"] = (
            result["tenor_feat"] * result["dr007_pctile_60d"]
        )
    _add_issuer_frequency(result)
    candidates = (
        "tenor_x_credit_spread",
        "tenor_x_dr007_pctile",
        "issuer_frequency_30d",
    )
    return [column for column in candidates if column in result.columns]


def _funding_group(context: FeatureBuildContext) -> pd.DataFrame:
    if context.source_frames is not None:
        return funding_features_from_frame(context.source_frames["funding"])
    return build_funding_features(context.data_path)


def rate_dynamics_from_frame(frame: pd.DataFrame, *, date_index=None) -> pd.DataFrame:
    """利率预测专用增量特征；在报价日收盘可知，使用方须滞后到决策日。"""
    frame = clean_datetime_index(frame)
    levels = frame[["GOV_1Y", "GOV_3Y", "GOV_10Y", "AAA_3Y"]].replace(0, np.nan)
    # 仅完整报价日推进交易日滞后，不能把周末/空白日当成额外观测。
    levels = (
        levels.dropna(how="any") if date_index is None else levels.reindex(date_index)
    )
    features = pd.DataFrame(index=levels.index)
    for name in levels:
        series = levels[name]
        prefix = f"rate_{name.lower()}"
        features[f"{prefix}_level"] = series
        for lag in (1, 5, 20, 60):
            features[f"{prefix}_change_{lag}"] = series.diff(lag) * 100
        for window in (20, 60):
            features[f"{prefix}_deviation_{window}"] = (
                series - series.rolling(window).mean()
            ) * 100
        features[f"{prefix}_volatility_20"] = series.diff().rolling(20).std() * 100
    return features


def _rate_dynamics_group(context: FeatureBuildContext) -> pd.DataFrame:
    frame = (
        context.source_frames["funding"]
        if context.source_frames is not None
        else load_funding_frame(context.data_path)
    )
    return rate_dynamics_from_frame(frame, date_index=context.date_index)


def funding_microstructure_from_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """Research-only incremental funding/credit features; quote-time information.

    A separate registry group leaves the deployed issuance-lgb-v1 vector intact.
    Callers must lag this group together with the other market feature groups.
    """
    raw = clean_datetime_index(frame).replace(0, np.nan)
    complete = raw[["GOV_1Y", "GOV_3Y", "GOV_10Y", "AAA_3Y"]].dropna().index
    raw = raw.reindex(complete)
    output = pd.DataFrame(index=complete)
    for source, prefix in (("CDB_3Y", "micro_cdb3"), ("SHIBOR_3M", "micro_shibor3m")):
        for lag in (1, 5, 20):
            output[f"{prefix}_change_{lag}"] = raw[source].diff(lag) * 100
    output["micro_cdb3_gov3"] = (raw.CDB_3Y - raw.GOV_3Y) * 100
    output["micro_cdb10_cdb3"] = (raw.CDB_10Y - raw.CDB_3Y) * 100
    output["micro_gov10_gov3"] = (raw.GOV_10Y - raw.GOV_3Y) * 100
    output["micro_cdb3_gov3_change5"] = output.micro_cdb3_gov3.diff(5)
    output["micro_credit_change1"] = (raw.AAA_3Y - raw.GOV_3Y).diff() * 100
    return output


def _funding_microstructure_group(context: FeatureBuildContext) -> pd.DataFrame:
    raw = (
        context.source_frames["funding"]
        if context.source_frames is not None
        else load_funding_frame(context.data_path)
    )
    return funding_microstructure_from_frame(raw)


def _rate_path_group(context: FeatureBuildContext) -> pd.DataFrame:
    from .rate_path import rate_path_features

    raw = (
        context.source_frames["funding"]
        if context.source_frames is not None
        else load_funding_frame(context.data_path)
    )
    dates = context.date_index
    if dates is None:
        dates = (
            raw[["GOV_1Y", "GOV_3Y", "GOV_10Y", "AAA_3Y"]]
            .replace(0, np.nan)
            .dropna()
            .index
        )
    return rate_path_features(raw, dates)


def _equity_group(context: FeatureBuildContext) -> pd.DataFrame:
    if context.source_frames is not None:
        return build_equity_features(context.source_frames["equity"])
    return load_equity_features(context.data_path)


def _margin_equity_group(context: FeatureBuildContext) -> pd.DataFrame:
    return load_margin_equity_features(context.data_path)


def _secondary_bond_group(context: FeatureBuildContext) -> pd.DataFrame:
    if context.source_frames is not None and "secondary" in context.source_frames:
        return secondary_features_from_frame(context.source_frames["secondary"])
    return build_secondary_bond_features(context.data_path)


def _primary_bond_group(context: FeatureBuildContext) -> pd.DataFrame:
    if context.source_frames is not None:
        return primary_features_from_frame(context.source_frames["primary"])
    if context.primary_data_path is None:
        raise ValueError("债券一级特征组需要 primary_data_path。")
    return build_primary_bond_features(context.primary_data_path)


def _macro_group(context: FeatureBuildContext) -> pd.DataFrame:
    if context.date_index is None:
        raise ValueError("宏观特征组需要 date_index。")
    if context.source_frames is not None:
        return macro_features_from_frame(
            context.source_frames["macro"], context.date_index
        )
    return build_macro_features(context.data_path, context.date_index)


def _calendar_group(context: FeatureBuildContext) -> pd.DataFrame:
    if context.date_index is None:
        raise ValueError("日历特征组需要 date_index。")
    return build_calendar_features(context.date_index)


def _macro_release_group(context: FeatureBuildContext) -> pd.DataFrame:
    from .macro_releases import macro_release_features

    if context.source_frames is None or "macro_releases" not in context.source_frames:
        raise ValueError("宏观发布特征需要带观测期和发布日期的原始记录。")
    return macro_release_features(
        context.source_frames["macro_releases"], context.date_index
    )


def _proprietary_group(context: FeatureBuildContext) -> pd.DataFrame:
    if context.business_data_path is None:
        raise ValueError("公司专有特征组需要 business_data_path。")
    return build_proprietary_features(context.business_data_path)


def _issuer_spread_group(context: FeatureBuildContext) -> pd.DataFrame:
    if context.source_frames is None or "issuer_spread" not in context.source_frames:
        raise ValueError("issuer spread requires complete dated observations")
    source = clean_datetime_index(context.source_frames["issuer_spread"])
    frame = source[["issuer_spread_bp"]].copy()
    for lag in (1, 5, 20):
        frame[f"issuer_spread_change_{lag}"] = frame.issuer_spread_bp.diff(lag)
    return frame


def _industry_curve_dynamics_group(context: FeatureBuildContext) -> pd.DataFrame:
    from .issuance_curve_dynamics import curve_dynamics_frame

    return curve_dynamics_frame(
        context.source_frames["industry_nodes"], context.date_index
    )


def _coupon_quote_history_group(context: FeatureBuildContext) -> pd.DataFrame:
    from .coupon_quotes import raw_quote_frame

    return raw_quote_frame(context.source_frames["industry_nodes"], context.date_index)


def _coupon_raw_nodes_group(context: FeatureBuildContext) -> pd.DataFrame:
    from .coupon_raw_nodes import raw_node_history

    return raw_node_history(
        context.source_frames["industry_nodes"],
        context.source_frames["raw_node_funding"],
        context.date_index,
    )


FEATURE_GROUP_REGISTRY: Mapping[str, FeatureGroupSpec] = {
    spec.name: spec
    for spec in (
        FeatureGroupSpec("funding", "market", _funding_group),
        FeatureGroupSpec("rate_dynamics", "bond_market", _rate_dynamics_group),
        FeatureGroupSpec(
            "coupon_quote_history",
            "bond_market",
            _coupon_quote_history_group,
            requires_date_index=True,
        ),
        FeatureGroupSpec(
            "coupon_raw_nodes",
            "bond_market",
            _coupon_raw_nodes_group,
            requires_date_index=True,
        ),
        FeatureGroupSpec(
            "industry_curve_dynamics",
            "bond_market",
            _industry_curve_dynamics_group,
            requires_date_index=True,
        ),
        FeatureGroupSpec(
            "funding_microstructure", "bond_market", _funding_microstructure_group
        ),
        FeatureGroupSpec("rate_path", "bond_market", _rate_path_group),
        FeatureGroupSpec("equity", "market", _equity_group),
        FeatureGroupSpec("margin_equity", "market", _margin_equity_group),
        FeatureGroupSpec(
            "secondary_bond",
            "bond_market",
            _secondary_bond_group,
        ),
        FeatureGroupSpec("primary_bond", "bond_market", _primary_bond_group),
        FeatureGroupSpec("issuer_spread", "bond_market", _issuer_spread_group),
        FeatureGroupSpec("macro", "market", _macro_group, requires_date_index=True),
        FeatureGroupSpec(
            "macro_releases", "market", _macro_release_group, requires_date_index=True
        ),
        FeatureGroupSpec(
            "calendar",
            "calendar",
            _calendar_group,
            requires_date_index=True,
        ),
        FeatureGroupSpec("proprietary", "company", _proprietary_group),
    )
}

BOND_MARKET_FEATURE_GROUPS = (
    "funding",
    "equity",
    "secondary_bond",
    "primary_bond",
    "macro",
    "calendar",
)
MARGIN_MARKET_FEATURE_GROUPS = (
    "funding",
    "equity",
    "margin_equity",
    "macro",
    "calendar",
)
MARGIN_BASE_SOURCE_GROUPS = ("funding", "equity", "calendar")
MARGIN_OPTIONAL_SOURCE_GROUPS = ("macro", "margin_equity")


def _validate_feature_frame(group_name: str, frame: pd.DataFrame) -> pd.DataFrame:
    if not isinstance(frame.index, pd.DatetimeIndex):
        raise ValueError(f"特征组 {group_name} 必须使用 DatetimeIndex。")
    if frame.index.has_duplicates or not frame.index.is_monotonic_increasing:
        raise ValueError(f"特征组 {group_name} 的日期必须唯一且升序。")
    non_numeric = [
        column
        for column in frame.columns
        if not pd.api.types.is_numeric_dtype(frame[column])
    ]
    if non_numeric:
        raise ValueError(f"特征组 {group_name} 包含非数值字段: {non_numeric}")
    return frame.replace([np.inf, -np.inf], np.nan)


def _resolve_feature_specs(
    group_names: Iterable[str],
) -> tuple[tuple[str, ...], dict[str, FeatureGroupSpec]]:
    names = tuple(group_names)
    if not names:
        raise ValueError("至少需要一个特征组。")
    unknown = set(names) - set(FEATURE_GROUP_REGISTRY)
    if unknown:
        raise ValueError(f"未知特征组: {sorted(unknown)}")
    if len(names) != len(set(names)):
        raise ValueError("特征组名称不得重复。")
    return names, {name: FEATURE_GROUP_REGISTRY[name] for name in names}


def _build_independent_feature_groups(
    specs: Mapping[str, FeatureGroupSpec],
    context: FeatureBuildContext,
) -> dict[str, pd.DataFrame]:
    return {
        name: _validate_feature_frame(name, spec.builder(context))
        for name, spec in specs.items()
        if not spec.requires_date_index
    }


def _resolve_indexed_context(
    context: FeatureBuildContext,
    specs: Mapping[str, FeatureGroupSpec],
    frames: Mapping[str, pd.DataFrame],
    anchor_group: str,
) -> FeatureBuildContext:
    needs_index = any(spec.requires_date_index for spec in specs.values())
    if not needs_index or context.date_index is not None:
        return context
    if anchor_group not in frames:
        raise ValueError(f"缺少日频锚点特征组: {anchor_group}")
    return FeatureBuildContext(
        data_path=context.data_path,
        primary_data_path=context.primary_data_path,
        business_data_path=context.business_data_path,
        date_index=frames[anchor_group].index,
        source_frames=context.source_frames,
    )


def build_feature_bundle(
    group_names: Iterable[str],
    context: FeatureBuildContext,
    *,
    anchor_group: str = "funding",
) -> FeatureBundle:
    """按注册表构建指定特征组，并以锚点组日期生成宏观/日历特征。"""
    names, specs = _resolve_feature_specs(group_names)
    frames = _build_independent_feature_groups(specs, context)
    indexed_context = _resolve_indexed_context(
        context,
        specs,
        frames,
        anchor_group,
    )
    for name, spec in specs.items():
        if spec.requires_date_index:
            frames[name] = _validate_feature_frame(
                name,
                spec.builder(indexed_context),
            )

    ordered_frames = {name: frames[name] for name in names}
    combined = combine_market_features(ordered_frames.values())
    return FeatureBundle(
        frames=ordered_frames,
        specs=specs,
        combined=combined,
        feature_names=tuple(combined.columns),
    )


__all__ = [
    "BOND_MARKET_FEATURE_GROUPS",
    "FEATURE_GROUP_REGISTRY",
    "MARGIN_BASE_SOURCE_GROUPS",
    "MARGIN_MARKET_FEATURE_GROUPS",
    "MARGIN_OPTIONAL_SOURCE_GROUPS",
    "FeatureBuildContext",
    "FeatureBundle",
    "FeatureGroupSpec",
    "build_bond_issue_features",
    "build_calendar_features",
    "build_feature_bundle",
    "build_funding_features",
    "build_macro_features",
    "build_peer_features",
    "build_primary_bond_features",
    "build_proprietary_features",
    "build_secondary_bond_features",
    "clean_datetime_index",
    "combine_market_features",
    "staleness_days",
]
