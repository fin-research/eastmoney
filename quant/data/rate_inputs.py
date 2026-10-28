"""仅向本地已验证历史尾部追加同口径线上观测，不重写工作簿。"""

import json
from pathlib import Path

import numpy as np
import pandas as pd

from .feature_engineering import load_funding_frame
from .online_inputs import source_frame
from .issuance_calendar import IssuanceCalendar


RATE_COLUMNS = ("GOV_1Y", "GOV_3Y", "GOV_10Y", "AAA_3Y")


def financing_rate_inputs(
    path: Path, as_of: pd.Timestamp, online_snapshot: Path | None = None
):
    local = load_funding_frame(path).loc[lambda frame: frame.index < as_of]
    complete = local[list(RATE_COLUMNS)].replace(0, np.nan).dropna()
    if complete.empty:
        raise ValueError("no complete local interest-rate history")
    audit = {
        "local_last_complete_quote": str(complete.index[-1].date()),
        "appended_dates": [],
    }
    if online_snapshot is None:
        return local, audit
    payload = json.loads(online_snapshot.read_text())
    if payload["as_of_date"] != str(as_of.date()):
        raise ValueError("online snapshot as-of date differs from forecast date")
    rows = payload["datasets"]["funding"]
    if any(
        pd.Timestamp(max(row["observation_date"], row.get("published_date") or ""))
        >= as_of
        for row in rows
    ):
        raise ValueError(
            "online snapshot contains observations not available before as-of"
        )
    online = source_frame("funding", rows)
    overlap = complete.index.intersection(online.index)[-60:]
    if len(overlap) < 10:
        raise ValueError("insufficient source overlap to join local and online quotes")
    differences = (
        complete.loc[overlap] - online.loc[overlap, list(RATE_COLUMNS)]
    ).abs() * 100
    if differences.isna().any().any() or differences.max().max() > 0.01:
        raise ValueError(
            "local/online benchmark mismatch exceeds 0.01bp; do not splice"
        )
    calendar = IssuanceCalendar()
    tail = online.loc[online.index > complete.index[-1]].copy()
    if any(not calendar.is_quote_workday(date) for date in tail.index):
        raise ValueError("new quote is outside the verified workday calendar")
    # 覆盖尾部占位行，绝不将零占位当作利率；其余历史逐字值保持。
    valid = tail[list(RATE_COLUMNS)].replace(0, np.nan).notna().all(axis=1)
    tail = tail.loc[valid]
    combined = pd.concat([local.loc[~local.index.isin(tail.index)], tail]).sort_index()
    audit.update(
        online_snapshot=str(online_snapshot),
        overlap_dates=len(overlap),
        max_overlap_difference_bp=float(differences.max().max()),
        appended_dates=[str(date.date()) for date in tail.index],
    )
    return combined, audit
