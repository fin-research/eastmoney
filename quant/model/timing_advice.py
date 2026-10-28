"""Direct learned three-class timing inference; no coupon or reversal rules."""

from pathlib import Path

import numpy as np
import pandas as pd
from scipy.special import softmax

from data.issuance_calendar import IssuanceCalendar
from data.online_inputs import source_frame
from data.rate_data import build_rate_dataset

FEATURE_VERSION = "timing-advice-v1"
ACTIONS = ("暂缓", "等待", "尽快")


def timing_features(inputs, feature_names):
    as_of = pd.Timestamp(inputs["as_of_date"])
    source = pd.Timestamp(inputs["required_source_date"])
    if source >= as_of:
        raise ValueError("Timing inputs must precede decision date")
    for rows in inputs["datasets"].values():
        for row in rows:
            if pd.Timestamp(row["observation_date"]) >= as_of or (
                row.get("published_date")
                and pd.Timestamp(row["published_date"]) >= as_of
            ):
                raise ValueError("Future timing input")
    keys = [
        (row["field"], max(row["observation_date"], row.get("published_date") or ""))
        for row in inputs["datasets"]["funding"]
    ]
    if len(keys) != len(set(keys)):
        raise ValueError("Duplicate funding quote")
    raw = source_frame("funding", inputs["datasets"]["funding"])
    nodes = pd.DataFrame(inputs["datasets"]["sector3"])
    if nodes.observation_date.duplicated().any():
        raise ValueError("Duplicate sector quote")
    own = pd.Series(
        nodes.yield_pct.to_numpy(), index=pd.to_datetime(nodes.observation_date)
    ).sort_index()
    frames = []
    for market in (raw, raw.assign(AAA_3Y=own.reindex(raw.index))):
        data = build_rate_dataset(
            Path("timing-live"), funding_frame=market, extra_groups=("rate_path",)
        )
        if data.levels_bp.index.max() != source:
            raise ValueError("Stale market quote")
        frames.append(data.market_features.filter(like="path_").loc[source])
    common = frames[0]
    own_path = (
        frames[1]
        .filter(like="path_aaa_3y_")
        .rename(index=lambda key: key.replace("aaa_3y", "own"))
    )
    values = pd.concat([common, own_path]).reindex(feature_names).to_numpy(float)
    if len(values) != 140 or not np.isfinite(values).all():
        raise ValueError("Incomplete timing history")
    return values


def timing_probabilities(model, values):
    vector = (values - np.array(model["mean"])) / np.array(model["std"])
    vector[np.array(model["constant"], dtype=bool)] = 0
    z = np.r_[vector, 1.0, np.zeros(4)]
    logits = z @ np.array(model["theta"]).reshape(145, 2)
    return softmax([logits[0], 0.0, logits[1]])


def timing_snapshot(manifest, model, inputs):
    previous = IssuanceCalendar(manifest["calendar"]).previous_quote_day(
        inputs["as_of_date"]
    )
    if str(previous.date()) != inputs["required_source_date"]:
        raise ValueError("Wrong timing source date")
    values = timing_features(inputs, model["features"])
    probabilities = timing_probabilities(model, values)
    action = ACTIONS[int(probabilities.argmax())]
    return {
        "schema_version": FEATURE_VERSION,
        "as_of_date": inputs["as_of_date"],
        "market_source_date": inputs["required_source_date"],
        "model_version": manifest["model_version"],
        "scope": "AAA证券公司债3Y",
        "window_days": 30,
        "training_label_cutoff": manifest["training_label_cutoff"],
        "probabilities": dict(zip(("defer", "wait", "issue"), probabilities.tolist())),
        "decision": {"action": action},
        "validation": manifest["validation"],
        "base_conclusion": {
            "verdict": action,
            "preferred_window": "",
            "narrative": f"模型建议{action}发行。"
            if action != "等待"
            else "模型建议等待。",
        },
    }
