"""Macro state by observation period and actual release date, not daily row shifts."""

import numpy as np
import pandas as pd


FIELDS = ("GDP", "CPI", "PPI", "PMI", "SOCIAL_FINANCE", "M2")


def _release_states(rows):
    history, releases, records = {}, {}, []
    for row in rows.itertuples():
        period = row.observation_date.to_period("M")
        history[period] = float(row.value)
        releases[period] = row.available_date
        latest = max(history)
        records.append(
            {
                "date": row.available_date,
                "level": history[latest],
                "change_1m": history[latest] - history.get(latest - 1, np.nan),
                "change_3m": history[latest] - history.get(latest - 3, np.nan),
                "release_date": releases[latest],
            }
        )
    return pd.DataFrame(records).drop_duplicates("date", keep="last").set_index("date")


def macro_release_features(frame, date_index):
    """End-of-day state: callers use dates strictly earlier than the decision.

    Input columns: normalized field, observation_date, published_date, value.
    Exact earlier months must exist before changes are computed. Revisions are
    applied only when released; an older release cannot replace the latest period.
    This preserves vintages if supplied, but cannot reconstruct absent vintages.
    """
    frame = frame.copy()
    required = {"field", "observation_date", "published_date", "value"}
    if not required <= set(frame):
        raise ValueError("macro releases require field, period, publication and value")
    if not frame.field.isin(FIELDS).all():
        raise ValueError("unknown normalized macro field")
    for column in ("observation_date", "published_date"):
        frame[column] = pd.to_datetime(frame[column], errors="coerce")
    if frame[["observation_date", "published_date"]].isna().any().any():
        raise ValueError("macro releases require actual publication dates")
    frame["value"] = pd.to_numeric(frame.value, errors="coerce")
    if not np.isfinite(frame.value).all():
        raise ValueError("macro release values must be finite")
    frame["available_date"] = frame[["observation_date", "published_date"]].max(axis=1)
    keys = ["field", "observation_date", "available_date"]
    if frame.groupby(keys).value.nunique().gt(1).any():
        raise ValueError("conflicting same-date macro revisions")
    frame = frame.sort_values(["available_date", "observation_date"])
    dates = pd.DatetimeIndex(date_index)
    features = pd.DataFrame(index=dates)
    for name in FIELDS:
        rows = frame.loc[frame.field.eq(name)]
        columns = [
            f"macro_{name}_{part}"
            for part in ("level", "change_1m", "change_3m", "release_age_days")
        ]
        if rows.empty:
            features[columns] = np.nan
            continue
        state = _release_states(rows).reindex(dates, method="ffill")
        # No value-level ffill: a missing exact prior month stays unknown.
        for part in ("level", "change_1m", "change_3m"):
            features[f"macro_{name}_{part}"] = state[part]
        age = pd.Series(dates, index=dates) - state.release_date
        features[f"macro_{name}_release_age_days"] = age.dt.days
    return features
