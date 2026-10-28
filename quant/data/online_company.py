"""Read the R2 fund-report gap normalized by Dashboard, without Choice calls."""

import os
from pathlib import Path

import certifi
import numpy as np
import pandas as pd
import psycopg
from dotenv import load_dotenv

GAP_CACHE_NAME = "company_report_gap.csv"


def refresh_fund_report_gap(directory: Path) -> str:
    load_dotenv()
    cache = directory / GAP_CACHE_NAME
    connection_string = os.getenv("DATABASE_URL", "").strip()
    if not connection_string:
        if cache.exists():
            return "资金日报缺口本地缓存"
        raise RuntimeError("资金日报缺口首次读取需要 DATABASE_URL")
    try:
        with psycopg.connect(
            connection_string,
            sslrootcert=certifi.where(),
            connect_timeout=15,
            application_name="quant-fund-report-read",
        ) as connection:
            rows = connection.execute(
                "SELECT observation_date, numeric_value FROM public.quant_input "
                "WHERE field=%s "
                "ORDER BY observation_date",
                ("static_gap_1m",),
            ).fetchall()
    except psycopg.Error as exc:
        raise RuntimeError("资金日报缺口读取失败；未回退资金计划口径") from exc
    if not rows:
        raise RuntimeError("资金日报缺口历史为空")
    frame = pd.DataFrame(rows, columns=["observation_date", "value"])
    temporary = cache.with_suffix(".csv.tmp")
    frame.to_csv(temporary, index=False)
    temporary.replace(cache)
    return f"R2 资金日报规范化历史，{len(frame)} 期"


def apply_fund_report_gap(frame: pd.DataFrame, directory: Path) -> pd.DataFrame:
    cache = directory / GAP_CACHE_NAME
    if not cache.exists():
        raise RuntimeError("缺少资金日报缺口缓存，请先运行主 pipeline 刷新")
    reports = pd.read_csv(cache, parse_dates=["observation_date"])
    reports["value"] = pd.to_numeric(reports["value"], errors="raise")
    if (
        reports.empty
        or reports.isna().any().any()
        or not np.isfinite(reports["value"]).all()
    ):
        raise ValueError("资金日报缺口缓存为空或含缺失值")
    if reports["observation_date"].duplicated().any():
        raise ValueError("资金日报缺口日期重复")
    gap = reports.set_index("observation_date")["value"].sort_index()
    # A report is usable on its report date, never before. Earlier plan gaps
    # are not the same measure and must not fill the missing report history.
    output = frame.reindex(frame.index.union(gap.index).sort_values(), method="ffill")
    output["funding_gap"] = gap.reindex(output.index, method="ffill")
    return output
