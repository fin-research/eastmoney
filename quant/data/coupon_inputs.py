"""Read-only T-1 input snapshot of the coupon forecast (same queries as the online Workflow)."""

import os
import re

import certifi
import pandas as pd
import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row

from data.issuance_calendar import CALENDAR_2026, IssuanceCalendar
from model import coupon_forecast as cf

RECENT_QUOTE_DAYS = 45


def _sql(name):
    return re.sub(r"\$\d", "%s", cf.QUERIES[name].replace("%", "%%"))


def fetch_inputs(as_of, issuer=cf.ISSUER):
    load_dotenv()
    with psycopg.connect(
        os.environ["DATABASE_URL"], sslrootcert=certifi.where(), connect_timeout=15,
        row_factory=dict_row, application_name="quant-coupon-inputs",
    ) as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        connection.execute("SET LOCAL statement_timeout = '60000ms'")

        def rows(name, *args):
            return connection.execute(_sql(name), args).fetchall()

        days = [r["observation_date"] for r in rows("curve_days", cf.CURVE_CODE, as_of)]
        recent = days[-RECENT_QUOTE_DAYS:]
        events = rows("issuer_events", issuer, list(cf.TYPES), as_of)
        stamps = pd.DatetimeIndex(days)
        event_days = sorted({str(stamps[stamps < pd.Timestamp(e["tender_date"])][-1].date())
                             for e in events if (stamps < pd.Timestamp(e["tender_date"])).any()} - set(recent))
        return {
            "schema_version": 1,
            "as_of_date": as_of,
            "required_source_date": str(IssuanceCalendar(CALENDAR_2026).previous_quote_day(as_of).date()),
            "issuer": issuer,
            "datasets": {
                "edb": rows("edb", cf.ALL_EDB_CODES, as_of, as_of),
                "quant_input": rows("quant_input", cf.PRIMARY + ["WEIGHTED_COST"], as_of, as_of),
                "curve_days": [{"observation_date": d} for d in days],
                "curve": rows("curve_at", cf.CURVE_CODE, recent),
                "event_curves": rows("curve_at", cf.CURVE_CODE, event_days) if event_days else [],
                "issuer_events": events,
                "issuer_bonds": rows("issuer_bonds", recent, issuer, list(cf.TYPES)),
            },
        }
