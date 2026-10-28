"""权益工作表标准化与公共特征接口测试。"""

import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from data import (
    MARGIN_EQUITY_FEATURES,
    build_equity_features,
    build_margin_equity_features,
    load_equity_features,
    load_equity_market_data,
)


def _write_equity_workbook(path: Path, rows: int = 80) -> pd.DatetimeIndex:
    dates = pd.bdate_range("2025-01-02", periods=rows)
    step = np.arange(rows, dtype=float)
    records = [
        [
            "历史行情",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            "历史行情",
            None,
            None,
            None,
            None,
            None,
        ],
        [
            None,
            "000001.SH",
            "399001.SZ",
            "000300.SH",
            "000852.SH",
            "399006.SZ",
            "000688.SH",
            "800004.EI",
            "VIX.GI",
            None,
            "800004.EI",
            "800004.EI",
            "800004.EI",
            "800004.EI",
            "800004.EI",
        ],
        [
            None,
            "上证指数",
            "深证成指",
            "沪深300",
            "中证1000",
            "创业板指",
            "科创50",
            "东方财富全A(沪深京)",
            "恐慌指数",
            None,
            "东方财富全A(沪深京)",
            "东方财富全A(沪深京)",
            "东方财富全A(沪深京)",
            "东方财富全A(沪深京)",
            "东方财富全A(沪深京)",
        ],
        [
            None,
            "收盘价",
            "收盘价",
            "收盘价",
            "收盘价",
            "收盘价",
            "收盘价",
            "收盘价",
            "收盘价",
            None,
            "总市值",
            "市盈率PE(TTM)|【剔除规则】不调整",
            "成交金额",
            "换手率",
            "股债性价比(差值)|【股票预期收益率】1/市盈率(%)",
        ],
    ]
    for offset in range(rows - 1, -1, -1):
        value = step[offset]
        records.append(
            [
                dates[offset],
                3000 + value,
                10000 + value,
                4000 + value,
                5000 + value,
                2500 + value,
                1000 + value,
                4500 + value,
                15 + value / 100,
                dates[offset],
                1e14 + value,
                15 + value / 100,
                1e12 + value,
                1 + value / 100,
                2 + value / 100,
            ]
        )
    records.extend([[None] * 15, ["数据来源：妙想Choice"] + [None] * 14])
    with pd.ExcelWriter(path) as writer:
        pd.DataFrame(records).to_excel(
            writer,
            sheet_name="权益数据",
            header=False,
            index=False,
        )
    return dates


class EquityDataTest(unittest.TestCase):
    def test_loads_two_date_blocks_into_standard_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.xlsx"
            dates = _write_equity_workbook(path)

            result = load_equity_market_data(path)

        self.assertEqual(result.index.tolist(), dates.tolist())
        self.assertEqual(result.index.name, "date")
        self.assertAlmostEqual(result.iloc[-1]["csi300_close"], 4079.0)
        self.assertAlmostEqual(result.iloc[-1]["all_a_turnover_rate"], 1.79)
        self.assertAlmostEqual(result.iloc[-1]["equity_bond_spread"], 2.79)
        self.assertEqual(result.attrs["equity_bond_caliber"], "spread")
        self.assertNotIn("erp", result.columns)

    def test_shared_features_use_all_a_caliber_and_stable_names(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.xlsx"
            _write_equity_workbook(path)

            raw = load_equity_market_data(path)
            built = build_equity_features(raw)
            loaded = load_equity_features(path)

        pd.testing.assert_frame_equal(built, loaded)
        self.assertEqual(built.iloc[-1]["turnover_rate"], 1.79)
        self.assertEqual(built.iloc[-1]["equity_bond_spread"], 2.79)
        self.assertEqual(built.attrs["equity_bond_caliber"], "spread")
        self.assertNotIn("erp", built.columns)
        self.assertTrue(pd.notna(built.iloc[-1]["csi300_ret_60d"]))
        self.assertTrue(pd.notna(built.iloc[-1]["vix_pctile_60d"]))

    def test_margin_equity_extension_is_separate_and_numeric(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.xlsx"
            _write_equity_workbook(path)
            raw = load_equity_market_data(path)

            result = build_margin_equity_features(raw)

        self.assertEqual(tuple(result.columns), MARGIN_EQUITY_FEATURES)
        self.assertTrue(result.dtypes.map(pd.api.types.is_numeric_dtype).all())
        self.assertTrue(pd.notna(result.iloc[-1]["all_a_ret_20d"]))
        self.assertTrue(pd.notna(result.iloc[-1]["growth_proxy_ret_20d"]))
        self.assertTrue(pd.notna(result.iloc[-1]["all_a_turnover_log_z_60d"]))


if __name__ == "__main__":
    unittest.main()
