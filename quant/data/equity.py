"""权益工作表的标准化读取与公共特征工程接口。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

import numpy as np
import pandas as pd

EQUITY_SHEET = "权益数据"


@dataclass(frozen=True)
class EquityFieldSpec:
    """Choice 权益字段到模型标准字段的映射。"""

    name: str
    instrument_code: str
    instrument_name: str
    metrics: tuple[str, ...]


EQUITY_FIELD_SPECS = (
    EquityFieldSpec("sse_close", "000001.SH", "上证指数", ("收盘价",)),
    EquityFieldSpec("szse_close", "399001.SZ", "深证成指", ("收盘价",)),
    EquityFieldSpec("csi300_close", "000300.SH", "沪深300", ("收盘价",)),
    EquityFieldSpec("csi1000_close", "000852.SH", "中证1000", ("收盘价",)),
    EquityFieldSpec("chinext_close", "399006.SZ", "创业板指", ("收盘价",)),
    EquityFieldSpec("star50_close", "000688.SH", "科创50", ("收盘价",)),
    EquityFieldSpec("all_a_close", "800004.EI", "东方财富全A(沪深京)", ("收盘价",)),
    EquityFieldSpec("vix_close", "VIX.GI", "恐慌指数", ("收盘价",)),
    EquityFieldSpec(
        "all_a_market_cap",
        "800004.EI",
        "东方财富全A(沪深京)",
        ("总市值",),
    ),
    EquityFieldSpec(
        "all_a_pe_ttm",
        "800004.EI",
        "东方财富全A(沪深京)",
        ("市盈率PE(TTM)|【剔除规则】不调整",),
    ),
    EquityFieldSpec(
        "equity_bond_spread",
        "800004.EI",
        "东方财富全A(沪深京)",
        ("股债性价比(差值)|【股票预期收益率】1/市盈率(%)",),
    ),
    EquityFieldSpec(
        "all_a_turnover_amount",
        "800004.EI",
        "东方财富全A(沪深京)",
        ("成交金额",),
    ),
    EquityFieldSpec(
        "all_a_turnover_rate",
        "800004.EI",
        "东方财富全A(沪深京)",
        ("换手率",),
    ),
)

_PRICE_FIELDS = tuple(
    spec.name for spec in EQUITY_FIELD_SPECS if spec.metrics == ("收盘价",)
)
_KNOWN_METRICS = frozenset(
    metric for spec in EQUITY_FIELD_SPECS for metric in spec.metrics
)
MARGIN_EQUITY_FEATURES = (
    "all_a_ret_5d",
    "all_a_ret_20d",
    "all_a_ma60_dev",
    "all_a_drawdown_20d",
    "all_a_downside_vol_20d",
    "all_a_turnover_log_z_60d",
    "growth_proxy_ret_5d",
    "growth_proxy_ret_20d",
)


def _cell_text(value: object) -> str:
    if pd.isna(value):
        return ""
    return str(value).strip()


def _find_metric_header_row(raw: pd.DataFrame) -> int:
    candidate_rows = min(12, len(raw))
    scores = [
        sum(_cell_text(value) in _KNOWN_METRICS for value in raw.iloc[row])
        for row in range(candidate_rows)
    ]
    metric_row = int(np.argmax(scores))
    if scores[metric_row] < 2:
        raise ValueError("权益数据工作表未找到可识别的 Choice 指标表头。")
    return metric_row


def _is_date_value(value: object) -> bool:
    if isinstance(value, (pd.Timestamp, datetime, date)):
        return True
    if not isinstance(value, str):
        return False
    parsed = pd.to_datetime(value.strip(), errors="coerce")
    return pd.notna(parsed)


def _find_date_columns(raw: pd.DataFrame, metric_row: int) -> list[int]:
    date_columns = []
    data = raw.iloc[metric_row + 1 :]
    for column in raw.columns:
        header_is_blank = all(
            not _cell_text(raw.iat[row, column])
            for row in range(max(0, metric_row - 2), metric_row + 1)
        )
        values = data.iloc[:, column].dropna()
        if not header_is_blank or values.empty:
            continue
        sample = values.iloc[: min(100, len(values))]
        if sample.map(_is_date_value).mean() >= 0.8:
            date_columns.append(int(column))
    if not date_columns:
        raise ValueError("权益数据工作表未找到日期列。")
    return date_columns


def _match_field_column(
    raw: pd.DataFrame,
    metric_row: int,
    spec: EquityFieldSpec,
) -> tuple[int, str] | None:
    code_row = metric_row - 2
    name_row = metric_row - 1
    for column in raw.columns:
        metric = _cell_text(raw.iat[metric_row, column])
        code = _cell_text(raw.iat[code_row, column]) if code_row >= 0 else ""
        name = _cell_text(raw.iat[name_row, column]) if name_row >= 0 else ""
        if metric not in spec.metrics:
            continue
        if code == spec.instrument_code or name == spec.instrument_name:
            return int(column), metric
    return None


def _date_column_for_field(field_column: int, date_columns: list[int]) -> int:
    preceding = [column for column in date_columns if column < field_column]
    if not preceding:
        raise ValueError(f"权益数据第 {field_column + 1} 列之前没有对应日期列。")
    return preceding[-1]


def _extract_field(
    raw: pd.DataFrame,
    metric_row: int,
    date_column: int,
    field_column: int,
    field_name: str,
) -> pd.DataFrame:
    result = pd.DataFrame(
        {
            "date": pd.to_datetime(
                raw.iloc[metric_row + 1 :, date_column],
                errors="coerce",
            ),
            field_name: pd.to_numeric(
                raw.iloc[metric_row + 1 :, field_column],
                errors="coerce",
            ),
        }
    )
    return result.dropna(subset=["date"]).drop_duplicates("date", keep="last")


def load_equity_market_data(path: str | Path) -> pd.DataFrame:
    """读取新版多区块权益工作表并返回统一字段、统一日期索引的日频数据。"""
    raw = pd.read_excel(path, sheet_name=EQUITY_SHEET, header=None)
    metric_row = _find_metric_header_row(raw)
    date_columns = _find_date_columns(raw, metric_row)

    field_matches = {
        spec.name: _match_field_column(raw, metric_row, spec)
        for spec in EQUITY_FIELD_SPECS
    }
    missing = [name for name, match in field_matches.items() if match is None]
    if missing:
        raise ValueError(f"权益数据工作表缺少标准字段: {missing}")

    result: pd.DataFrame | None = None
    source_metrics = {}
    for spec in EQUITY_FIELD_SPECS:
        field_match = field_matches[spec.name]
        assert field_match is not None
        field_column, source_metric = field_match
        source_metrics[spec.name] = source_metric
        date_column = _date_column_for_field(field_column, date_columns)
        field = _extract_field(
            raw,
            metric_row,
            date_column,
            field_column,
            spec.name,
        )
        result = (
            field if result is None else result.merge(field, on="date", how="outer")
        )

    if result is None:
        raise ValueError("权益数据工作表没有可用字段。")
    result = result.sort_values("date").drop_duplicates("date", keep="last")
    result = result.set_index("date")
    result.index.name = "date"
    result[list(_PRICE_FIELDS)] = result[list(_PRICE_FIELDS)].replace(0, np.nan)
    result = result.dropna(subset=["csi300_close"])
    if result.empty:
        raise ValueError("权益数据工作表没有可用的沪深300交易日数据。")
    result.attrs["source_metrics"] = source_metrics
    result.attrs["equity_bond_caliber"] = "spread"
    return result


def _last_value_percentile(values: pd.Series) -> float:
    current = values.iloc[-1]
    if pd.isna(current):
        return float("nan")
    valid = values.dropna()
    return float((valid <= current).mean())


def build_equity_features(equity: pd.DataFrame) -> pd.DataFrame:
    """从标准权益日频数据构建供债券与两融模型共用的稳定特征集。"""
    required = {
        "csi300_close",
        "all_a_turnover_rate",
        "equity_bond_spread",
        "vix_close",
    }
    missing = required - set(equity.columns)
    if missing:
        raise ValueError(f"标准权益数据缺少特征源字段: {sorted(missing)}")

    equity = equity.sort_index()
    csi300 = equity["csi300_close"]
    features = pd.DataFrame(index=equity.index)
    features["csi300_ret_5d"] = csi300.pct_change(5, fill_method=None)
    features["csi300_ret_20d"] = csi300.pct_change(20, fill_method=None)
    features["csi300_ret_60d"] = csi300.pct_change(60, fill_method=None)
    features["csi300_vol_20d"] = csi300.pct_change(fill_method=None).rolling(20).std()
    features["turnover_rate"] = equity["all_a_turnover_rate"]
    features["equity_bond_spread"] = equity["equity_bond_spread"]

    vix = equity["vix_close"]
    features["vix"] = vix
    features["vix_chg_5d"] = vix.diff(5)
    features["vix_pctile_60d"] = vix.rolling(60, min_periods=20).apply(
        _last_value_percentile
    )
    features.attrs.update(equity.attrs)
    return features


def build_margin_equity_features(equity: pd.DataFrame) -> pd.DataFrame:
    """构建只供全市场两融显式扩展使用的权益行为特征。"""
    required = {
        "all_a_close",
        "all_a_turnover_amount",
        "csi1000_close",
        "chinext_close",
        "star50_close",
    }
    missing = required - set(equity.columns)
    if missing:
        raise ValueError(f"标准权益数据缺少两融扩展特征源: {sorted(missing)}")

    equity = equity.sort_index()
    all_a = equity["all_a_close"].astype(float)
    all_a_daily_return = all_a.pct_change(fill_method=None)
    features = pd.DataFrame(index=equity.index)
    features["all_a_ret_5d"] = all_a.pct_change(5, fill_method=None)
    features["all_a_ret_20d"] = all_a.pct_change(20, fill_method=None)
    features["all_a_ma60_dev"] = all_a / all_a.rolling(60).mean() - 1
    features["all_a_drawdown_20d"] = all_a / all_a.rolling(20).max() - 1
    features["all_a_downside_vol_20d"] = np.sqrt(
        all_a_daily_return.clip(upper=0).pow(2).rolling(20, min_periods=10).mean()
    )

    log_turnover = np.log1p(equity["all_a_turnover_amount"].astype(float).clip(lower=0))
    turnover_rolling = log_turnover.rolling(60, min_periods=20)
    features["all_a_turnover_log_z_60d"] = (
        log_turnover - turnover_rolling.mean()
    ) / turnover_rolling.std().replace(0, np.nan)

    growth_prices = equity[["csi1000_close", "chinext_close", "star50_close"]].astype(
        float
    )
    features["growth_proxy_ret_5d"] = growth_prices.pct_change(
        5, fill_method=None
    ).mean(axis=1)
    features["growth_proxy_ret_20d"] = growth_prices.pct_change(
        20, fill_method=None
    ).mean(axis=1)
    features.attrs.update(equity.attrs)
    return features.loc[:, MARGIN_EQUITY_FEATURES]


def load_equity_features(path: str | Path) -> pd.DataFrame:
    """从工作簿直接加载标准权益特征。"""
    return build_equity_features(load_equity_market_data(path))


def load_margin_equity_features(path: str | Path) -> pd.DataFrame:
    """从工作簿加载两融专用、默认关闭的权益行为特征。"""
    return build_margin_equity_features(load_equity_market_data(path))


__all__ = [
    "EQUITY_FIELD_SPECS",
    "EQUITY_SHEET",
    "EquityFieldSpec",
    "MARGIN_EQUITY_FEATURES",
    "build_equity_features",
    "build_margin_equity_features",
    "load_equity_features",
    "load_equity_market_data",
    "load_margin_equity_features",
]
