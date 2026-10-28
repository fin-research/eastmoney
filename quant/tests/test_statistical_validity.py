import unittest

import numpy as np
import pandas as pd

from model.statistical_validity import (
    paired_block_test,
    holm_adjust,
    coupon_validity,
    policy_validity,
)
from model.rate_forecast import RATE_CANDIDATES, candidate_training_index


class StatisticalValidityTest(unittest.TestCase):
    def test_recent_window_fallback_keeps_maturity_and_sample_floor(self):
        dates = pd.bdate_range("2022-01-01", "2025-01-01")
        labels = pd.DataFrame(
            {
                "label_end": dates + pd.Timedelta(days=30),
                "deadline": dates + pd.Timedelta(days=30),
            },
            index=dates,
        )
        cutoff = pd.Timestamp("2025-01-01")
        # The synthetic weekday calendar otherwise has no exchange holidays
        # and still contains >=240 mature rows in one year. Remove ten observed
        # sessions so this fixture actually exercises the sparse-year branch.
        labels = labels.drop(labels.loc["2024-01-01":"2024-01-31"].index[:10])
        candidate = next(c for c in RATE_CANDIDATES if c.name == "recent_drift")
        selected = candidate_training_index(labels, cutoff, candidate)
        self.assertGreaterEqual(len(selected), 240)
        self.assertTrue((labels.loc[selected, "deadline"] < cutoff).all())
        self.assertLess(selected.min(), cutoff - pd.DateOffset(years=1))

    def test_policy_requires_identical_origins_before_nonoverlap_selection(self):
        frame = pd.DataFrame(
            [
                {
                    "candidate": name,
                    "origin": pd.Timestamp(date),
                    "deadline": pd.Timestamp(date) + pd.Timedelta(days=30),
                    "saving_vs_immediate_bp": 1.0,
                    "saving_vs_deadline_bp": 0.0,
                }
                for name, date in (
                    ("A", "2024-01-01"),
                    ("A", "2024-03-01"),
                    ("B", "2024-01-01"),
                )
            ]
        )
        with self.assertRaisesRegex(ValueError, "identical origins"):
            policy_validity(frame)

    def test_paired_null_and_alternative_have_correct_direction(self):
        null = paired_block_test(np.zeros(100), block_size=10, repetitions=999)
        self.assertEqual(null["p_one_sided"], 1)
        self.assertEqual(null["low95_bp"], 0)
        positive = paired_block_test(np.full(100, 2.0), block_size=10, repetitions=999)
        self.assertEqual(positive["p_one_sided"], 0.001)
        self.assertEqual(positive["low95_bp"], 2)
        negative = paired_block_test(np.full(100, -2.0), block_size=10, repetitions=999)
        self.assertEqual(negative["p_one_sided"], 1)
        self.assertEqual(
            paired_block_test([1, 2], block_size=3)["status"], "insufficient_blocks"
        )
        with self.assertRaisesRegex(ValueError, "complete finite"):
            paired_block_test([1, np.nan])

    def test_holm_controls_full_family_including_untestable_member(self):
        np.testing.assert_allclose(holm_adjust([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06])
        np.testing.assert_allclose(
            holm_adjust([0.01, np.nan, 0.03]), [0.03, np.nan, 0.06], equal_nan=True
        )

    def test_coupon_origins_are_clustered_not_independent_and_missing_is_error(self):
        rows = []
        for event in range(9):
            date = pd.Timestamp("2024-01-01") + pd.Timedelta(days=45 * event)
            for lead in range(1, 31):
                for name in ("random_walk", "historical_drift", "lgb_anchor_drift"):
                    rows.append(
                        {
                            "candidate": name,
                            "issuer": "A",
                            "pricing_date": date,
                            "as_of": date - pd.Timedelta(days=lead),
                            "bond_code": str(event),
                            "date_basis": "issue_date",
                            "status": "estimated",
                            "error_bp": 1.0 if name == "lgb_anchor_drift" else 2.0,
                        }
                    )
        frame = pd.DataFrame(rows)
        result = coupon_validity(frame)
        self.assertTrue(result.samples.eq(9).all())
        self.assertTrue(result.block_size.eq(3).all())
        self.assertTrue(result.status.eq("insufficient_blocks").all())
        self.assertTrue(result.p_one_sided.isna().all())
        with self.assertRaisesRegex(ValueError, "identical candidate coverage"):
            coupon_validity(frame.iloc[1:])


if __name__ == "__main__":
    unittest.main()
