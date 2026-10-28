"""Read-only, dated online inputs; no Excel fallback or Choice quota use."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import certifi
import numpy as np
import pandas as pd
import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row

from .data import BondDataBuilder, FeatureEngineer
from .feature_engineering import FeatureBuildContext, build_feature_bundle
from .industry_source import FIRST_PUBLICATION, PROFILE, validate_industry_profile

ONLINE_DIR = Path(__file__).resolve().parents[1] / "online"
SOURCES = json.loads((ONLINE_DIR / "sources.json").read_text())
QUERIES = json.loads((ONLINE_DIR / "queries.json").read_text())
ONLINE_GROUPS = ("funding", "equity", "primary_bond", "macro", "calendar")
FEATURE_VERSION = "online-market-v1"
INDUSTRY_CURVE_CODE = "5781a1ff7651967e0176978d957b7346"
ISSUANCE_INPUT_GROUPS = (
    "funding",
    "issue",
    "macro",
    "primary",
    "secondary",
    "industry_curve",
    "bond_issuance",
    "issuer_daily",
)


def fetch_inputs(as_of: str, groups: tuple[str, ...] | None = None) -> dict:
    """Pin a repeatable-read snapshot with all observations strictly before T."""
    pd.Timestamp(as_of)  # reject invalid dates before connecting
    selected = tuple(SOURCES) if groups is None else groups
    if not selected or set(selected) - (
        set(SOURCES)
        | {
            "industry_curve",
            "bond_issuance",
            "bond_history",
            "industry_nodes",
            "issuer_daily",
        }
    ):
        raise ValueError("unknown or empty online input groups")
    load_dotenv()
    with psycopg.connect(
        os.environ["DATABASE_URL"],
        sslrootcert=certifi.where(),
        connect_timeout=15,
        keepalives_idle=30,
        keepalives_interval=10,
        keepalives_count=3,
        row_factory=dict_row,
        application_name="quant-online-inputs",
    ) as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        connection.execute("SET LOCAL statement_timeout = '120000ms'")
        result = {"schema_version": 1, "as_of_date": as_of, "datasets": {}}
        if set(selected) & {"industry_curve", "industry_nodes"}:
            result["industry_source_profile"] = PROFILE
        for group in selected:
            if group == "issue":
                sql = re.sub(r"\$\d", "%s", QUERIES["issue"])
                result["datasets"][group] = _read_rows(connection, sql, (as_of,))
                continue
            if group == "issuer_daily":
                result["datasets"][group] = _issuer_history(connection, as_of)
                continue
            if group in ("bond_issuance", "bond_history", "industry_nodes"):
                sql = {
                    "bond_issuance": "SELECT *,issue_date::text AS observation_date FROM public.bond_issuance WHERE issue_date<%s::date ORDER BY bond_code",
                    "bond_history": "SELECT h.bond_code,h.valuation_date::text,h.chinabond_yield_pct,h.outstanding_balance_cny,h.remaining_term_years FROM public.bond_history h JOIN public.bond_issuance i ON h.bond_code=public.exchange_bond_code(i.bond_code) WHERE h.valuation_date<%s::date AND i.interest_rate_type='固息' ORDER BY h.valuation_date,h.bond_code",
                    "industry_nodes": "SELECT curve_code,curve_name,observation_date::text,tenor_years,yield_pct FROM public.bond_industry_curve WHERE observation_date<%s::date ORDER BY observation_date,tenor_years",
                }[group]
                rows = _read_rows(connection, sql, (as_of,))
                if group == "bond_history":
                    rows = [
                        {
                            **row,
                            "bond_code": decode_exchange_bond_code(row["bond_code"]),
                        }
                        for row in rows
                    ]
                result["datasets"][group] = rows
                continue
            if group == "industry_curve":
                result["datasets"][group] = _read_rows(
                    connection,
                    re.sub(r"\$\d", "%s", QUERIES["industry_curve"]),
                    (INDUSTRY_CURVE_CODE, as_of),
                )
                continue
            mapping = SOURCES[group]
            kind = "edb" if group in ("funding", "macro") else "quant"
            sql = re.sub(r"\$\d", "%s", QUERIES[kind])
            args = (list(mapping), as_of, as_of)
            result["datasets"][group] = _read_rows(connection, sql, args)
    return result


def _issuer_history(connection, as_of):
    rows = []
    end = pd.Timestamp(as_of)
    sql = re.sub(r"\$\d", "%s", QUERIES["issuer_daily_rows"])
    for year in range(2019, end.year + 1):
        start = pd.Timestamp(year=year, month=1, day=1)
        stop = min(pd.Timestamp(year=year + 1, month=1, day=1), end)
        if start >= stop:
            continue
        part = _read_rows(connection, sql, (str(stop.date()), str(start.date())))
        rows.extend(part)
        print(f"[inputs] issuer_daily {year}: {len(part)} rows", flush=True)
    return rows


def _read_rows(connection, sql, args):
    rows = []
    with connection.cursor(name="quant_snapshot_rows") as cursor:
        cursor.execute(sql, args)
        while batch := cursor.fetchmany(10000):
            rows.extend(batch)
    return rows


def decode_exchange_bond_code(value: int) -> str:
    if not isinstance(value, int) or not 10_000_000 <= value < 30_000_000:
        raise ValueError("invalid encoded exchange bond code")
    market = "SH" if value < 20_000_000 else "SZ"
    extra = value % 10_000_000 // 1_000_000
    suffix = "" if extra == 0 else "X" if extra == 1 else f"X{extra}"
    return f"{value % 1_000_000:06d}{suffix}.{market}"


def source_frame(group: str, rows: list[dict], *, require_spread=True) -> pd.DataFrame:
    """Pivot raw observations; macro revisions never replace newer periods."""
    mapping = SOURCES[group]
    records = []
    latest_period = {}
    if group == "macro":
        if any(not row.get("published_date") for row in rows):
            raise ValueError("宏观数据缺少真实发布日期")
        rows = sorted(rows, key=lambda r: (r["published_date"], r["observation_date"]))
    for row in rows:
        field = mapping[row["field"]]
        value = row["value"]
        if group == "macro":
            if row["observation_date"] < latest_period.get(field, ""):
                continue
            latest_period[field] = row["observation_date"]
        available = max(row["observation_date"], row.get("published_date") or "")
        if group == "issue":
            records.append(
                {
                    "date": available,
                    "key": row["entity_key"].upper(),
                    "field": field,
                    "value": value,
                }
            )
        else:
            records.append({"date": available, "field": field, "value": value})
    if not records:
        raise ValueError(f"线上输入为空: {group}")
    raw = pd.DataFrame(records)
    index = ["date", "key"] if group == "issue" else "date"
    frame = raw.pivot_table(
        index=index, columns="field", values="value", aggfunc="last"
    )
    frame = frame.reindex(columns=list(mapping.values()))
    if group == "issue":
        return _issue_frame(frame, require_spread=require_spread)
    frame.index = pd.to_datetime(frame.index)
    frame = frame.apply(pd.to_numeric, errors="coerce").sort_index()
    if group == "macro":
        frame[["GDP", "PMI", "SOCIAL_FINANCE", "M2"]] = frame[
            ["GDP", "PMI", "SOCIAL_FINANCE", "M2"]
        ].replace(0, np.nan)
    return frame


def _issue_frame(frame: pd.DataFrame, *, require_spread=True) -> pd.DataFrame:
    frame = frame.reset_index().rename(
        columns={"date": "issue_date", "key": "bond_code"}
    )
    frame["issue_date"] = pd.to_datetime(frame["issue_date"])
    frame["has_option"] = frame["has_option"].replace(
        {0: "否", 1: "是", "0": "否", "1": "是"}
    )
    frame["tenor"] = (
        frame["tenor"].astype(str).str.extract(r"(\d+(?:\.\d+)?)", expand=False)
    )
    for column in ("tenor", "coupon", "issue_size", "spread_to_benchmark"):
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    frame = frame[frame["bond_type"].isin(["证券公司债", "证券公司次级债"])]
    required = ["rating", "tenor", "coupon", "issue_size"]
    if require_spread:
        required.append("spread_to_benchmark")
    return frame.dropna(subset=required)


def apply_industry_curve(raw: pd.DataFrame, rows: list[dict]) -> pd.DataFrame:
    curve = pd.DataFrame(rows)
    if curve.empty or curve.observation_date.duplicated().any():
        raise ValueError("industry curve is empty or has duplicate dates")
    curve["observation_date"] = pd.to_datetime(curve.observation_date)
    curve["yield_pct"] = pd.to_numeric(curve.yield_pct, errors="raise")
    if curve.yield_pct.isna().any() or curve.yield_pct.le(0).any():
        raise ValueError("invalid industry curve yields")
    result = raw.copy()
    # Preserve all source observations in the snapshot, but do not rewrite
    # pre-launch daily market states with a subsequently simulated curve.
    curve.loc[curve.observation_date.lt(FIRST_PUBLICATION), "yield_pct"] = np.nan
    result["AAA_3Y"] = curve.set_index("observation_date").yield_pct.reindex(raw.index)
    return result


def build_issuance_market(inputs):
    """真实定价元数据与线上行情共用本地一级定价、特征和时间边界。"""
    from .rate_data import build_rate_dataset

    as_of = pd.Timestamp(inputs["as_of_date"])
    if set(inputs["datasets"]) & {"industry_curve", "industry_nodes"}:
        validate_industry_profile(inputs)
    for group, rows in inputs["datasets"].items():
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ValueError(
                f"input dataset {group} must be a list of observation records"
            )
        if any(
            pd.Timestamp(
                max(
                    row.get("observation_date", row.get("date", "")),
                    row.get("published_date") or "",
                )
            )
            >= as_of
            for row in rows
        ):
            raise ValueError("online inputs contain unavailable observations")
    datasets = inputs["datasets"]
    raw = source_frame("funding", datasets["funding"])
    raw = raw.loc[raw.index >= "2019-01-01"]
    if "industry_curve" in datasets:
        raw = apply_industry_curve(raw, datasets["industry_curve"])
    source_frames = {"funding": raw}
    extra_groups = []
    if "macro" in datasets:
        source_frames["macro_releases"] = pd.DataFrame(
            {
                "field": SOURCES["macro"][row["field"]],
                "observation_date": row["observation_date"],
                "published_date": row["published_date"],
                "value": row["value"],
            }
            for row in datasets["macro"]
        )
        extra_groups.append("macro_releases")
    for dataset, group in (
        ("primary", "primary_bond"),
        ("secondary", "secondary_bond"),
    ):
        if dataset in datasets:
            source_frames[dataset] = source_frame(dataset, datasets[dataset])
            extra_groups.append(group)
    rates = build_rate_dataset(
        Path("online"),
        funding_frame=raw,
        extra_groups=tuple(extra_groups),
        source_frames=source_frames,
        require_credit_quote=False,
    )
    return rates


def build_online_issuance(inputs):
    """Legacy incumbent pricing baseline, retained for matched comparison."""
    from .primary_pricing import build_primary_pricing_dataset

    as_of = pd.Timestamp(inputs["as_of_date"])
    datasets = inputs["datasets"]
    rates = build_issuance_market(inputs)
    bonds = source_frame("issue", datasets["issue"], require_spread=False)
    metadata_columns = [
        "bond_code",
        "pricing_date",
        "final_coupon",
        "issuance_rating",
        "announcement_date",
    ]
    metadata = bonds[metadata_columns].copy()
    bonds = bonds.drop(columns=metadata_columns[1:])
    dataset, audit = build_primary_pricing_dataset(
        rates, bonds=bonds, metadata=metadata
    )
    audit["source"] = "Neon public.bond_issuance; Choice pricing metadata"
    if "industry_curve" in datasets:
        audit["benchmark"] = "Neon public.bond_industry_curve AAA securities-company 3Y"
    if dataset.empty:
        raise ValueError("no verified exchange pricing history in online inputs")
    return rates, dataset.loc[dataset.label_available_date.lt(as_of)].copy(), audit


def _align_market_frame(name, frame, dates):
    # Daily issuance flows expire each day: stale amounts cannot stand in for
    # an unreported day. The primary builder already supplies a daily index.
    if name == "primary_bond":
        return frame.reindex(dates)
    return frame.ffill().reindex(dates, method="ffill")


def build_online_dataset(inputs: dict) -> tuple[pd.DataFrame, FeatureEngineer]:
    """Reuse the registered Python features and existing label/model contracts."""
    frames = {
        name: source_frame(name, rows) for name, rows in inputs["datasets"].items()
    }
    bundle = build_feature_bundle(
        ONLINE_GROUPS,
        FeatureBuildContext(data_path=Path("."), source_frames=frames),
    )
    # The funding trading calendar is the inference clock. Each group carries
    # latest available levels. Daily primary flows retain missing reports;
    # sparse non-trading dates survive feature construction without lookahead.
    dates = bundle["funding"].index
    aligned = {
        name: _align_market_frame(name, frame, dates)
        for name, frame in bundle.frames.items()
    }
    fe = FeatureEngineer()
    fe.feature_group_columns_ = {name: list(frame) for name, frame in aligned.items()}
    bonds = BondDataBuilder().build_label(frames["issue"])
    dataset = fe.merge_all_features(
        bonds,
        aligned["funding"],
        aligned["equity"],
        pd.DataFrame(index=dates),
        aligned["primary_bond"],
        aligned["macro"],
        aligned["calendar"],
    )
    # Generic future issuance has no known issuer. Exclude issuer frequency
    # rather than train on future issuer activity and substitute zero at scoring.
    fe.feature_names.remove("issuer_frequency_30d")
    dataset = dataset[dataset[fe.feature_names].isna().mean(axis=1) <= 0.5].copy()
    # Leave missing values for fold-local imputation / LightGBM. Do not use
    # full-history medians to fill validation periods before splitting.
    return dataset, fe
