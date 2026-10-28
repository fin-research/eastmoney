import unittest

import numpy as np
import pandas as pd

from data.issuer_spread import balance_weighted_issuer_spread


class IssuerSpreadTest(unittest.TestCase):
    def setUp(self):
        self.bonds = pd.DataFrame(
            {
                "date": ["2025-01-02"] * 2,
                "code": ["A", "B"],
                "balance": [100.0, 300.0],
                "yield_pct": [2.1, 2.8],
                "remaining_years": [1.0, 2.0],
            }
        )
        self.curves = pd.DataFrame(
            {
                "date": ["2025-01-02"] * 2,
                "tenor_years": [1.0, 3.0],
                "yield_pct": [2.0, 3.0],
            }
        )

    def test_tenor_matching_then_balance_weighting(self):
        daily, details = balance_weighted_issuer_spread(self.bonds, self.curves)
        # Individual spreads 10 and 30bp, weighted 1:3 -> 25bp.
        self.assertAlmostEqual(daily.issuer_spread_bp.iloc[0], 25)
        self.assertAlmostEqual(daily.synthetic_target_yield_pct.iloc[0], 3.25)
        self.assertEqual(details.industry_yield_pct.tolist(), [2, 2.5])
        # Common balance units cancel in normalized weights.
        scaled = self.bonds.assign(balance=self.bonds.balance * 1e8)
        other, _ = balance_weighted_issuer_spread(scaled, self.curves)
        self.assertAlmostEqual(other.issuer_spread_bp.iloc[0], 25)

    def test_missing_valuation_does_not_shrink_denominator(self):
        self.bonds.loc[1, "yield_pct"] = np.nan
        daily, _ = balance_weighted_issuer_spread(self.bonds, self.curves)
        self.assertEqual(daily.known_balance_coverage.iloc[0], 0.25)
        self.assertTrue(np.isnan(daily.issuer_spread_bp.iloc[0]))
        self.assertAlmostEqual(daily.partial_spread_bp.iloc[0], 10)

    def test_unknown_balance_differs_from_redeemed_bond(self):
        self.bonds.loc[1, "balance"] = np.nan
        unknown, _ = balance_weighted_issuer_spread(self.bonds, self.curves)
        self.assertFalse(unknown.complete.iloc[0])
        self.bonds.loc[1, "balance"] = 0
        redeemed, _ = balance_weighted_issuer_spread(self.bonds, self.curves)
        self.assertTrue(redeemed.complete.iloc[0])
        self.assertAlmostEqual(redeemed.issuer_spread_bp.iloc[0], 10)

    def test_no_tenor_extrapolation_or_future_curve_fill(self):
        self.bonds.loc[1, "remaining_years"] = 4
        daily, _ = balance_weighted_issuer_spread(self.bonds, self.curves)
        self.assertFalse(daily.complete.iloc[0])
        future = self.curves.assign(date="2025-01-03", yield_pct=50)
        added, _ = balance_weighted_issuer_spread(
            self.bonds, pd.concat([self.curves, future])
        )
        pd.testing.assert_frame_equal(daily, added)
        absent, _ = balance_weighted_issuer_spread(self.bonds, future)
        self.assertEqual(absent.covered_bonds.iloc[0], 0)

    def test_duplicate_keys_and_negative_balances_rejected(self):
        with self.assertRaises(ValueError):
            balance_weighted_issuer_spread(
                pd.concat([self.bonds, self.bonds]), self.curves
            )
        with self.assertRaises(ValueError):
            balance_weighted_issuer_spread(
                self.bonds, pd.concat([self.curves, self.curves])
            )
        with self.assertRaises(ValueError):
            balance_weighted_issuer_spread(self.bonds.assign(balance=-1), self.curves)
