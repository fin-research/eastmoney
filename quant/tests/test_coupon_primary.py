"""Whole primary batches, strict time isolation and learned coupon effects."""

import json
from pathlib import Path
import subprocess
import unittest

import numpy as np
import pandas as pd

from artifacts import json_safe
from data.coupon_primary import PRIMARY_BATCH_COLUMNS, primary_batch_features
from data.coupon_quotes import QUOTE_COLUMNS
from model.issuance_unified import CouponModel, coupon_anchor
from model.short_coupon import short_candidates, CONTROL, summarize_short


class PrimaryBatchTests(unittest.TestCase):
    def setUp(self):
        self.requests = pd.DataFrame(
            [
                dict(
                    bond_code="target",
                    issuer="A",
                    bond_type="ordinary",
                    placement_type="public",
                    origin=pd.Timestamp("2026-01-10"),
                ),
                dict(
                    bond_code="missing",
                    issuer="B",
                    bond_type="ordinary",
                    placement_type="public",
                    origin=pd.Timestamp("2026-01-10"),
                ),
            ]
        )
        self.events = pd.DataFrame(
            [
                dict(
                    bond_code=code,
                    issuer="A",
                    bond_type="ordinary",
                    placement_type="public",
                    label_available_date=pd.Timestamp(date),
                    tenor=tenor,
                    coupon_bp=coupon,
                )
                for code, date, tenor, coupon in [
                    ("long", "2026-01-08", 5, 190),
                    ("short", "2026-01-08", 3, 175),
                    ("old", "2025-12-01", 3, 180),
                    ("same_day", "2026-01-10", 3, 999),
                    ("expired", "2025-01-09", 3, 777),
                ]
            ]
        )

    def test_entire_batch_uses_original_tenors_without_code_or_coupon_selection(self):
        first = primary_batch_features(self.requests, self.events)
        np.testing.assert_array_equal(first.iloc[0, :4], [175, 3, 190, 5])
        self.assertTrue(first.iloc[0, 4:6].isna().all())
        self.assertEqual(first.iloc[0, -1], 2)
        self.assertTrue(first.iloc[1].isna().all())
        shuffled = self.events.sample(frac=1, random_state=42)
        pd.testing.assert_frame_equal(
            first, primary_batch_features(self.requests, shuffled)
        )
        self.events.loc[self.events.bond_code.eq("same_day"), "coupon_bp"] = -999
        self.events.loc[self.events.bond_code.eq("expired"), "coupon_bp"] = -999
        pd.testing.assert_frame_equal(
            first, primary_batch_features(self.requests, self.events)
        )

    def test_scope_target_exclusion_and_oversized_batch_are_explicit(self):
        different = self.events.iloc[:1].assign(
            bond_code="other", bond_type="subordinated", coupon_bp=999
        )
        same = primary_batch_features(
            self.requests, pd.concat([self.events, different])
        )
        np.testing.assert_array_equal(same.iloc[0, :4], [175, 3, 190, 5])
        request = self.requests.iloc[:1].assign(bond_code="short")
        excluded = primary_batch_features(request, self.events)
        np.testing.assert_array_equal(excluded.iloc[0, :2], [190, 5])
        extra = self.events.iloc[:1].assign(bond_code="third", tenor=7)
        fourth = self.events.iloc[:1].assign(bond_code="fourth", tenor=10)
        with self.assertRaisesRegex(ValueError, "no truncation"):
            primary_batch_features(
                self.requests, pd.concat([self.events, extra, fourth])
            )


class PrimaryLearningTests(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(42)
        n = 90
        current = rng.normal(200, 10, n)
        primary = rng.normal(200, 20, n)
        self.features = pd.DataFrame({name: current for name in QUOTE_COLUMNS}).assign(
            tenor=3.0,
            issue_size=20.0,
            known_treasury_bp=160.0,
            lead_days=np.tile([1, 14, 30], 30),
            issuer="A",
            rating="AAA",
            bond_type="ordinary",
            placement_type="public",
            **{name: np.nan for name in PRIMARY_BATCH_COLUMNS},
        )
        self.features["primary_slot_1_coupon_bp"] = primary
        self.features["primary_slot_1_tenor"] = 3.0
        self.features["primary_batch_age_days"] = 20.0
        self.requests = self.features.assign(
            bond_code=[f"B{i}" for i in range(n)],
            origin=pd.Timestamp("2024-12-31"),
            pricing_date=pd.Timestamp("2025-01-01"),
            label_available_date=pd.Timestamp("2025-01-02"),
            coupon_bp=current + 0.7 * (primary - 200),
        )
        self.candidate = short_candidates("primary_batch")[-1]

    def test_raw_control_is_identical_and_primary_effect_is_learned(self):
        control = short_candidates()[1]
        a = CouponModel(control).fit(self.features, self.requests, "2026-01-01")
        b = CouponModel(control).fit(
            self.features.drop(columns=list(PRIMARY_BATCH_COLUMNS)),
            self.requests,
            "2026-01-01",
        )
        np.testing.assert_array_equal(
            a.predict(self.features), b.predict(self.features)
        )
        positive = CouponModel(self.candidate).fit(
            self.features, self.requests, "2026-01-01"
        )
        reverse = self.requests.assign(
            coupon_bp=2 * self.features.sector_quote_lag_0_bp - self.requests.coupon_bp
        )
        negative = CouponModel(self.candidate).fit(self.features, reverse, "2026-01-01")
        index = positive.feature_names.index("primary_slot_1_coupon_bp")
        self.assertGreater(positive.estimator.coefficients[index], 0)
        self.assertLess(negative.estimator.coefficients[index], 0)
        np.testing.assert_array_equal(coupon_anchor(self.features, self.candidate), 0)
        self.assertEqual(len(positive.numeric), len(a.numeric) + 7)
        self.assertEqual(positive.audit, a.audit)

    def test_future_labels_and_given_feature_javascript_parity(self):
        model = CouponModel(self.candidate).fit(
            self.features, self.requests, "2026-01-01"
        )
        future = self.requests.iloc[:1].assign(
            bond_code="future",
            origin=pd.Timestamp("2026-01-01"),
            label_available_date=pd.Timestamp("2026-01-01"),
            coupon_bp=-999,
        )
        other = CouponModel(self.candidate).fit(
            pd.concat([self.features, self.features.iloc[:1]], ignore_index=True),
            pd.concat([self.requests, future], ignore_index=True),
            "2026-01-01",
        )
        np.testing.assert_array_equal(
            model.estimator.coefficients, other.estimator.coefficients
        )
        sample = self.features.iloc[:6].copy()
        sample.loc[1, "issuer"] = "unseen"
        sample.loc[2, "primary_slot_1_coupon_bp"] = np.nan
        payload = json_safe(
            {"model": model.export(), "features": sample.to_dict(orient="records")}
        )
        code = """
import fs from 'node:fs';
import {encodeCoupon,couponPrediction,couponExplanation} from './online/coupon-model.mjs';
const {model,features}=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(features.map(f=>{const v=encodeCoupon(model,f),e=couponExplanation(model,v,f.known_treasury_bp);return {v,p:couponPrediction(model,v,f.known_treasury_bp),phi:[...e.values,e.expected]};})));
"""
        out = subprocess.run(
            ["node", "--input-type=module", "-e", code],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            check=True,
            cwd=Path(__file__).resolve().parents[1],
        )
        values = json.loads(out.stdout)
        vectors = np.array(
            [[np.nan if x is None else x for x in row["v"]] for row in values]
        )
        np.testing.assert_allclose(
            vectors, model.encode(sample).to_numpy(), equal_nan=True
        )
        np.testing.assert_allclose(
            [row["p"] for row in values], model.predict(sample), atol=1e-10
        )
        np.testing.assert_allclose(
            [row["phi"] for row in values], model.contributions(sample), atol=1e-10
        )

    def test_only_fixed_candidate_can_qualify_with_complete_horizons(self):
        rows = pd.DataFrame(
            [
                dict(
                    bond_code=f"{year}-{h}",
                    origin=f"{year}-02-01",
                    pricing_date=f"{year}-03-03",
                    label_available_date=f"{year}-03-04",
                    lead_days=h,
                    coupon_bp=200.0,
                    valuation_bp=204.0,
                    **{name: 200.0 for name in QUOTE_COLUMNS},
                )
                for year in (2024, 2026)
                for h in (1, 14, 30)
            ]
        )
        predictions = {
            c.name: rows.assign(predicted_bp=200 + error)
            for c, error in zip(
                (*short_candidates("primary_batch"), CONTROL), (3, 2, 1, 4), strict=True
            )
        }
        result = summarize_short(
            predictions, rows, "token", "public_only", "primary_batch"
        )
        self.assertEqual(result["candidate"]["feature_set"], "quote_primary_batch")
        predictions[self.candidate.name] = rows.assign(predicted_bp=205.0)
        result = summarize_short(
            predictions, rows, "token", "public_only", "primary_batch"
        )
        self.assertIsNone(result["candidate"])
        predictions[self.candidate.name] = rows.iloc[:-1].assign(predicted_bp=200.0)
        with self.assertRaises(ValueError):
            summarize_short(predictions, rows, "token", "public_only", "primary_batch")
