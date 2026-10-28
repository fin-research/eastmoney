"""可追溯的日频利率变化标签；决策日开盘仅使用此前报价。"""

from dataclasses import dataclass
from pathlib import Path
from collections.abc import Mapping

import numpy as np
import pandas as pd

from .feature_engineering import (
    FeatureBuildContext,
    build_feature_bundle,
    combine_market_features,
    load_funding_frame,
)


@dataclass(frozen=True)
class RateDataset:
    features: pd.DataFrame
    levels_bp: pd.DataFrame
    source_dates: pd.Series
    audit: dict
    market_features: pd.DataFrame | None = None


def build_rate_dataset(
    path: Path,
    *,
    funding_frame: pd.DataFrame | None = None,
    extra_groups: tuple[str, ...] = (),
    source_frames: Mapping[str, pd.DataFrame] | None = None,
    require_credit_quote: bool = True,
) -> RateDataset:
    raw = load_funding_frame(path) if funding_frame is None else funding_frame
    raw = raw.copy()
    raw.index = pd.to_datetime(raw.index)
    if raw.index.has_duplicates or raw.index.hasnans:
        raise ValueError("funding quote dates must be unique and nonmissing")
    raw = raw.sort_index()
    rate_columns = ["GOV_1Y", "GOV_3Y", "GOV_10Y", "AAA_3Y"]
    required = rate_columns if require_credit_quote else rate_columns[:3]
    rates = raw[rate_columns].replace(0, np.nan).dropna(subset=required)
    bundle = build_feature_bundle(
        ("funding", "rate_dynamics", "calendar", *extra_groups),
        FeatureBuildContext(
            data_path=path,
            source_frames={"funding": raw, **(source_frames or {})},
            date_index=rates.index if not require_credit_quote else None,
        ),
    )
    # 移位后索引是决策日；X_t = 市场报价日严格早于 t 的最新特征。
    aligned = {}
    for name, frame in bundle.frames.items():
        if name == "secondary_bond":
            # An old trade tape is not a current quote. Keep at most three days.
            aligned[name] = frame.reindex(
                rates.index, method="ffill", tolerance=pd.Timedelta(days=3)
            )
        else:
            aligned[name] = frame.reindex(rates.index)
    market_features = combine_market_features(aligned.values())
    features = market_features.shift(1)
    features["decision_weekday"] = rates.index.dayofweek
    features["decision_month_end"] = rates.index.days_in_month - rates.index.day
    levels = rates[["GOV_3Y", "AAA_3Y"]].mul(100)
    levels["CREDIT_3Y"] = levels["AAA_3Y"] - levels["GOV_3Y"]
    source_dates = pd.Series(rates.index, index=rates.index).shift(1)
    audit = {
        "source": str(path),
        "source_start": str(rates.index.min().date()),
        "source_end": str(rates.index.max().date()),
        "raw_latest_date": str(raw.index.max().date()),
        "complete_quote_days": len(rates),
        "required_quote_columns": required,
        "incomplete_quote_days": int(len(raw) - len(rates)),
        "target_units": "bp; yield percent = level_bp / 100",
        "information_set": "strictly before decision date; previous complete quote",
        "proxy_limit": "AAA enterprise 3Y secondary yield is not issuer primary coupon",
        "calendar": "historical observed quote dates; no synthetic weekend quotes",
        "feature_groups": list(bundle.frames),
    }
    return RateDataset(features, levels, source_dates, audit, market_features)


def horizon_labels(
    data: RateDataset, target: str, horizon: int, *, max_horizon: int = 30
) -> pd.DataFrame:
    """预测从 T-1 报价到 T+h 内最后报价日的变化；h 是自然日。"""
    if (
        isinstance(horizon, bool)
        or not isinstance(horizon, int)
        or not 1 <= max_horizon <= 90
        or not 0 <= horizon <= max_horizon
    ):
        raise ValueError(
            f"horizon must be an integer from 0 to {max_horizon} calendar days"
        )
    levels = data.levels_bp[target]
    dates = levels.index
    deadlines = dates + pd.Timedelta(days=horizon)
    positions = dates.searchsorted(deadlines, side="right") - 1
    endpoints = dates.take(positions)
    label = pd.DataFrame(
        {
            "source_date": data.source_dates,
            "label_end": endpoints,
            "deadline": deadlines,
            "current_bp": levels.shift(1),
            "target_bp": levels.to_numpy()[positions],
            "quote_age_at_deadline_days": (deadlines - endpoints).days,
        },
        index=dates,
    )
    label["change_bp"] = label["target_bp"] - label["current_bp"]
    # 数据尾部未知的窗口不能退化为最后观测；历史长假取窗口内最后报价，
    # 保留报价年龄，不能因假期长而删除整段起点、选择性避开节假日行情。
    valid = deadlines <= dates.max()
    return label.loc[valid].dropna()


def purged_training_index(labels: pd.DataFrame, cutoff: pd.Timestamp) -> pd.Index:
    """训练标签必须在测试首日开盘前全部揭晓，而非仅训练行日期早于测试。"""
    return labels.index[
        (labels.index < cutoff)
        & (labels["label_end"] < cutoff)
        & (labels["deadline"] < cutoff)
    ]


def calendar_training_data(data: RateDataset, horizon: int):
    """Exact natural-day decisions, including weekends; no forward-filled targets.

    Information at any origin is the last complete quote strictly before it.
    A target is the last quote at or before its deadline, and is mature only
    after the entire deadline has passed. Future appended quotes cannot alter
    a label admitted to a past training fold.
    """
    if not 0 <= horizon <= 30:
        raise ValueError("calendar horizon must be in 0..30")
    quotes = data.levels_bp.index
    origins = pd.date_range(quotes[1], quotes[-1] - pd.Timedelta(days=horizon))
    deadlines = origins + pd.Timedelta(days=horizon)
    sources = quotes.searchsorted(origins, side="left") - 1
    targets = quotes.searchsorted(deadlines, side="right") - 1
    features = data.market_features.iloc[sources].copy()
    features.index = origins
    features["decision_weekday"] = origins.dayofweek
    features["decision_month_end"] = origins.days_in_month - origins.day
    levels = data.levels_bp.AAA_3Y.to_numpy()
    labels = pd.DataFrame(
        {
            "source_date": quotes.take(sources),
            "label_end": quotes.take(targets),
            "deadline": deadlines,
            "change_bp": levels[targets] - levels[sources],
        },
        index=origins,
    )
    return features, labels
