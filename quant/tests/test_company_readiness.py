import unittest

import pandas as pd

from model.scoring import compute_company_readiness


class CompanyReadinessTest(unittest.TestCase):
    """All metric observations in this fixture are synthetic."""

    def setUp(self):
        self.proprietary = pd.DataFrame(
            {
                "ef_lcr": [1.25, 1.75],
                "ef_nsfr": [1.05, 1.15],
                "ef_lcr_pctile_60d": [0.25, 0.75],
                "ef_nsfr_pctile_60d": [0.35, 0.85],
                "ef_margin_zscore_60d": [0.0, 0.1],
                "ef_funding_gap": [-120.0, 80.0],
                "ef_funding_pressure": [1.0, 0.0],
            },
            index=pd.to_datetime(["2024-01-01", "2024-01-03"]),
        )

    def test_uses_latest_available_row_before_target(self):
        result = compute_company_readiness(
            self.proprietary, target_date=pd.Timestamp("2024-01-02")
        )

        self.assertEqual(result["date"], "2024-01-01")
        self.assertEqual(result["ef_lcr"], 1.25)
        self.assertEqual(result["ef_nsfr"], 1.05)
        self.assertEqual(result["readiness_label"], "偏紧")
        self.assertIn("建议近期安排融资", result["interpretation"])
        self.assertNotIn("资金缺口", result["interpretation"])

    def test_subject_spread_uses_strict_prior_history(self):
        spread = pd.DataFrame(
            {"ef_subject_spread_bp": [12.0, 24.0, 18.0]},
            index=pd.to_datetime(["2024-01-01", "2024-01-02", "2024-01-03"]),
        )

        result = compute_company_readiness(
            self.proprietary,
            target_date=pd.Timestamp("2024-01-03"),
            subject_spread_df=spread,
        )

        self.assertEqual(result["ef_subject_spread_bp"], 18.0)
        self.assertEqual(result["ef_subject_spread_pctile"], 0.5)
        self.assertEqual(result["ef_subject_spread_date"], "2024-01-03")

    def test_returns_empty_when_no_historical_business_row(self):
        result = compute_company_readiness(
            self.proprietary, target_date=pd.Timestamp("2023-12-31")
        )

        self.assertEqual(result, {})


if __name__ == "__main__":
    unittest.main()
