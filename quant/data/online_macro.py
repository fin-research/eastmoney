"""Read the canonical real-GDP series from EDB without consuming Choice quota."""

from __future__ import annotations

import os
from pathlib import Path

import certifi
import pandas as pd
import psycopg
from dotenv import load_dotenv

GDP_CODE = "EMM00000012"
GDP_CACHE_NAME = "gdp_real_yoy.csv"


def refresh_real_gdp(directory: Path) -> str:
    """Cache observed periods and actual publication dates for offline reruns."""
    load_dotenv()
    cache = directory / GDP_CACHE_NAME
    connection_string = os.getenv("DATABASE_URL", "").strip()
    if not connection_string:
        if cache.exists():
            return "本地 GDP 不变价同比缓存"
        raise RuntimeError("GDP 口径已统一为线上不变价同比；首次运行需要 DATABASE_URL")
    try:
        with psycopg.connect(
            connection_string,
            sslrootcert=certifi.where(),
            connect_timeout=15,
            application_name="quant-real-gdp-read",
        ) as connection:
            rows = connection.execute(
                "SELECT observation_date, published_date, value::float8 "
                "FROM public.edb WHERE indicator_code=%s "
                "ORDER BY observation_date",
                (GDP_CODE,),
            ).fetchall()
    except psycopg.Error as exc:
        raise RuntimeError("读取线上 GDP 失败；未切回现价同比") from exc
    if not rows:
        raise RuntimeError("线上 GDP 不变价同比为空")
    frame = pd.DataFrame(rows, columns=["observation_date", "published_date", "value"])
    temporary = cache.with_suffix(".csv.tmp")
    frame.to_csv(temporary, index=False)
    temporary.replace(cache)
    return f"Neon {GDP_CODE}，{len(frame)} 期（不变价同比，按发布日期对齐）"


def real_gdp_on_dates(path: str | Path, dates: pd.DatetimeIndex) -> pd.Series | None:
    cache = Path(path).parent / GDP_CACHE_NAME
    if not cache.exists():
        return None
    frame = pd.read_csv(cache, parse_dates=["observation_date", "published_date"])
    frame["value"] = pd.to_numeric(frame["value"], errors="raise")
    if frame[["observation_date", "published_date", "value"]].isna().any().any():
        raise ValueError("GDP 缓存含缺失值")
    # Revisions to older quarters cannot replace a later quarter's current level.
    frame = frame.sort_values(["published_date", "observation_date"])
    latest_period = frame["observation_date"].cummax()
    frame = frame[frame["observation_date"] == latest_period]
    series = frame.drop_duplicates("published_date", keep="last").set_index(
        "published_date"
    )["value"]
    return series.reindex(dates, method="ffill")
