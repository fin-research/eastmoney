"""Known first-publication lower bound; not a historical-vintage guarantee."""

import json
from pathlib import Path

import pandas as pd

PROFILE = json.loads(
    (Path(__file__).resolve().parents[1] / "online/industry-source.json").read_text()
)
FIRST_PUBLICATION = pd.Timestamp(PROFILE["firstPublicationDate"])


def validate_industry_profile(inputs):
    if inputs.get("industry_source_profile") != PROFILE:
        raise ValueError("industry source profile missing or differs from runtime")


def industry_available(origins):
    """Publication day itself is excluded because no release time is verified."""
    return pd.DatetimeIndex(origins) > FIRST_PUBLICATION
