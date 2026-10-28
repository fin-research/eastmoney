import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import pandas as pd

from choice.data_api import ChoiceResult
from data.choice_bond_data import (
    ISSUE_STATISTICS_INDICATORS,
    ChoiceBondReport,
    _fetch_issue_spreads,
    update_choice_bond_data,
)


class FetchIssueSpreadsTest(unittest.TestCase):
    @patch("data.choice_bond_data.css")
    def test_invalid_code_is_isolated_without_losing_valid_spreads(self, call_api):
        def fake_css(codes, indicator, options):
            requested = codes.split(",")
            if "BAD.SH" in requested:
                return ChoiceResult(10003008, "invalid stock code")
            return ChoiceResult(
                0,
                "success",
                function="CSS",
                fields=("code", "ISSUECREDITSPREAD"),
                rows=tuple(
                    {
                        "code": code,
                        "ISSUECREDITSPREAD": float(index + 1),
                    }
                    for index, code in enumerate(requested)
                ),
            )

        call_api.side_effect = fake_css
        invalid_codes = []

        spreads = _fetch_issue_spreads(
            ["GOOD1.SH", "BAD.SH", "GOOD2.SH"],
            invalid_codes=invalid_codes,
        )

        self.assertEqual(set(spreads), {"GOOD1.SH", "GOOD2.SH"})
        self.assertEqual(invalid_codes, ["BAD.SH"])


class IssueStatisticsTest(unittest.TestCase):
    def test_failed_or_empty_increment_preserves_workbook_without_zero_rows(self):
        for result in (
            ChoiceResult(10000009, "no data"),
            ChoiceResult(0, "success", function="CTR"),
            ChoiceResult(10001003, "permission denied"),
        ):
            with self.subTest(result=result), TemporaryDirectory() as directory:
                path = Path(directory) / "statistics.xlsx"
                existing = pd.DataFrame(
                    {
                        "开始日期": ["2026-01-01"],
                        "截止日期": ["2026-01-01"],
                        "发行只数(只)": [1],
                        "加权融资成本(%)": [2.1],
                    }
                )
                existing.to_excel(
                    path, sheet_name="发行与到期统计表(债券口径)", index=False
                )
                before = path.read_bytes()
                report = ChoiceBondReport(
                    "发行与到期统计表(债券口径)",
                    "BondIssueStatistics",
                    path,
                    "",
                    ISSUE_STATISTICS_INDICATORS,
                )
                with (
                    patch("data.choice_bond_data.build_reports", return_value=[report]),
                    patch("data.choice_bond_data.ctr", return_value=result) as request,
                    patch("data.choice_bond_data.write_report") as write,
                ):
                    updated = update_choice_bond_data()[report.name]
                self.assertEqual(updated.source, "existing")
                self.assertIsNotNone(updated.warning)
                self.assertEqual(len(updated.dataframe), 1)
                self.assertEqual(updated.dataframe.iloc[0]["发行只数(只)"], 1)
                request.assert_called_once()
                write.assert_not_called()
                self.assertEqual(path.read_bytes(), before)

    def test_explicit_source_zero_keeps_repayment_and_missing_cost(self):
        from data.choice_bond_data import _fetch_statistics_increment, build_reports

        fields = tuple(ISSUE_STATISTICS_INDICATORS.split(","))
        row = dict.fromkeys(fields, 0)
        row.update(
            START_DATE="2026-01-02",
            END_DATE="2026-01-02",
            WEIGHTED_COST=None,
            TOTAL_REPAY_AMT=-12,
            TOTAL_REPAY_NUM=2,
        )
        result = ChoiceResult(0, "success", function="CTR", fields=fields, rows=(row,))
        with patch("data.choice_bond_data.ctr", return_value=result) as request:
            data = _fetch_statistics_increment(
                build_reports("2026-01-02", "2026-01-02")[1],
                pd.DataFrame(),
                "2026-01-02",
                "2026-01-02",
            )
        self.assertEqual(len(data), 1)
        self.assertEqual(data.iloc[0]["发行只数(只)"], 0)
        self.assertEqual(data.iloc[0]["偿还总额(亿)"], 12)
        self.assertEqual(data.iloc[0]["偿还只数(只)"], 2)
        self.assertTrue(pd.isna(data.iloc[0]["加权融资成本(%)"]))
        request.assert_called_once()


if __name__ == "__main__":
    unittest.main()
