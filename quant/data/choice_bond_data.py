"""从统一 data API 增量更新 Choice 债券发行数据。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Iterable

import pandas as pd

from choice.data_api import ChoiceAPIError, ChoiceResult, css, ctr

BASE_DIR = Path(__file__).parent
LEGACY_DATA_FILE = BASE_DIR / "data.xlsx"

ISSUE_DETAIL_FILE = BASE_DIR / "债券发行明细.xlsx"
ISSUE_STATISTICS_FILE = BASE_DIR / "发行与到期统计表(债券口径).xlsx"

ISSUE_DETAIL_REPORT = "BondIssueDetail"
ISSUE_STATISTICS_REPORT = "BondIssueStatistics"
ISSUE_SPREAD_INDICATOR = "ISSUECREDITSPREAD"
INVALID_STOCK_CODE_ERROR = 10003008

DEFAULT_START_DATE = date(2019, 1, 1)
SECURITIES_BOND_TYPES = {"证券公司债", "证券公司次级债"}

ISSUE_DETAIL_INDICATORS = (
    "SECUCODE,BOND_NAME_ABBR,BOND_TYPE,ISSUE_DATE,ACTUAL_ISSUE_SCALE,"
    "BOND_EXPIRE_YEAR,ISSUERATE_REFERENCE,PAYPERYEAR,TOMRTY_YEAR,"
    "DEC_TOMRTYYEAR1,ISSUER_RATING,BOND_RATING,IS_OEB,IS_GUARANTEE,"
    "PI_RATE_TYPE,ISSUER_NAME,ORGFORM"
)
ISSUE_STATISTICS_INDICATORS = (
    "START_DATE,END_DATE,ISSUE_AMT,ISSUE_NUM,TOTAL_REPAY_AMT,TOTAL_REPAY_NUM,"
    "NET_FINANCE_AMT,END_REPAY_AMT,END_REPAY_NUM,ADVANCED_REPAY_AMT,"
    "ADVANCED_REPAY_NUM,RESALE_AMT,RESALE_NUM,REDEEM_AMT,REDEEM_NUM,"
    "VIOLATE_AMT,VIOLATE_NUM,WEIGHTED_COST"
)

ISSUE_DETAIL_COLUMNS = [
    "序号",
    "代码",
    "简称",
    "债券全称",
    "发行人名称",
    "企业性质",
    "发行日期",
    "债券类型",
    "发行总额(亿)",
    "发行期限",
    "发行期限(年)",
    "票面利率(发行参考)(%)",
    "发行利差",
    "年付息次数(次)",
    "特殊剩余期限",
    "剩余期限(年)",
    "主体评级",
    "债项评级",
    "是否含权",
    "是否担保",
    "利率类型",
    "跨市场代码",
]
ISSUE_STATISTICS_COLUMNS = [
    "开始日期",
    "截止日期",
    "发行总额(亿)",
    "发行只数(只)",
    "偿还总额(亿)",
    "偿还只数(只)",
    "净融资额(亿)",
    "加权融资成本(%)",
    "融资增长率(%)",
    "到期偿还额(亿)",
    "到期只数(只)",
    "提前兑付额(亿)",
    "提前兑付只数(只)",
    "回售额(亿)",
    "回售只数(只)",
    "赎回额(亿)",
    "赎回只数(只)",
    "违约偿付额(亿)",
    "违约偿付只数(只)",
]


@dataclass(frozen=True)
class ChoiceBondReport:
    """Choice 债券专题报表配置。"""

    name: str
    report_name: str
    output_path: Path
    default_options: str
    indicators: str


@dataclass(frozen=True)
class ChoiceBondResult:
    """单张报表的更新结果。"""

    dataframe: pd.DataFrame
    source: str
    warning: str | None = None


def _yyyymmdd(value: date | str) -> str:
    if isinstance(value, date):
        return value.strftime("%Y-%m-%d")
    return pd.Timestamp(value).strftime("%Y-%m-%d")


def _join_options(parts: Iterable[str]) -> str:
    return ",".join(part for part in parts if part)


def default_issue_detail_options(
    start: date | str = DEFAULT_START_DATE,
    end: date | str = date.today(),
) -> str:
    """金融机构债发行明细参数；券商债口径在代码里二次筛选。"""
    return _join_options(
        [
            f"StartDate={_yyyymmdd(start)}",
            f"EndDate={_yyyymmdd(end)}",
            "Bond_Type=646003",
            "Frequency=1",
            "Issuer_Rating=-",
            "Bond_Rating=-",
            "Issue_Date_Type=2",
            "Tenor=-",
            "Company_Type=-",
        ]
    )


def default_issue_statistics_options(
    start: date | str = DEFAULT_START_DATE,
    end: date | str = date.today(),
) -> str:
    """全市场 AAA 债券发行/到期统计参数。"""
    return _join_options(
        [
            f"StartDate={_yyyymmdd(start)}",
            f"EndDate={_yyyymmdd(end)}",
            "Bond_Type=-",
            "Frequency=1",
            "Issue_Date_Type=2",
            "Tenor=-",
            "Issuer_Rating=AAA",
            "Bond_Rating=-",
            "Region=-",
            "Company_Type=-",
        ]
    )


def build_reports(
    start: date | str = DEFAULT_START_DATE,
    end: date | str = date.today(),
) -> list[ChoiceBondReport]:
    return [
        ChoiceBondReport(
            name="债券发行明细",
            report_name=ISSUE_DETAIL_REPORT,
            output_path=ISSUE_DETAIL_FILE,
            default_options=default_issue_detail_options(start, end),
            indicators=ISSUE_DETAIL_INDICATORS,
        ),
        ChoiceBondReport(
            name="发行与到期统计表(债券口径)",
            report_name=ISSUE_STATISTICS_REPORT,
            output_path=ISSUE_STATISTICS_FILE,
            default_options=default_issue_statistics_options(start, end),
            indicators=ISSUE_STATISTICS_INDICATORS,
        ),
    ]


def ctr_to_dataframe(result: ChoiceResult) -> pd.DataFrame:
    """将 data API Choice CTR 表格转换为 DataFrame。"""
    return pd.DataFrame(result.rows, columns=result.fields)


def fetch_report(report: ChoiceBondReport) -> pd.DataFrame:
    """拉取一个 Choice 债券专题报表。"""
    result = ctr(
        report.report_name,
        report.indicators,
        report.default_options,
    )
    if result.error_code != 0:
        raise ChoiceAPIError(
            f"{report.name} 拉取失败: {result.error_code} {result.error_msg}; "
            f"report={report.report_name}; options={report.default_options}"
        )
    df = ctr_to_dataframe(result)
    if df.empty:
        raise ChoiceAPIError(
            f"{report.name} 返回空数据; report={report.report_name}; "
            f"options={report.default_options}"
        )
    return df


def read_existing_report(report: ChoiceBondReport) -> pd.DataFrame:
    """读取已有 Excel；不存在时返回空表。"""
    if not report.output_path.exists():
        return pd.DataFrame()
    return pd.read_excel(report.output_path, sheet_name=report.name)


def _clean_existing_report(df: pd.DataFrame, date_col: str) -> pd.DataFrame:
    """去掉 Choice Excel 尾部数据来源行和空行。"""
    if df.empty or date_col not in df.columns:
        return pd.DataFrame(columns=df.columns)
    output = df.copy()
    output[date_col] = pd.to_datetime(output[date_col], errors="coerce")
    output = output[output[date_col].notna()].copy()
    output[date_col] = output[date_col].dt.strftime("%Y-%m-%d")
    return output


def _incremental_start(
    existing: pd.DataFrame,
    date_col: str,
    requested_start: date | str,
) -> str:
    start_ts = pd.Timestamp(requested_start)
    if existing.empty or date_col not in existing.columns:
        return start_ts.strftime("%Y-%m-%d")
    existing_dates = pd.to_datetime(existing[date_col], errors="coerce").dropna()
    if existing_dates.empty:
        return start_ts.strftime("%Y-%m-%d")
    return max(start_ts, existing_dates.max()).strftime("%Y-%m-%d")


def _next_incremental_start(
    existing: pd.DataFrame,
    date_col: str,
    requested_start: date | str,
) -> str:
    start_ts = pd.Timestamp(requested_start)
    if existing.empty or date_col not in existing.columns:
        return start_ts.strftime("%Y-%m-%d")
    existing_dates = pd.to_datetime(existing[date_col], errors="coerce").dropna()
    if existing_dates.empty:
        return start_ts.strftime("%Y-%m-%d")
    next_ts = existing_dates.max() + pd.Timedelta(days=1)
    return max(start_ts, next_ts).strftime("%Y-%m-%d")


def _format_tenor(value: object) -> object:
    if pd.isna(value):
        return pd.NA
    return f"{float(value):g}年"


def _yes_no(value: object) -> object:
    if pd.isna(value):
        return pd.NA
    text = str(value).strip()
    if text in {"1", "是", "Y", "y", "True", "true"}:
        return "是"
    if text in {"0", "否", "N", "n", "False", "false"}:
        return "否"
    return value


def _fetch_issue_spreads(
    codes: Iterable[str],
    chunk_size: int = 64,
    invalid_codes: list[str] | None = None,
) -> dict[str, float]:
    """批量拉取发行利差，并隔离 Choice 无效代码。

    Choice 的 css 是整批失败语义：一个无效代码会让同批其他债券也无法返回。
    遇到 10003008 时二分定位无效代码，其他代码继续补数；无效代码
    通过 invalid_codes 返回给上层显式告警。
    """
    unique_codes = [
        str(code).strip()
        for code in pd.Series(list(codes)).dropna().drop_duplicates()
        if str(code).strip()
    ]
    original_code_by_upper = {code.upper(): code for code in unique_codes}
    spreads: dict[str, float] = {}
    detected_invalid_codes = invalid_codes if invalid_codes is not None else []

    def fetch_chunk(chunk: list[str]) -> None:
        result = css(
            ",".join(chunk),
            ISSUE_SPREAD_INDICATOR,
            "",
        )
        if result.error_code != 0:
            if result.error_code == INVALID_STOCK_CODE_ERROR:
                if len(chunk) == 1:
                    detected_invalid_codes.append(chunk[0])
                    return
                midpoint = len(chunk) // 2
                fetch_chunk(chunk[:midpoint])
                fetch_chunk(chunk[midpoint:])
                return
            raise ChoiceAPIError(
                f"发行利差拉取失败: {result.error_code} {result.error_msg}; "
                f"indicator={ISSUE_SPREAD_INDICATOR}"
            )
        for row in result.rows:
            code = row.get("code")
            if code is None:
                raise ChoiceAPIError("发行利差返回缺少 code 字段")
            value = row.get(ISSUE_SPREAD_INDICATOR)
            if value is not None:
                spread = float(value)
                spreads[str(code)] = spread
                original_code = original_code_by_upper.get(str(code).strip().upper())
                if original_code:
                    spreads[original_code] = spread

    for start in range(0, len(unique_codes), chunk_size):
        fetch_chunk(unique_codes[start : start + chunk_size])
    return spreads


def _legacy_issue_spreads() -> dict[str, float]:
    """读取旧工作簿已计算的发行利差，减少重复 API 调用。"""
    if not LEGACY_DATA_FILE.exists():
        return {}
    try:
        df = pd.read_excel(LEGACY_DATA_FILE, sheet_name="可比券商债", header=0)
    except Exception:
        return {}
    if not {"代码", "发行利差"}.issubset(df.columns):
        return {}
    return (
        df.dropna(subset=["代码", "发行利差"])
        .drop_duplicates("代码", keep="last")
        .set_index("代码")["发行利差"]
        .astype(float)
        .to_dict()
    )


def normalize_issue_detail(df: pd.DataFrame) -> pd.DataFrame:
    """将 Choice 字段转换为项目使用的债券发行明细表结构。"""
    if df.empty:
        return pd.DataFrame(columns=ISSUE_DETAIL_COLUMNS)
    output = df.rename(
        columns={
            "SECUCODE": "代码",
            "BOND_NAME_ABBR": "简称",
            "BOND_TYPE": "债券类型",
            "ISSUE_DATE": "发行日期",
            "ACTUAL_ISSUE_SCALE": "发行总额(亿)",
            "BOND_EXPIRE_YEAR": "发行期限(年)",
            "ISSUERATE_REFERENCE": "票面利率(发行参考)(%)",
            "PAYPERYEAR": "年付息次数(次)",
            "TOMRTY_YEAR": "剩余期限(年)",
            "DEC_TOMRTYYEAR1": "特殊剩余期限",
            "ISSUER_RATING": "主体评级",
            "BOND_RATING": "债项评级",
            "IS_OEB": "是否含权",
            "IS_GUARANTEE": "是否担保",
            "PI_RATE_TYPE": "利率类型",
            "ISSUER_NAME": "发行人名称",
            "ORGFORM": "企业性质",
        }
    )
    output = output[output["债券类型"].isin(SECURITIES_BOND_TYPES)].copy()
    output["债券全称"] = pd.NA
    output["发行期限"] = output["发行期限(年)"].map(_format_tenor)
    output["跨市场代码"] = output["代码"]
    output["是否含权"] = output["是否含权"].map(_yes_no)
    output["是否担保"] = output["是否担保"].map(_yes_no)
    output["发行日期"] = pd.to_datetime(
        output["发行日期"], errors="coerce"
    ).dt.strftime("%Y-%m-%d")
    output["发行利差"] = pd.NA
    for col in ISSUE_DETAIL_COLUMNS:
        if col not in output.columns:
            output[col] = pd.NA
    return output[ISSUE_DETAIL_COLUMNS]


def _fill_issue_spreads(
    new_df: pd.DataFrame,
    existing_df: pd.DataFrame,
    warnings_out: list[str] | None = None,
) -> pd.DataFrame:
    """只给缺失发行利差的债券补数，优先复用本地已有值。"""
    if new_df.empty:
        return new_df
    output = new_df.copy()
    existing_spreads: dict[str, float] = {}
    if not existing_df.empty and {"代码", "发行利差"}.issubset(existing_df.columns):
        existing_spreads = (
            existing_df.dropna(subset=["代码", "发行利差"])
            .drop_duplicates("代码", keep="last")
            .set_index("代码")["发行利差"]
            .astype(float)
            .to_dict()
        )
    existing_spreads = {**_legacy_issue_spreads(), **existing_spreads}
    output["发行利差"] = pd.to_numeric(output["发行利差"], errors="coerce")
    output["发行利差"] = output["发行利差"].fillna(output["代码"].map(existing_spreads))
    missing_codes = output.loc[output["发行利差"].isna(), "代码"]
    if not missing_codes.empty:
        invalid_codes: list[str] = []
        fetched = _fetch_issue_spreads(missing_codes, invalid_codes=invalid_codes)
        output["发行利差"] = output["发行利差"].fillna(output["代码"].map(fetched))
        if invalid_codes and warnings_out is not None:
            warnings_out.append(
                "data API/Choice 发行利差无效代码: "
                + ", ".join(sorted(set(invalid_codes)))
                + "；已保留记录并继续更新其他债券"
            )
    return output


def normalize_issue_statistics(df: pd.DataFrame) -> pd.DataFrame:
    """将 Choice 字段转换为项目使用的发行与到期统计表结构。"""
    if df.empty:
        return pd.DataFrame(columns=ISSUE_STATISTICS_COLUMNS)
    output = df.rename(
        columns={
            "START_DATE": "开始日期",
            "END_DATE": "截止日期",
            "ISSUE_AMT": "发行总额(亿)",
            "ISSUE_NUM": "发行只数(只)",
            "TOTAL_REPAY_AMT": "偿还总额(亿)",
            "TOTAL_REPAY_NUM": "偿还只数(只)",
            "NET_FINANCE_AMT": "净融资额(亿)",
            "END_REPAY_AMT": "到期偿还额(亿)",
            "END_REPAY_NUM": "到期只数(只)",
            "ADVANCED_REPAY_AMT": "提前兑付额(亿)",
            "ADVANCED_REPAY_NUM": "提前兑付只数(只)",
            "RESALE_AMT": "回售额(亿)",
            "RESALE_NUM": "回售只数(只)",
            "REDEEM_AMT": "赎回额(亿)",
            "REDEEM_NUM": "赎回只数(只)",
            "VIOLATE_AMT": "违约偿付额(亿)",
            "VIOLATE_NUM": "违约偿付只数(只)",
            "WEIGHTED_COST": "加权融资成本(%)",
        }
    )
    output["融资增长率(%)"] = pd.NA
    for col in ["开始日期", "截止日期"]:
        output[col] = pd.to_datetime(output[col], errors="coerce").dt.strftime(
            "%Y-%m-%d"
        )
    repay_amount_cols = [
        "偿还总额(亿)",
        "到期偿还额(亿)",
        "提前兑付额(亿)",
        "回售额(亿)",
        "赎回额(亿)",
        "违约偿付额(亿)",
    ]
    for col in repay_amount_cols:
        output[col] = pd.to_numeric(output[col], errors="coerce").abs()
    for col in ISSUE_STATISTICS_COLUMNS:
        if col not in output.columns:
            output[col] = pd.NA
    return output[ISSUE_STATISTICS_COLUMNS]


def _merge_reports(
    existing: pd.DataFrame,
    new: pd.DataFrame,
    keys: list[str],
    sort_date_col: str,
) -> pd.DataFrame:
    merged = pd.concat([existing, new], ignore_index=True)
    if merged.empty:
        return merged
    merged = merged.drop_duplicates(keys, keep="last")
    merged[sort_date_col] = pd.to_datetime(merged[sort_date_col], errors="coerce")
    merged = merged[merged[sort_date_col].notna()].sort_values(
        [sort_date_col, *keys],
        ascending=[False, *([True] * len(keys))],
    )
    merged[sort_date_col] = merged[sort_date_col].dt.strftime("%Y-%m-%d")
    return merged.reset_index(drop=True)


def _fetch_issue_detail_increment(
    report: ChoiceBondReport,
    existing: pd.DataFrame,
    start: date | str,
    end: date | str,
) -> pd.DataFrame:
    fetch_start = _incremental_start(existing, "发行日期", start)
    try:
        raw = fetch_report(
            ChoiceBondReport(
                name=report.name,
                report_name=report.report_name,
                output_path=report.output_path,
                default_options=default_issue_detail_options(fetch_start, end),
                indicators=report.indicators,
            )
        )
    except ChoiceAPIError as exc:
        if "10000009" in str(exc):
            return pd.DataFrame(columns=ISSUE_DETAIL_COLUMNS)
        raise
    return normalize_issue_detail(raw)


def _fetch_statistics_increment(
    report: ChoiceBondReport,
    existing: pd.DataFrame,
    start: date | str,
    end: date | str,
) -> pd.DataFrame:
    fetch_start = _next_incremental_start(existing, "开始日期", start)
    end_text = _yyyymmdd(end)
    if pd.Timestamp(fetch_start) > pd.Timestamp(end_text):
        return pd.DataFrame(columns=ISSUE_STATISTICS_COLUMNS)

    frames: list[pd.DataFrame] = []
    for day in pd.date_range(fetch_start, end_text, freq="D"):
        day_text = day.strftime("%Y-%m-%d")
        raw = fetch_report(
            ChoiceBondReport(
                name=report.name,
                report_name=report.report_name,
                output_path=report.output_path,
                default_options=default_issue_statistics_options(day_text, day_text),
                indicators=report.indicators,
            )
        )

        normalized = normalize_issue_statistics(raw)
        bad_dates = normalized[
            (normalized["开始日期"] != day_text) | (normalized["截止日期"] != day_text)
        ]
        if not bad_dates.empty:
            raise ChoiceAPIError(
                f"{report.name} 单日请求返回非日频数据，拒绝覆盖本地日频表; "
                f"report={report.report_name}; "
                f"options={default_issue_statistics_options(day_text, day_text)}"
            )
        frames.append(normalized)
    if not frames:
        return pd.DataFrame(columns=ISSUE_STATISTICS_COLUMNS)
    return pd.concat(frames, ignore_index=True)


def write_report(df: pd.DataFrame, path: Path, sheet_name: str) -> None:
    """写入 Excel，保持数据值可编辑。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(
        path,
        engine="xlsxwriter",
        datetime_format="yyyy-mm-dd",
        date_format="yyyy-mm-dd",
    ) as writer:
        df.to_excel(writer, sheet_name=sheet_name, index=False)
        workbook = writer.book
        workbook.formats[0].set_font_name("微软雅黑")
        worksheet = writer.sheets[sheet_name]
        worksheet.set_zoom(120)
        worksheet.freeze_panes(1, 0)
        header_format = workbook.add_format(
            {
                "bold": True,
                "bg_color": "#D9EAF7",
                "border": 1,
                "align": "center",
                "font_name": "微软雅黑",
            }
        )
        for col_num, value in enumerate(df.columns):
            worksheet.write(0, col_num, value, header_format)
            width = min(max(len(str(value)) + 2, 10), 24)
            worksheet.set_column(col_num, col_num, width)


def update_choice_bond_data() -> dict[str, ChoiceBondResult]:
    """增量拉取并写入两张 Choice 债券数据表。"""
    output: dict[str, ChoiceBondResult] = {}
    pending_writes: list[tuple[pd.DataFrame, Path, str]] = []
    start = DEFAULT_START_DATE
    end = date.today()
    for report in build_reports(start, end):
        date_col = "发行日期" if report.name == "债券发行明细" else "开始日期"
        existing = _clean_existing_report(read_existing_report(report), date_col)
        report_warnings: list[str] = []
        try:
            if report.name == "债券发行明细":
                new_df = _fetch_issue_detail_increment(report, existing, start, end)
                merged = _merge_reports(existing, new_df, ["代码"], "发行日期")
                merged = _fill_issue_spreads(
                    merged,
                    existing,
                    warnings_out=report_warnings,
                )
                if not merged.empty:
                    merged["序号"] = range(1, len(merged) + 1)
                merged = merged.reindex(columns=ISSUE_DETAIL_COLUMNS)
            else:
                new_df = _fetch_statistics_increment(report, existing, start, end)
                merged = _merge_reports(
                    existing,
                    new_df,
                    ["开始日期", "截止日期"],
                    "开始日期",
                )
                merged = merged.reindex(columns=ISSUE_STATISTICS_COLUMNS)
        except ChoiceAPIError as exc:
            output[report.name] = ChoiceBondResult(
                dataframe=existing,
                source="existing",
                warning=str(exc),
            )
            continue

        pending_writes.append((merged, report.output_path, report.name))
        source = "data-api+existing" if not existing.empty else "data-api"
        output[report.name] = ChoiceBondResult(
            dataframe=merged,
            source=source,
            warning="; ".join(report_warnings) or None,
        )
    for df, path, sheet_name in pending_writes:
        write_report(df, path, sheet_name)
    return output
