import unittest

import numpy as np
import pandas as pd

from data.coupon_quotes import QUOTE_COLUMNS, coupon_quote_features
from data.issuance_industry_tenor import AAA_CURVE_CODE
from model.issuance_unified import CouponCandidate, CouponModel


class CouponQuoteTests(unittest.TestCase):
    def test_raw_history_tenor_fit_and_future_isolation(self):
        dates = pd.date_range("2026-01-01", periods=25, freq="B")
        nodes = pd.DataFrame(
            [
                {
                    "curve_code": AAA_CURVE_CODE,
                    "observation_date": d,
                    "tenor_years": t,
                    "yield_pct": 1.5 + t / 10 + i / 100,
                }
                for i, d in enumerate(dates)
                for t in (1, 3, 5, 7, 10)
            ]
        )
        secondary = pd.DataFrame(
            [
                {
                    "date": d,
                    "issuer": "A",
                    "bond_type": "证券公司债",
                    "placement_type": "公募",
                    "yield_slope": 0.1,
                    "yield_intercept": 1.0 + i / 100,
                    "min_tenor": 1.0,
                    "max_tenor": 5.0,
                }
                for i, d in enumerate(dates)
            ]
        )
        request = pd.DataFrame(
            [
                {
                    "origin": dates[22],
                    "tenor": 3.0,
                    "issuer": "A",
                    "bond_type": "证券公司债",
                    "placement_type": "公募",
                }
            ]
        )
        f = coupon_quote_features(request, dates, nodes, secondary)
        self.assertAlmostEqual(f.sector_quote_lag_0_bp.iloc[0], 201.0)
        self.assertAlmostEqual(f.issuer_quote_lag_0_bp.iloc[0], 151.0)
        self.assertAlmostEqual(f.sector_quote_lag_19_bp.iloc[0], 182.0)
        nodes.loc[nodes.observation_date >= dates[22], "yield_pct"] = 90
        secondary.loc[secondary.date >= dates[22], "yield_intercept"] = 90
        pd.testing.assert_frame_equal(
            f, coupon_quote_features(request, dates, nodes, secondary)
        )
        request["tenor"] = 7.0
        uncovered = coupon_quote_features(request, dates, nodes, secondary)
        self.assertTrue(uncovered.issuer_quote_lag_0_bp.isna().all())

    def test_missing_exact_node_and_whole_day_remain_missing(self):
        dates = pd.date_range("2026-01-01", periods=3, freq="B")
        nodes = pd.DataFrame(
            [
                {"observation_date": dates[0], "tenor_years": 1, "yield_pct": 1.0},
                {"observation_date": dates[0], "tenor_years": 5, "yield_pct": 2.0},
            ]
        )
        request = pd.DataFrame(
            [
                dict(
                    origin=dates[1],
                    tenor=3.0,
                    issuer="A",
                    bond_type="证券公司债",
                    placement_type="公募",
                )
            ]
        )
        missing_node = coupon_quote_features(request, dates, nodes, None)
        self.assertTrue(missing_node.sector_quote_lag_0_bp.isna().all())
        request["origin"] = dates[2]
        missing_day = coupon_quote_features(request, dates, nodes, None)
        self.assertTrue(missing_day.sector_quote_lag_0_bp.isna().all())

    def test_model_learns_history_effect_without_direction_constraint(self):
        rng = np.random.default_rng(42)
        n = 120
        current = rng.normal(220, 10, n)
        previous = current + rng.normal(0, 10, n)
        features = pd.DataFrame({name: current for name in QUOTE_COLUMNS})
        features["sector_quote_lag_1_bp"] = previous
        features = features.assign(
            tenor=3.0,
            issue_size=20.0,
            known_treasury_bp=180.0,
            lead_days=1,
            issuer="A",
            rating="AAA",
            bond_type="证券公司债",
            placement_type="公募",
        )
        requests = features.assign(
            bond_code=[str(i) for i in range(n)],
            pricing_date=pd.Timestamp("2025-01-01"),
            label_available_date=pd.Timestamp("2025-01-02"),
            origin=pd.Timestamp("2024-12-31"),
            coupon_bp=current + 0.8 * (current - previous),
        )
        model = CouponModel(
            CouponCandidate("ridge", "coupon", 3, feature_set="quote_history")
        ).fit(features, requests, "2026-01-01")
        a = features.iloc[:1].copy()
        b = a.copy()
        a["sector_quote_lag_1_bp"] = a.sector_quote_lag_0_bp + 10
        b["sector_quote_lag_1_bp"] = b.sector_quote_lag_0_bp - 10
        self.assertLess(model.predict(a)[0], model.predict(b)[0])
        np.testing.assert_allclose(model.contributions(a).sum(axis=1), model.predict(a))
        self.assertLess(model.audit["training_label_end"], "2026-01-01")
