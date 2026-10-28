import unittest
from unittest.mock import Mock, patch

import pandas as pd

from data.online_inputs import (
    source_frame,
    build_online_dataset,
    _align_market_frame,
    _issuer_history,
    QUERIES,
)


class OnlineInputsTest(unittest.TestCase):
    def test_issuer_date_partitions_preserve_nulls_and_exact_boundaries(self):
        connection = Mock()
        with patch(
            "data.online_inputs._read_rows",
            side_effect=[[], [{"date": "2020-01-02", "yield_slope": None}]],
        ) as read:
            rows = _issuer_history(connection, "2020-06-01")
        self.assertEqual(rows, [{"date": "2020-01-02", "yield_slope": None}])
        self.assertEqual(read.call_args_list[0].args[2], ("2020-01-01", "2019-01-01"))
        self.assertEqual(read.call_args_list[1].args[2], ("2020-06-01", "2020-01-01"))
        self.assertEqual(read.call_count, 2)
        self.assertEqual(
            read.call_args_list[0].args[1],
            QUERIES["issuer_daily_rows"].replace("$1", "%s").replace("$2", "%s"),
        )

    def test_issuer_partition_failure_does_not_return_partial_history(self):
        with patch(
            "data.online_inputs._read_rows",
            side_effect=[[{"date": "2019-01-02"}], ConnectionError("read failed")],
        ) as read:
            with self.assertRaisesRegex(ConnectionError, "read failed"):
                _issuer_history(Mock(), "2020-06-01")
        self.assertEqual(read.call_count, 2)

    def test_missing_primary_flow_is_not_a_carried_market_level(self):
        dates = pd.date_range("2026-01-01", periods=4)
        frame = pd.DataFrame({"supply": [7.0, float("nan"), 0.0]}, index=dates[:3])
        result = _align_market_frame("primary_bond", frame, dates)
        self.assertEqual(result.loc[dates[0], "supply"], 7)
        self.assertTrue(pd.isna(result.loc[dates[1], "supply"]))
        self.assertEqual(result.loc[dates[2], "supply"], 0)
        self.assertTrue(pd.isna(result.loc[dates[3], "supply"]))
        levels = _align_market_frame("funding", frame, dates)
        self.assertEqual(levels.loc[dates[1], "supply"], 7)

    def test_macro_uses_release_date_and_old_revision_does_not_replace_latest_period(
        self,
    ):
        rows = [
            {
                "field": "EMM00000012",
                "observation_date": "2026-03-01",
                "published_date": "2026-04-15",
                "value": 5.1,
            },
            {
                "field": "EMM00000012",
                "observation_date": "2026-06-01",
                "published_date": "2026-07-15",
                "value": 5.0,
            },
            {
                "field": "EMM00000012",
                "observation_date": "2025-12-01",
                "published_date": "2026-08-01",
                "value": 5.4,
            },
        ]
        result = source_frame("macro", rows)
        self.assertEqual(result["GDP"].dropna().tolist(), [5.1, 5.0])
        self.assertEqual(result.index.max(), pd.Timestamp("2026-07-15"))
        with self.assertRaisesRegex(ValueError, "发布日期"):
            source_frame("macro", [{**rows[0], "published_date": None}])

    def test_issue_tenor_text_and_required_field_missing(self):
        fields = {
            "ISSUER_NAME": "合成主体",
            "ISSUER_RATING": "AAA",
            "BOND_EXPIRE_YEAR": "5年",
            "ISSUERATE_REFERENCE": 2.0,
            "ACTUAL_ISSUE_SCALE": 10,
            "BOND_TYPE": "证券公司债",
            "IS_OEB": "否",
            "ISSUECREDITSPREAD": 15,
        }
        rows = [
            {
                "field": k,
                "observation_date": "2026-09-01",
                "entity_key": "synthetic",
                "value": v,
            }
            for k, v in fields.items()
        ]
        result = source_frame("issue", rows)
        self.assertEqual(result.iloc[0]["tenor"], 5)
        self.assertTrue(
            source_frame(
                "issue", [r for r in rows if r["field"] != "ISSUERATE_REFERENCE"]
            ).empty
        )

    def test_empty_online_data_fails_without_excel_fallback(self):
        with patch(
            "pandas.read_excel", side_effect=AssertionError("Excel must not be read")
        ):
            with self.assertRaisesRegex(ValueError, "线上输入为空"):
                build_online_dataset({"datasets": {"funding": []}})
