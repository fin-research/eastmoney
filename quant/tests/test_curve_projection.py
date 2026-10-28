"""Time isolation, missing-window semantics and cross-runtime learned projection."""
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest

import numpy as np
import pandas as pd

from artifacts import json_safe
from data.coupon_quotes import coupon_quote_features
from model.curve_projection import CURVE_COLUMNS, PC_COLUMNS, fit_curve_projection, project_curve
from model.issuance_unified import CouponCandidate, CouponModel


class CurveProjectionTests(unittest.TestCase):
    def setUp(self):
        self.dates = pd.date_range("2023-01-02", "2026-03-02", freq="B")
        self.cutoff = pd.Timestamp("2026-01-01")
        self.nodes = pd.DataFrame([
            {"observation_date": date, "tenor_years": tenor,
             "yield_pct": 2 + np.sin(i/19)/5 + tenor/20*np.cos(i/37)
             + np.sin(i/7)*np.cos(tenor)/100}
            for i, date in enumerate(self.dates) for tenor in (1, 3, 5, 7, 10)
        ])
        self.panel = SimpleNamespace(
            rates=SimpleNamespace(market_features=pd.DataFrame(index=self.dates)),
            industry_nodes=self.nodes,
        )

    def test_future_quotes_cannot_change_fitted_state(self):
        first = fit_curve_projection(self.panel, self.cutoff, 3)
        self.nodes.loc[self.nodes.observation_date >= self.cutoff, "yield_pct"] = 80
        second = fit_curve_projection(self.panel, self.cutoff, 3)
        self.assertEqual(first, second)
        self.assertLess(first["audit"]["last_endpoint"], "2026-01-01")
        oldest = self.dates.searchsorted(first["audit"]["first_endpoint"]) - 19
        self.assertGreaterEqual(self.dates[oldest], self.cutoff-pd.DateOffset(years=3))

    def test_incomplete_window_remains_missing_without_dropping_request(self):
        state = fit_curve_projection(self.panel, self.cutoff, 3)
        values = pd.DataFrame([state["mean"], state["mean"]], columns=CURVE_COLUMNS)
        values.loc[1, CURVE_COLUMNS[3]] = np.nan
        projected = project_curve(values, state)
        self.assertEqual(len(projected), 2)
        np.testing.assert_allclose(projected.loc[0, list(PC_COLUMNS)], 0, atol=1e-12)
        self.assertTrue(projected.loc[1, list(PC_COLUMNS)].isna().all())

    def test_rank_deficient_window_fails_instead_of_changing_dimension(self):
        self.nodes["yield_pct"] = 2.0
        with self.assertRaisesRegex(ValueError, "three components"):
            fit_curve_projection(self.panel, self.cutoff, 3)

    def test_learned_prediction_and_contributions_match_javascript(self):
        n = 120
        requests = pd.DataFrame({
            "origin": self.dates[200:200+n], "tenor": 3.0,
            "issuer": "A", "bond_type": "证券公司债", "placement_type": "公募",
            "rating": "AAA", "issue_size": 20.0,
            "lead_days": np.tile([1, 14, 30], n//3),
            "bond_code": [str(i) for i in range(n)],
            "pricing_date": self.dates[240:240+n],
            "label_available_date": self.dates[241:241+n],
        })
        quotes = coupon_quote_features(requests, self.dates, self.nodes, None)
        features = pd.concat([requests, quotes], axis=1).assign(known_treasury_bp=180.0)
        requests["coupon_bp"] = (features.sector_quote_lag_0_bp
                                 + 0.2*features.sector_quote_lag_1_bp)
        model = CouponModel(CouponCandidate("ridge", "coupon", 3, 0, "quote_pca"))
        model.fit(features, requests, self.cutoff, market_panel=self.panel)
        sample = features.iloc[:2].copy()
        sample.loc[sample.index[1], CURVE_COLUMNS[2]] = np.nan
        state = model.export()
        payload = json_safe({"model": state, "features": sample.to_dict(orient="records")})
        code = """
import fs from 'node:fs';
import {encodeCoupon,couponPrediction,couponExplanation} from './online/coupon-model.mjs';
const {model,features}=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(features.map(f=>{
 const v=encodeCoupon(model,f), phi=couponExplanation(model,v,f.known_treasury_bp);
 return {v,p:couponPrediction(model,v,f.known_treasury_bp),phi:[...phi.values,phi.expected]};
})));
"""
        result = subprocess.run(["node", "--input-type=module", "-e", code],
                                input=json.dumps(payload), text=True, capture_output=True,
                                cwd=Path(__file__).resolve().parents[1], check=True)
        js = json.loads(result.stdout)
        encoded = model.encode(sample).to_numpy()
        encoded_js = np.array([[np.nan if x is None else x for x in r["v"]] for r in js])
        np.testing.assert_allclose(encoded_js, encoded, atol=1e-9)
        np.testing.assert_allclose([r["p"] for r in js], model.predict(sample), atol=1e-9)
        np.testing.assert_allclose([r["phi"] for r in js], model.contributions(sample), atol=1e-9)
        np.testing.assert_allclose(model.contributions(sample).sum(axis=1), model.predict(sample))
