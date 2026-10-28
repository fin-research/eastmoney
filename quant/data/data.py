"""债券逐笔数据与标准特征工程兼容入口。"""

from pathlib import Path

import numpy as np
import pandas as pd

from . import feature_engineering as _standard_features
from .feature_engineering import (
    _add_issue_market_interactions,
    _merge_market_features_asof,
    build_bond_issue_features,
    build_calendar_features,
    build_funding_features,
    build_macro_features,
    build_peer_features,
    build_primary_bond_features,
    build_proprietary_features,
    build_secondary_bond_features,
    clean_datetime_index,
    combine_market_features,
    staleness_days,
)
from .equity import load_equity_features

DATA_DIR = Path(__file__).parent
DATA_FILE = DATA_DIR / "data.xlsx"
SUBJECT_SPREAD_FILE = DATA_DIR / "主体利差.xlsx"
BUSINESS_DATA_FILE = DATA_DIR / "业务数据.xlsx"

RATING_MAP = {"AAA": 5, "AA+": 4, "AA": 3, "AA-": 2, "A+": 1}

# 保留已被仓库内测试和排障脚本使用的私有别名；实现统一位于 feature_engineering。
_combine_market_features = combine_market_features
_add_cross_asset_features = _standard_features._add_cross_asset_features
_last_value_empirical_percentile = _standard_features._last_value_empirical_percentile


def compute_peer_stats(
    bond_data: pd.DataFrame,
    eval_date: pd.Timestamp,
    tenor: float,
    rating: str,
    bond_type: str = "证券公司债",
) -> dict | None:
    """计算指定日期前 30 日的同评级、同期限、同债券类型利差统计。"""
    mask = (
        (bond_data["rating"] == rating)
        & (bond_data["tenor"] == tenor)
        & (bond_data["bond_type"] == bond_type)
        & (bond_data["issue_date"] < eval_date)
        & ((eval_date - bond_data["issue_date"]).dt.days <= 30)
    )
    peers = bond_data.loc[mask, "spread_to_benchmark"]
    if len(peers) < 1:
        return None
    return {
        "median": float(peers.median()),
        "std": float(peers.std()) if len(peers) >= 2 else 0.0,
        "count": len(peers),
    }


def load_subject_spread_features() -> pd.DataFrame:
    """读取公司主体利差序列，供今日公司业务指标分析使用。"""
    frame = pd.read_excel(SUBJECT_SPREAD_FILE, sheet_name="利差分析")
    required = {"交易日期", "主体利差(BP)"}
    missing = required - set(frame.columns)
    if missing:
        raise ValueError(f"主体利差表缺少字段: {', '.join(sorted(missing))}")

    result = pd.DataFrame(
        {
            "date": pd.to_datetime(frame["交易日期"], errors="coerce"),
            "ef_subject_spread_bp": pd.to_numeric(
                frame["主体利差(BP)"],
                errors="coerce",
            ),
        }
    ).dropna(subset=["date", "ef_subject_spread_bp"])
    result = result.sort_values("date").drop_duplicates("date", keep="last")
    result = result.set_index("date")
    result.index.name = None
    return result


def _print_feature_missingness(
    result: pd.DataFrame,
    feature_names: list[str],
) -> None:
    missing_rate = result[feature_names].isnull().mean()
    high_missing = missing_rate[missing_rate > 0.1]
    print("[INFO] 缺失率 > 10% 的特征:")
    if high_missing.empty:
        print("       无")
        return
    for column, rate in high_missing.items():
        print(f"       {column}: {rate:.1%}")


class BondDataBuilder:
    """构建交易所债券逐笔训练数据与标签。"""

    def bond_data(self, *, require_spread: bool = True) -> pd.DataFrame:
        from data.choice_bond_data import ISSUE_DETAIL_FILE

        frame = pd.read_excel(
            ISSUE_DETAIL_FILE,
            sheet_name="债券发行明细",
            header=0,
            parse_dates=["发行日期"],
        ).rename(
            columns={
                "发行日期": "issue_date",
                "代码": "bond_code",
                "发行人名称": "issuer",
                "主体评级": "rating",
                "发行期限(年)": "tenor",
                "票面利率(发行参考)(%)": "coupon",
                "发行总额(亿)": "issue_size",
                "债券类型": "bond_type",
                "是否含权": "has_option",
                "发行利差": "spread_to_benchmark",
                "中债-票面(BP)": "valuation_deviation",
                "中债隐含评级": "implied_rating",
            }
        )
        frame = frame[
            pd.to_datetime(frame["issue_date"], errors="coerce").notna()
        ].copy()
        frame = frame[frame["bond_type"].isin(["证券公司债", "证券公司次级债"])].copy()
        numeric_columns = (
            "tenor",
            "coupon",
            "issue_size",
            "spread_to_benchmark",
            "valuation_deviation",
        )
        for column in numeric_columns:
            if column in frame.columns:
                frame[column] = pd.to_numeric(frame[column], errors="coerce")
        frame["issue_date"] = pd.to_datetime(frame["issue_date"])
        required = [
            "issue_date",
            "rating",
            "tenor",
            "coupon",
            "issue_size",
        ]
        if require_spread:
            required.append("spread_to_benchmark")
        return frame.dropna(subset=required)

    def build_label(self, frame: pd.DataFrame) -> pd.DataFrame:
        """构建相对同类近 30 日可比债中位数的发行利差标签。"""
        frame = frame.sort_values("issue_date").copy()
        frame["y_regression"] = np.nan
        frame["y_classification"] = np.nan
        for index, row in frame.iterrows():
            mask = (
                (frame["rating"] == row["rating"])
                & (frame["tenor"] == row["tenor"])
                & (frame["bond_type"] == row["bond_type"])
                & (frame["issue_date"] < row["issue_date"])
                & ((row["issue_date"] - frame["issue_date"]).dt.days <= 30)
            )
            peers = frame.loc[mask, "spread_to_benchmark"]
            if len(peers) < 3:
                continue
            median_spread = peers.median()
            frame.loc[index, "y_regression"] = (
                row["spread_to_benchmark"] - median_spread
            )
            frame.loc[index, "y_classification"] = int(
                row["spread_to_benchmark"] < median_spread
            )
        frame = frame.dropna(subset=["y_regression"])
        print(f"[INFO] 有效标签样本数: {len(frame)}")
        print(f"[INFO] 择时成功率(基准): {frame['y_classification'].mean():.1%}")
        return frame


class FeatureEngineer:
    """标准特征函数的兼容门面，并负责逐笔债券 T-1 合并。"""

    def __init__(self) -> None:
        self.feature_names: list[str] = []

    _clean_index = staticmethod(clean_datetime_index)
    _staleness_days = staticmethod(staleness_days)

    def build_funding_features(self) -> pd.DataFrame:
        return build_funding_features(DATA_FILE)

    def build_equity_features(self) -> pd.DataFrame:
        return load_equity_features(DATA_FILE)

    def build_secondary_features(self) -> pd.DataFrame:
        return build_secondary_bond_features(DATA_FILE)

    def build_primary_features(self) -> pd.DataFrame:
        from data.choice_bond_data import ISSUE_STATISTICS_FILE

        return build_primary_bond_features(ISSUE_STATISTICS_FILE)

    def build_macro_features(self, index: pd.DatetimeIndex) -> pd.DataFrame:
        return build_macro_features(DATA_FILE, index)

    def build_calendar_features(
        self,
        date_index: pd.DatetimeIndex,
    ) -> pd.DataFrame:
        return build_calendar_features(date_index)

    def build_proprietary_features(self) -> pd.DataFrame:
        return build_proprietary_features(BUSINESS_DATA_FILE)

    @staticmethod
    def build_bond_features(bond_data: pd.DataFrame) -> pd.DataFrame:
        return build_bond_issue_features(bond_data, RATING_MAP)

    build_peer_features = staticmethod(build_peer_features)

    def merge_all_features(
        self,
        bond_data: pd.DataFrame,
        funding_features: pd.DataFrame,
        equity_features: pd.DataFrame,
        credit_features: pd.DataFrame,
        supply_features: pd.DataFrame,
        macro_features: pd.DataFrame,
        calendar_features: pd.DataFrame,
    ) -> pd.DataFrame:
        """将标准特征组按 T-1 合并到逐笔债券数据。"""
        all_market_features = combine_market_features(
            [
                funding_features,
                equity_features,
                credit_features,
                supply_features,
                macro_features,
                calendar_features,
            ]
        )
        result = _merge_market_features_asof(bond_data, all_market_features)

        bond_features = self.build_bond_features(result)
        for column in bond_features.columns:
            result[f"{column}_feat"] = bond_features[column].values

        print("[INFO] 构建可比债近期利差特征...")
        peer_features = self.build_peer_features(result)
        for column in peer_features.columns:
            result[column] = peer_features[column].values

        interaction_columns = _add_issue_market_interactions(result)
        self.feature_names = (
            all_market_features.columns.tolist()
            + [f"{column}_feat" for column in bond_features.columns]
            + peer_features.columns.tolist()
            + interaction_columns
        )
        self.all_market_features_ = all_market_features
        print(f"[INFO] 特征维度: {len(self.feature_names)}")
        print(f"[INFO] 合并后样本量: {len(result)}")
        _print_feature_missingness(result, self.feature_names)
        return result


__all__ = [
    "BUSINESS_DATA_FILE",
    "DATA_DIR",
    "DATA_FILE",
    "RATING_MAP",
    "SUBJECT_SPREAD_FILE",
    "BondDataBuilder",
    "FeatureEngineer",
    "compute_peer_stats",
    "load_subject_spread_features",
]
