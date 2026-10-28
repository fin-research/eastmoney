"""A learned product response preserves time isolation and runtime parity."""

import json
from pathlib import Path
import subprocess
import unittest

import numpy as np
import pandas as pd

from artifacts import json_safe
from data.coupon_quotes import QUOTE_COLUMNS
from model.coupon_product import PRODUCT_QUOTE, fit_product_quote, product_quote_feature
from model.issuance_unified import CouponCandidate, CouponModel


class CouponProductTests(unittest.TestCase):
    def setUp(self):
        self.requests = pd.DataFrame(
            [
                dict(
                    bond_code=str(i),
                    issuer="A",
                    rating="AAA",
                    tenor=3.0,
                    bond_type=["证券公司债", "证券公司次级债"][i % 2],
                    placement_type="公募",
                    issue_size=20.0,
                    lead_days=h,
                    origin=pd.Timestamp("2024-01-01") + pd.Timedelta(days=i),
                    pricing_date=pd.Timestamp("2024-01-01") + pd.Timedelta(days=i + h),
                    label_available_date=pd.Timestamp("2024-01-02")
                    + pd.Timedelta(days=i + h),
                )
                for i in range(72)
                for h in (1, 14, 30)
            ]
        )
        self.features = self.requests.copy()
        quote = 170 + (np.arange(len(self.features)) // 3 % 24) * 4.0
        self.features = self.features.assign(
            known_treasury_bp=160.0,
            **{name: quote + lag / 10 for lag, name in enumerate(QUOTE_COLUMNS)},
        )
        contrast = self.features.bond_type.map(
            {"证券公司债": -0.5, "证券公司次级债": 0.5}
        )
        self.requests["coupon_bp"] = 20 + quote + contrast * (quote - 210) * 0.7
        self.candidate = CouponCandidate("ridge", "coupon", 3, 0, "quote_product")

    def test_future_rows_cannot_change_center_encoding_or_coefficients(self):
        cutoff = pd.Timestamp("2025-01-01")
        first = CouponModel(self.candidate).fit(self.features, self.requests, cutoff)
        future = self.requests.iloc[:3].assign(
            bond_code="future",
            origin=cutoff,
            pricing_date=cutoff,
            label_available_date=cutoff,
            coupon_bp=-9999,
        )
        f = self.features.iloc[:3].assign(sector_quote_lag_0_bp=999999)
        second = CouponModel(self.candidate).fit(
            pd.concat([self.features, f], ignore_index=True),
            pd.concat([self.requests, future], ignore_index=True),
            cutoff,
        )
        self.assertEqual(first.product_quote, second.product_quote)
        np.testing.assert_array_equal(
            first.estimator.coefficients, second.estimator.coefficients
        )
        self.assertEqual(
            first.product_quote["sector_mean_bp"],
            self.features.sector_quote_lag_0_bp.mean(),
        )

    def test_missing_quote_and_unseen_product_do_not_drop_requests(self):
        state = fit_product_quote(self.features)
        sample = self.features.iloc[:3].copy()
        sample.iloc[0, sample.columns.get_loc("sector_quote_lag_0_bp")] = np.nan
        sample.iloc[1, sample.columns.get_loc("bond_type")] = "unseen"
        result = product_quote_feature(sample, state)
        self.assertEqual(len(result), 3)
        self.assertTrue(np.isnan(result.iloc[0]))
        self.assertEqual(result.iloc[1], 0)

    def test_all_original_columns_and_training_rows_are_unchanged(self):
        cutoff = "2025-01-01"
        control = CouponModel(CouponCandidate("ridge", "coupon", 3, 0, "quote_history"))
        control.fit(self.features, self.requests, cutoff)
        challenger = CouponModel(self.candidate).fit(
            self.features, self.requests, cutoff
        )
        self.assertEqual(challenger.audit, control.audit)
        self.assertEqual(
            [name for name in challenger.feature_names if name != PRODUCT_QUOTE],
            control.feature_names,
        )
        pd.testing.assert_frame_equal(
            challenger.encode(self.features).drop(columns=PRODUCT_QUOTE),
            control.encode(self.features),
        )

    def test_coefficient_sign_is_learned_and_not_constrained(self):
        positive = CouponModel(self.candidate).fit(
            self.features, self.requests, "2025-01-01"
        )
        reverse = self.requests.copy()
        reverse["coupon_bp"] = (
            2 * (20 + self.features.sector_quote_lag_0_bp) - reverse.coupon_bp
        )
        negative = CouponModel(self.candidate).fit(self.features, reverse, "2025-01-01")
        index = positive.feature_names.index(PRODUCT_QUOTE)
        self.assertGreater(positive.estimator.coefficients[index], 0)
        self.assertLess(negative.estimator.coefficients[index], 0)

    def test_javascript_matches_missing_unseen_and_each_horizon(self):
        model = CouponModel(self.candidate).fit(
            self.features, self.requests, "2025-01-01"
        )
        sample = self.features.iloc[:6].copy()
        sample.iloc[1, sample.columns.get_loc("sector_quote_lag_0_bp")] = np.nan
        sample.iloc[4, sample.columns.get_loc("bond_type")] = "unseen"
        payload = json_safe(
            {"model": model.export(), "features": sample.to_dict(orient="records")}
        )
        code = """
import fs from 'node:fs';
import {encodeCoupon,couponPrediction,couponExplanation} from './online/coupon-model.mjs';
const {model,features}=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(features.map(f=>{
 const v=encodeCoupon(model,f),phi=couponExplanation(model,v,f.known_treasury_bp);
 return {v,p:couponPrediction(model,v,f.known_treasury_bp),phi:[...phi.values,phi.expected]};
})));
"""
        output = subprocess.run(
            ["node", "--input-type=module", "-e", code],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            cwd=Path(__file__).resolve().parents[1],
            check=True,
        )
        js = json.loads(output.stdout)
        vectors = np.array(
            [[np.nan if x is None else x for x in row["v"]] for row in js]
        )
        np.testing.assert_allclose(vectors, model.encode(sample).to_numpy(), atol=1e-10)
        np.testing.assert_allclose(
            [row["p"] for row in js], model.predict(sample), atol=1e-10
        )
        np.testing.assert_allclose(
            [row["phi"] for row in js], model.contributions(sample), atol=1e-10
        )
        np.testing.assert_allclose(
            model.contributions(sample).sum(axis=1), model.predict(sample)
        )
