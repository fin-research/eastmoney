"""Replay a fixed timing package against read-only Neon or archived T-1 inputs."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

import certifi
from dotenv import load_dotenv
import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from data.issuance_calendar import IssuanceCalendar  # noqa: E402
from data.online_inputs import SOURCES, INDUSTRY_CURVE_CODE  # noqa: E402
from model.timing_advice import timing_features, timing_snapshot  # noqa: E402


def fetch(as_of, calendar):
    load_dotenv()
    with psycopg.connect(
        os.environ["DATABASE_URL"],
        sslrootcert=certifi.where(),
        connect_timeout=15,
        row_factory=dict_row,
        application_name="quant-timing-release",
    ) as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        connection.execute("SET LOCAL statement_timeout = '30000ms'")
        funding = connection.execute(
            """SELECT indicator_code AS field,observation_date::text,
            published_date::text,value::float8 AS value FROM public.edb
            WHERE indicator_code=ANY(%s::text[]) AND observation_date >= %s::date-interval '90 days'
            AND observation_date<%s::date AND COALESCE(published_date,observation_date)<%s::date
            ORDER BY observation_date,indicator_code""",
            (list(SOURCES["funding"]), as_of, as_of, as_of),
        ).fetchall()
        sector = connection.execute(
            """SELECT observation_date::text,yield_pct::float8 FROM public.bond_industry_curve
            WHERE curve_code=%s AND tenor_years=3 AND observation_date >= %s::date-interval '90 days'
            AND observation_date<%s::date ORDER BY observation_date""",
            (INDUSTRY_CURVE_CODE, as_of, as_of),
        ).fetchall()
    return {
        "schema_version": 1,
        "as_of_date": as_of,
        "required_source_date": str(
            IssuanceCalendar(calendar).previous_quote_day(as_of).date()
        ),
        "datasets": {"funding": funding, "sector3": sector},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--as-of", default="2026-10-28")
    parser.add_argument("--inputs", type=Path)
    args = parser.parse_args()
    manifest = json.loads((args.bundle / "manifest.json").read_text())
    model_bytes = (args.bundle / "model-main.json").read_bytes()
    if hashlib.sha256(model_bytes).hexdigest() != manifest["models"]["main"]["sha256"]:
        raise ValueError("Model checksum mismatch")
    model = json.loads(model_bytes)
    inputs = (
        json.loads(args.inputs.read_text())
        if args.inputs
        else fetch(args.as_of, manifest["calendar"])
    )
    if (
        not manifest["training_as_of"]
        <= inputs["as_of_date"]
        <= manifest["retrain_after"]
    ):
        raise ValueError("Invalid or expired timing bundle")
    for name, value in {
        "inputs.json": inputs,
        "python-features.json": timing_features(inputs, model["features"]).tolist(),
        "python-result.json": timing_snapshot(manifest, model, inputs),
    }.items():
        (args.bundle / name).write_text(
            json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)
        )
    print(
        json.dumps(
            {
                "as_of_date": inputs["as_of_date"],
                "source_date": inputs["required_source_date"],
                "rows": {key: len(rows) for key, rows in inputs["datasets"].items()},
                "decision": timing_snapshot(manifest, model, inputs)["decision"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
