"""Read-only eligibility for production forecasts; research artifacts stay intact."""

import os
import re
from pathlib import Path

import certifi
from dotenv import load_dotenv
import psycopg


def load_active_release(selection=None):
    from model.issuance_release import load_public_release

    if selection is None:
        selection = (
            Path(__file__).resolve().parents[1]
            / "outputs/selected-coupon/release-evaluation.json"
        )
        if not selection.is_file():
            raise ValueError("selected release missing; specify --coupon-selection")
    evaluation = load_public_release(selection)
    require_active_model(evaluation.get("model_version"))
    return evaluation


def require_active_model(version):
    if not isinstance(version, str) or not re.fullmatch(r"[a-f0-9]{20}", version):
        raise ValueError("Model suspended: quality_review_required")
    load_dotenv()
    with psycopg.connect(
        os.environ["DATABASE_URL"],
        sslrootcert=certifi.where(),
        connect_timeout=15,
        application_name="quant-model-eligibility",
    ) as connection:
        connection.execute("SET TRANSACTION READ ONLY")
        row = connection.execute(
            "SELECT status,reason FROM financing_model.model_eligibility "
            "WHERE model_version=%s",
            (version,),
        ).fetchone()
    if not row or row[0] != "active":
        raise ValueError(
            "Model suspended: " + (row[1] if row else "quality_review_required")
        )
