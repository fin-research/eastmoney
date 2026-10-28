"""AAA sector curve context uses only an exact prior quote and tenor bracket."""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import numpy as np
import pandas as pd

from data.issuance_industry_tenor import (
    AAA_CURVE_CODE,
    INDUSTRY_TENOR_COLUMNS,
    industry_tenor_features,
    prepare_industry_nodes,
)
from model.export import write_json
from model.issuance_unified import CouponCandidate, CouponModel
from tests.test_unified_coupon import sample_panel


class IndustryTenorTests(unittest.TestCase):
    def test_candidate_rejects_missing_nodes(self):
        panel = sample_panel()
        requests = panel.requests((30,))
        features = panel.features(requests, include_industry_tenor=True)
        candidate = CouponCandidate("ridge", "excess", 3, feature_set="industry_tenor")
        with self.assertRaisesRegex(ValueError, "no dated AAA nodes"):
            CouponModel(candidate).fit(features, requests, "2025-09-01")

    def test_no_issuer_category_keeps_shared_numeric_history_and_js_order(self):
        panel = sample_panel()
        panel.industry_nodes = prepare_industry_nodes(
            [
                dict(
                    curve_code=AAA_CURVE_CODE,
                    observation_date=date.date().isoformat(),
                    tenor_years=term,
                    yield_pct=value,
                )
                for date in panel.rates.market_features.index
                for term, value in ((1.0, 2.4), (3.0, 2.7), (5.0, 3.0))
            ]
        )
        requests = panel.requests((30,))
        features = panel.features(
            requests, include_industry_tenor=True, include_weighted_primary=True
        )
        candidate = CouponCandidate(
            "ridge", "excess", 3, feature_set="combined_no_issuer"
        )
        model = CouponModel(candidate).fit(features, requests, "2025-09-01")
        self.assertNotIn("issuer", model.feature_names)
        self.assertIn("issuer_weighted_premium_bp", model.feature_names)
        sample = features.iloc[-1:].copy()
        expected = model.encode(sample).iloc[0].to_numpy()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "case.json"
            write_json(
                path,
                {"model": model.export(), "feature": sample.iloc[0].to_dict()},
            )
            script = """import fs from 'node:fs';
import {encodeCoupon} from './online/coupon-model.mjs';
const x=JSON.parse(fs.readFileSync(process.argv[1]));
console.log(JSON.stringify(encodeCoupon(x.model,x.feature)));"""
            actual = json.loads(
                subprocess.check_output(
                    ["node", "--input-type=module", "-e", script, str(path)],
                    cwd=Path(__file__).resolve().parents[1],
                    text=True,
                )
            )
        np.testing.assert_allclose(
            [np.nan if value is None else value for value in actual],
            expected,
            atol=1e-8,
            equal_nan=True,
        )

    def test_exact_prior_quote_interpolation_missing_and_future_invariance(self):
        rows = [
            dict(
                curve_code=AAA_CURVE_CODE,
                observation_date="2024-05-31",
                tenor_years=term,
                yield_pct=value,
            )
            for term, value in ((3, 2.5), (5, 2.8), (7, 3.0))
        ]
        nodes = prepare_industry_nodes(rows)
        requests = pd.DataFrame(
            {
                "origin": pd.to_datetime(["2024-06-01"] * 4),
                "tenor": [4.0, 5.0, 1.0, 8.0],
            }
        )
        quotes = pd.DatetimeIndex(["2024-05-31"] * 4)
        actual = industry_tenor_features(requests, quotes, [230.0] * 4, nodes)
        self.assertAlmostEqual(actual.industry_aaa_tenor_bp.iloc[0], 265.0)
        self.assertEqual(actual.industry_aaa_minus_treasury_bp.iloc[0], 35.0)
        self.assertEqual(actual.industry_aaa_gap_years.iloc[0], 2.0)
        self.assertEqual(actual.industry_aaa_gap_years.iloc[1], 0.0)
        self.assertEqual(actual.industry_aaa_available.tolist(), [1, 1, 0, 0])
        self.assertTrue(np.isnan(actual.industry_aaa_tenor_bp.iloc[2]))
        missing = industry_tenor_features(
            requests, pd.DatetimeIndex(["2024-05-30"] * 4), [230.0] * 4, nodes
        )
        self.assertEqual(missing.industry_aaa_available.sum(), 0)
        later = prepare_industry_nodes(
            rows
            + [
                {**row, "observation_date": "2024-06-03", "yield_pct": 9.0}
                for row in rows
            ]
        )
        pd.testing.assert_frame_equal(
            actual, industry_tenor_features(requests, quotes, [230.0] * 4, later)
        )

    def test_python_js_and_legacy_feature_selection(self):
        panel = sample_panel()
        requests = panel.requests((30,))
        nodes = [
            dict(
                curve_code=AAA_CURVE_CODE,
                observation_date=date.date().isoformat(),
                tenor_years=term,
                yield_pct=value,
            )
            for date in panel.rates.market_features.index
            for term, value in ((1.0, 2.4), (3, 2.5), (5, 2.8), (7, 3.0))
        ]
        panel.industry_nodes = prepare_industry_nodes(nodes)
        features = panel.features(requests, include_industry_tenor=True)
        legacy = CouponModel(CouponCandidate("ridge", "excess", 3)).fit(
            features, requests, "2025-09-01"
        )
        industry = CouponModel(
            CouponCandidate("ridge", "excess", 3, feature_set="industry_tenor")
        ).fit(features, requests, "2025-09-01")
        self.assertFalse(set(INDUSTRY_TENOR_COLUMNS) & set(legacy.numeric))
        self.assertTrue(set(INDUSTRY_TENOR_COLUMNS).issubset(industry.numeric))

        context = {
            "calendarSpec": {"year": 2024, "closures": [], "makeup_workdays": []},
            "features": [
                dict(
                    date="2024-05-31",
                    rate_gov_1y_level=2.0,
                    rate_gov_3y_level=2.3,
                    rate_gov_10y_level=2.7,
                )
            ],
            "events": [],
            "industry_nodes": [
                row for row in nodes if row["observation_date"] == "2024-05-31"
            ],
        }
        request = dict(
            origin="2024-06-01",
            lead_days=30,
            issuer="new issuer",
            rating="AAA",
            bond_type="证券公司债",
            placement_type="公募",
            tenor=4.0,
            issue_size=20.0,
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "case.json"
            path.write_text(json.dumps({"context": context, "request": request}))
            script = """import fs from 'node:fs';
import {couponFeature} from './online/coupon-features.mjs';
const x=JSON.parse(fs.readFileSync(process.argv[1]));
const industryNodes=new Map([['2024-05-31',x.context.industry_nodes.map(r=>({tenor:r.tenor_years,yield:r.yield_pct}))]]);
console.log(JSON.stringify(couponFeature({...x.context,industryNodes,secondary:new Map()},x.request)));"""
            js = json.loads(
                subprocess.check_output(
                    ["node", "--input-type=module", "-e", script, str(path)],
                    cwd=Path(__file__).resolve().parents[1],
                    text=True,
                )
            )
        expected = industry_tenor_features(
            pd.DataFrame([request]).assign(origin=pd.Timestamp("2024-06-01")),
            pd.DatetimeIndex(["2024-05-31"]),
            [230.0 + 40.0 / 7.0],
            panel.industry_nodes,
        ).iloc[0]
        for name in INDUSTRY_TENOR_COLUMNS:
            self.assertAlmostEqual(js[name], expected[name], places=8, msg=name)


if __name__ == "__main__":
    unittest.main()
