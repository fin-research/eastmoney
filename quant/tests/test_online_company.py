import tempfile
import unittest
from pathlib import Path

import pandas as pd

from data.online_company import apply_fund_report_gap


class FundReportGapTests(unittest.TestCase):
    def test_report_gap_replaces_plan_without_future_fill_and_extends_dates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "company_report_gap.csv").write_text(
                "observation_date,value\n2026-08-25,-30\n2026-08-28,15\n"
            )
            frame = pd.DataFrame(
                {"funding_gap": [999, 999, 999], "lcr": [1.1, 1.2, 1.3]},
                index=pd.to_datetime(["2026-08-24", "2026-08-25", "2026-08-26"]),
            )
            result = apply_fund_report_gap(frame, path)
            self.assertTrue(pd.isna(result.loc["2026-08-24", "funding_gap"]))
            self.assertEqual(
                result.loc["2026-08-25":, "funding_gap"].tolist(), [-30, -30, 15]
            )
            self.assertEqual(result.loc["2026-08-28", "lcr"], 1.3)
            self.assertEqual(frame["funding_gap"].tolist(), [999, 999, 999])

    def test_missing_cache_cannot_silently_use_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError):
                apply_fund_report_gap(pd.DataFrame(), Path(directory))
