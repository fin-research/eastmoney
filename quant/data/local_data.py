"""本地业务数据刷新与融资成本诊断，作为统一数据 pipeline 的一部分。"""

import re
from datetime import date

import numpy as np
import pandas as pd

from .data import DATA_DIR

BUSINESS_SOURCE_FILE = DATA_DIR / "东方财富证券自有资金计划表.xlsx"
BUSINESS_OUTPUT_FILE = DATA_DIR / "业务数据.xlsx"
ISSUE_DETAIL_FILE = DATA_DIR / "债券发行明细.xlsx"
BUSINESS_SHEET = "两融规模与流动性指标"


def _clean_date_index(frame: pd.DataFrame) -> pd.DataFrame:
    output = frame[pd.to_datetime(frame.index, errors="coerce").notna()].copy()
    output.index = pd.to_datetime(output.index)
    return output.sort_index()


def _business_data_frame(
    start: date = date(2019, 1, 1),
    end: date | None = None,
) -> pd.DataFrame:
    end = end or date.today()
    keywords = "资金缺口|融资规模|融券规模"
    funding = pd.read_excel(
        BUSINESS_SOURCE_FILE,
        sheet_name="月度资金计划",
        header=[1, 2],
        index_col=0,
        engine="calamine",
    ).filter(regex=keywords)
    funding = _clean_date_index(funding)
    funding.columns = ["_".join(column).strip() for column in funding.columns]
    funding.columns = [
        match.group(0) if (match := re.search(keywords, column)) else column
        for column in funding.columns
    ]
    funding["两融规模"] = funding["融资规模"] + funding["融券规模"]
    funding = funding.drop(columns=["融资规模", "融券规模"])

    liquidity = pd.read_excel(
        BUSINESS_SOURCE_FILE,
        sheet_name=BUSINESS_SHEET,
        header=2,
        index_col=1,
        engine="calamine",
    ).filter(items=["流动性覆盖率", "净稳定资金率"])
    liquidity = _clean_date_index(liquidity)

    output = liquidity.join(funding)
    output = output.rename(columns={"资金缺口": "资金缺口(1M)"})
    return output[
        (output.index >= pd.Timestamp(start)) & (output.index < pd.Timestamp(end))
    ]


def refresh_business_data() -> pd.DataFrame:
    """从自有资金计划表刷新模型使用的业务数据工作簿。"""
    frame = _business_data_frame()
    with pd.ExcelWriter(
        BUSINESS_OUTPUT_FILE,
        engine="xlsxwriter",
        datetime_format="yyyy-mm-dd",
        date_format="yyyy-mm-dd",
    ) as writer:
        frame.to_excel(writer, sheet_name=BUSINESS_SHEET, index=True)
        workbook = writer.book
        workbook.formats[0].set_font_name("微软雅黑")
        worksheet = writer.sheets[BUSINESS_SHEET]
        worksheet.set_zoom(150)
        header_format = workbook.add_format(
            {
                "bold": True,
                "bg_color": "#D9EAF7",
                "border": 1,
                "align": "center",
                "font_name": "微软雅黑",
            }
        )
        worksheet.write(0, 0, "日期", header_format)
        for column_number, value in enumerate(frame.columns, start=1):
            worksheet.write(0, column_number, value, header_format)
        worksheet.set_column(
            "A:A",
            12,
            workbook.add_format(
                {
                    "num_format": "yyyy-mm-dd",
                    "align": "center",
                    "font_name": "微软雅黑",
                }
            ),
        )
        worksheet.set_column(
            "B:C",
            12,
            workbook.add_format({"num_format": "0.00%", "font_name": "微软雅黑"}),
        )
        worksheet.set_column(
            "D:E",
            12,
            workbook.add_format({"num_format": "#,##0.00", "font_name": "微软雅黑"}),
        )
        worksheet.freeze_panes(1, 0)
    return frame


def _weighted_coupon(frame: pd.DataFrame) -> float:
    if frame.empty or frame["issue_size"].sum() == 0:
        return float("nan")
    return float(
        (frame["coupon"] * frame["issue_size"]).sum() / frame["issue_size"].sum()
    )


def financing_cost_summary() -> dict[str, float]:
    """基于更新后的发行明细计算全市场与我司加权融资成本。"""
    frame = pd.read_excel(
        ISSUE_DETAIL_FILE,
        header=0,
        engine="calamine",
    ).rename(
        columns={
            "发行日期": "issue_date",
            "发行人名称": "issuer",
            "票面利率(发行参考)(%)": "coupon",
            "发行总额(亿)": "issue_size",
            "债券类型": "bond_type",
        }
    )
    frame["issue_date"] = pd.to_datetime(frame["issue_date"], errors="coerce")
    frame["coupon"] = pd.to_numeric(frame["coupon"], errors="coerce")
    frame["issue_size"] = pd.to_numeric(frame["issue_size"], errors="coerce")
    frame = frame.dropna(subset=["coupon", "issue_size"])
    company = frame["issuer"].fillna("").str.startswith("东方财富")
    exchange = frame["bond_type"].fillna("").str.contains("债")
    commercial_paper = frame["bond_type"].fillna("").str.contains("短期融资券")
    recent = frame["issue_date"] >= pd.Timestamp.today().normalize() - pd.DateOffset(
        years=2
    )

    return {
        "exchange_all": _weighted_coupon(frame[exchange]),
        "exchange_company": _weighted_coupon(frame[exchange & company]),
        "commercial_paper_all": _weighted_coupon(frame[commercial_paper]),
        "commercial_paper_company": _weighted_coupon(frame[commercial_paper & company]),
        "recent_exchange_all": _weighted_coupon(frame[recent & exchange]),
        "recent_exchange_company": _weighted_coupon(frame[recent & exchange & company]),
        "recent_commercial_paper_all": _weighted_coupon(
            frame[recent & commercial_paper]
        ),
        "recent_commercial_paper_company": _weighted_coupon(
            frame[recent & commercial_paper & company]
        ),
    }


def _format_cost(value: float) -> str:
    return "NA" if np.isnan(value) else f"{value:.2f}%"


def print_financing_cost_summary() -> dict[str, float]:
    summary = financing_cost_summary()
    print("[INFO] 融资成本诊断（全历史 / 近两年）")
    print(
        "       交易所债券: "
        f"全市场 {_format_cost(summary['exchange_all'])} / "
        f"我司 {_format_cost(summary['exchange_company'])}; "
        f"近两年全市场 {_format_cost(summary['recent_exchange_all'])} / "
        f"我司 {_format_cost(summary['recent_exchange_company'])}"
    )
    print(
        "       短融: "
        f"全市场 {_format_cost(summary['commercial_paper_all'])} / "
        f"我司 {_format_cost(summary['commercial_paper_company'])}; "
        f"近两年全市场 {_format_cost(summary['recent_commercial_paper_all'])} / "
        f"我司 {_format_cost(summary['recent_commercial_paper_company'])}"
    )
    return summary


def refresh_local_data() -> None:
    business = refresh_business_data()
    latest = business.index.max()
    print(
        f"[INFO] 业务数据: {len(business)} 行，"
        f"最新日期 {latest.strftime('%Y-%m-%d')}（本地资金计划表）"
    )
    print_financing_cost_summary()
