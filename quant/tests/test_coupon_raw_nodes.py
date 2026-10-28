"""Raw source identity, uncompressed missing dates and native-NaN coupon learning."""

from contextlib import ExitStack
import copy
import json
import subprocess
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

from artifacts import json_safe
from data.coupon_raw_nodes import (
    NODE_COLUMNS,
    NODE_FEATURES,
    NODE_NUMERIC,
    raw_node_features,
    raw_node_sources,
)
from data.industry_source import PROFILE
from data.issuance_training import expand_pricing_requests
from model.issuance_unified import CouponCandidate, CouponModel, coupon_anchor


def source_inputs():
    dates = ["2020-12-27", "2020-12-28", "2020-12-29"]
    return {
        "as_of_date": "2021-01-01",
        "industry_source_profile": PROFILE,
        "datasets": {
            "funding": [
                dict(
                    field=field, observation_date=day, published_date=None, value=value
                )
                for day, value in zip(dates, [2.5, None, 0.0], strict=True)
                for field in ("E1000172", "E1000174", "E1000180")
            ],
            "industry_nodes": [
                dict(
                    curve_code=PROFILE["curveCode"],
                    observation_date=day,
                    tenor_years=1.0,
                    yield_pct=value,
                )
                for day, value in zip(dates, [3.5, None, 0.0], strict=True)
            ],
        },
    }


def event_rows():
    return pd.DataFrame(
        {
            "bond_code": ["A", "B"],
            "pricing_date": pd.to_datetime(["2020-12-29", "2020-12-31"]),
            "tenor": [3.25, 3.25],
            "issue_size": [10.0, 10.0],
            "issuer": ["issuer", "issuer"],
            "rating": ["AAA", "AAA"],
            "bond_type": ["ordinary", "ordinary"],
            "placement_type": ["public", "public"],
        }
    )


class RawNodeTests(unittest.TestCase):
    def test_known_late_release_does_not_move_statistical_date_or_leak(self):
        inputs = source_inputs()
        for row in inputs["datasets"]["funding"]:
            if row["observation_date"] == "2020-12-29":
                row["published_date"] = "2020-12-31"
        dates, sources = raw_node_sources(inputs)
        self.assertEqual(dates[-1], pd.Timestamp("2020-12-29"))
        events = event_rows().iloc[[1]].copy()
        events["pricing_date"] = pd.Timestamp("2021-01-02")
        rows = expand_pricing_requests(events, dates, (3, 2, 1))
        features = raw_node_features(rows, dates, sources)
        self.assertTrue(pd.isna(features.loc[0, "raw_gov_3y_lag_0_pct"]))
        self.assertTrue(pd.isna(features.loc[1, "raw_gov_3y_lag_0_pct"]))
        self.assertEqual(features.loc[2, "raw_gov_3y_lag_0_pct"], 0)
        self.assertEqual(features.loc[2, "raw_gov_3y_lag_2_pct"], 2.5)

    def test_empty_day_keeps_position_zero_and_prepublication_boundaries(self):
        inputs = source_inputs()
        original = copy.deepcopy(inputs)
        dates, sources = raw_node_sources(inputs)
        rows = expand_pricing_requests(event_rows(), dates, (1,))
        features = raw_node_features(rows, dates, sources)
        self.assertEqual(len(dates), 3)
        self.assertEqual(list(features), list(NODE_FEATURES))
        # Origin Dec28 is excluded; Dec30 sees zero, empty Dec28, then retrospective Dec27.
        self.assertTrue(
            features.loc[0, [n for n in NODE_COLUMNS if n.startswith("raw_sector_")]]
            .isna()
            .all()
        )
        self.assertEqual(features.loc[1, "raw_sector_1y_lag_0_pct"], 0)
        self.assertTrue(pd.isna(features.loc[1, "raw_sector_1y_lag_1_pct"]))
        self.assertEqual(features.loc[1, "raw_sector_1y_lag_2_pct"], 3.5)
        self.assertEqual(features.loc[1, "raw_gov_3y_lag_0_pct"], 0)
        self.assertTrue(pd.isna(features.loc[1, "raw_gov_3y_lag_1_pct"]))
        self.assertEqual(features.loc[1, "raw_gov_3y_lag_2_pct"], 2.5)
        self.assertTrue(pd.isna(features.loc[1, "raw_sector_3y_lag_0_pct"]))
        self.assertEqual(features.loc[1, "tenor"], 3.25)
        self.assertEqual(inputs, original)

    def test_duplicate_nonfinite_and_unregistered_node_reject_before_cleanup(self):
        for mutation in ("duplicate", "infinite", "unknown_tenor"):
            with self.subTest(mutation=mutation):
                inputs = source_inputs()
                if mutation == "duplicate":
                    inputs["datasets"]["industry_nodes"].append(
                        inputs["datasets"]["industry_nodes"][0].copy()
                    )
                elif mutation == "infinite":
                    inputs["datasets"]["industry_nodes"][0]["yield_pct"] = float("inf")
                else:
                    inputs["datasets"]["industry_nodes"][0]["tenor_years"] = 1.23456
                dates, sources = raw_node_sources(inputs)
                rows = expand_pricing_requests(event_rows(), dates, (1,))
                with self.assertRaises(ValueError):
                    raw_node_features(rows, dates, sources)

    def test_fixed_candidate_rejects_derived_columns_and_other_identity(self):
        model = CouponModel(CouponCandidate("lgb", "coupon", 0, 2, "raw_nodes"))
        frame = pd.DataFrame(columns=NODE_FEATURES)
        model._validate_feature_groups(frame)
        with self.assertRaises(ValueError):
            model._validate_feature_groups(frame.assign(known_treasury_bp=0))
        with self.assertRaises(ValueError):
            CouponModel(
                CouponCandidate("ridge", "coupon", 0, 2, "raw_nodes")
            )._validate_feature_groups(frame)

    def test_native_missing_learning_and_js_tree_parity_without_legacy_entrypoints(
        self,
    ):
        rng = np.random.default_rng(42)
        signal = np.repeat(rng.uniform(1.3, 3.5, 120), 3)
        frame = pd.DataFrame(np.nan, index=range(len(signal)), columns=NODE_COLUMNS)
        frame["raw_gov_3y_lag_0_pct"] = signal
        frame = frame.assign(
            tenor=3.25,
            issue_size=20.0,
            lead_days=np.tile([1, 14, 30], 120),
            issuer="A",
            rating="AAA",
            bond_type="ordinary",
            placement_type="public",
        )
        rows = frame.assign(
            bond_code=np.repeat([f"B{i}" for i in range(120)], 3),
            pricing_date=pd.Timestamp("2025-01-01"),
            origin=pd.Timestamp("2024-12-31"),
            label_available_date=pd.Timestamp("2025-01-02"),
            coupon_bp=signal * 100,
        )
        candidate = CouponCandidate("lgb", "coupon", 0, 2, "raw_nodes")
        guards = (
            "data.issuance_training.IssuancePanel.from_inputs",
            "data.issuance_training.treasury_anchor",
            "data.issuance_training.industry_tenor_features",
            "data.coupon_quotes.coupon_quote_features",
            "model.window_linear.WindowRidge.fit",
            "numpy.linalg.lstsq",
        )
        with ExitStack() as stack:
            for name in guards:
                stack.enter_context(
                    patch(name, side_effect=AssertionError("legacy path called"))
                )
            inputs = source_inputs()
            dates, sources = raw_node_sources(inputs)
            actual_requests = expand_pricing_requests(event_rows(), dates, (1,))
            raw_node_features(actual_requests, dates, sources)
            positive = CouponModel(candidate).fit(frame, rows, "2026-01-01")
            negative = CouponModel(candidate).fit(
                frame, rows.assign(coupon_bp=500 - rows.coupon_bp), "2026-01-01"
            )
            sample = frame.iloc[:4].copy()
            sample["raw_gov_3y_lag_0_pct"] = [1.5, 3.0, np.nan, 0.0]
            sample.loc[2, "issuer"] = "unseen"
            self.assertGreater(positive.predict(sample)[1], positive.predict(sample)[0])
            self.assertLess(negative.predict(sample)[1], negative.predict(sample)[0])
            self.assertEqual(positive.numeric, list(NODE_NUMERIC))
            self.assertEqual(len(positive.feature_names), 2187)
            self.assertTrue(positive.estimator.get_params()["use_missing"])
            self.assertFalse(positive.estimator.get_params()["zero_as_missing"])
            encoded = positive.encode(sample)
            self.assertTrue(np.isnan(encoded.loc[2, "raw_gov_3y_lag_0_pct"]))
            self.assertEqual(encoded.loc[3, "raw_gov_3y_lag_0_pct"], 0)
            np.testing.assert_array_equal(coupon_anchor(sample, candidate), 0)
            np.testing.assert_allclose(
                positive.contributions(sample).sum(axis=1), positive.predict(sample)
            )
        payload = json_safe(
            {"model": positive.export(), "features": sample.to_dict(orient="records")}
        )
        code = """
import fs from 'node:fs';
import {encodeCoupon,couponPrediction,couponExplanation} from './online/coupon-model.mjs';
const {model,features}=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(features.map(f=>{const v=encodeCoupon(model,f),e=couponExplanation(model,v);return {v,p:couponPrediction(model,v),phi:[...e.values,e.expected]};})));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", code],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            check=True,
        )
        actual = json.loads(result.stdout)
        np.testing.assert_allclose([r["p"] for r in actual], positive.predict(sample))
        np.testing.assert_allclose(
            [r["phi"] for r in actual], positive.contributions(sample), atol=1e-8
        )
        np.testing.assert_allclose(
            [[np.nan if x is None else x for x in r["v"]] for r in actual],
            positive.encode(sample),
            equal_nan=True,
        )
