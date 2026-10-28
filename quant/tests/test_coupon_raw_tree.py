"""Direct raw-quote tree learning, paired evidence and retained model identity."""

import json
import copy
from pathlib import Path
import subprocess
import tempfile
import unittest

import numpy as np
import pandas as pd

from artifacts import json_safe, write_json
from data.coupon_quotes import QUOTE_COLUMNS
from model.issuance_study import checkpoint_guard
from model.issuance_unified import CouponModel, coupon_anchor, _event_lead_weights
from model.short_coupon import CONTROL, short_candidates, summarize_short
from reports.short_evidence import validate_short_evidence


class RawTreeTests(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(42)
        current = np.repeat(rng.normal(200, 20, 120), 3)
        self.features = pd.DataFrame({name: current for name in QUOTE_COLUMNS}).assign(
            tenor=3.0,
            issue_size=20.0,
            known_treasury_bp=160.0,
            lead_days=np.tile([1, 14, 30], 120),
            issuer="A",
            rating="AAA",
            bond_type="ordinary",
            placement_type="public",
        )
        self.requests = self.features.assign(
            bond_code=np.repeat([f"B{i}" for i in range(120)], 3),
            origin=pd.Timestamp("2024-12-31"),
            pricing_date=pd.Timestamp("2025-01-01"),
            label_available_date=pd.Timestamp("2025-01-02"),
            coupon_bp=current,
        )
        self.candidate = short_candidates("raw_tree")[-1]

    def test_same_raw_columns_and_events_with_zero_anchor_and_learned_direction(self):
        tree = CouponModel(self.candidate).fit(
            self.features, self.requests, "2026-01-01"
        )
        raw = CouponModel(short_candidates()[1]).fit(
            self.features, self.requests, "2026-01-01"
        )
        self.assertEqual(tree.numeric, raw.numeric)
        self.assertEqual(tree.categories, raw.categories)
        pd.testing.assert_series_equal(
            tree.training_mask(self.requests, "2026-01-01"),
            raw.training_mask(self.requests, "2026-01-01"),
        )
        weights = _event_lead_weights(self.requests, self.candidate.lead_policy)
        np.testing.assert_allclose(
            self.requests.assign(w=weights).groupby("bond_code").w.sum(), 1
        )
        np.testing.assert_array_equal(coupon_anchor(self.features, self.candidate), 0)
        reversed_model = CouponModel(self.candidate).fit(
            self.features,
            self.requests.assign(coupon_bp=400 - self.requests.coupon_bp),
            "2026-01-01",
        )
        sample = self.features.iloc[:2].copy()
        sample.loc[:, list(QUOTE_COLUMNS)] = np.array([[170] * 40, [230] * 40])
        self.assertGreater(np.diff(tree.predict(sample))[0], 0)
        self.assertLess(np.diff(reversed_model.predict(sample))[0], 0)
        self.assertEqual(tree.estimator.get_params()["objective"], "regression")
        self.assertEqual(tree.estimator.get_params()["n_estimators"], 200)

    def test_future_label_isolation_and_given_feature_js_parity(self):
        model = CouponModel(self.candidate).fit(
            self.features, self.requests, "2026-01-01"
        )
        future = self.requests.iloc[:3].assign(
            bond_code="future",
            origin=pd.Timestamp("2026-01-01"),
            label_available_date=pd.Timestamp("2026-01-01"),
            coupon_bp=999,
        )
        other = CouponModel(self.candidate).fit(
            pd.concat([self.features, self.features.iloc[:3]], ignore_index=True),
            pd.concat([self.requests, future], ignore_index=True),
            "2026-01-01",
        )
        np.testing.assert_array_equal(
            model.predict(self.features), other.predict(self.features)
        )
        sample = self.features.iloc[:6].copy()
        sample.loc[1, "issuer"] = "unseen"
        sample.loc[2, "sector_quote_lag_0_bp"] = np.nan
        sample.loc[3, list(QUOTE_COLUMNS)] = np.nan
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

    def test_only_tree_is_eligible_and_paired_increment_keeps_failed_denominator(self):
        expected = pd.DataFrame(
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
        candidates = (*short_candidates("raw_tree"), CONTROL)
        predictions = {
            c.name: expected.assign(predicted_bp=200 + error)
            for c, error in zip(candidates, (3, 2, 1, 4), strict=True)
        }
        result = summarize_short(
            predictions, expected, "token", "public_only", "raw_tree"
        )
        self.assertEqual(result["candidate"]["kind"], "lgb")
        self.assertEqual(
            [r["control_only"] for r in result["comparison"]], [True, True, False, True]
        )
        for period in result["raw_history_increment"]["periods"].values():
            self.assertEqual([r["mae_delta_bp"] for r in period], [-1.0] * 3)
        evidence = {
            "schema_version": 1,
            "evaluation": result,
            "protocol_sha256": "token",
            "input_sha256": "input",
        }
        validate_short_evidence(evidence)
        changed = copy.deepcopy(evidence)
        paired = changed["evaluation"]["raw_history_increment"]
        paired["reference"] = candidates[0].name
        for period in paired["periods"].values():
            for row in period:
                row["mae_delta_bp"] = -2.0
        with self.assertRaisesRegex(ValueError, "learning schemes"):
            validate_short_evidence(changed)
        result["raw_history_increment"]["periods"]["development"][0][
            "mae_delta_bp"
        ] = -999
        with self.assertRaisesRegex(ValueError, "MAE difference"):
            validate_short_evidence(evidence)
        predictions[self.candidate.name] = expected.sample(
            frac=1, random_state=2
        ).assign(predicted_bp=205.0)
        result = summarize_short(
            predictions, expected, "token", "public_only", "raw_tree"
        )
        self.assertIsNone(result["candidate"])
        for period in result["raw_history_increment"]["periods"].values():
            self.assertEqual([r["mae_delta_bp"] for r in period], [3.0] * 3)
        predictions[self.candidate.name] = expected.iloc[:-1].assign(predicted_bp=200.0)
        with self.assertRaisesRegex(ValueError, "denominator"):
            summarize_short(predictions, expected, "token", "public_only", "raw_tree")

    def test_retained_state_is_required_and_bound_to_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "2026-01.csv"
            path.write_text("prediction\n200\n")
            write_json(path.with_suffix(".diagnostics.json"), {})
            with self.assertRaisesRegex(ValueError, "retained model state"):
                checkpoint_guard(
                    path, True, "token", self.candidate, state_required=True
                )
            write_json(path.with_suffix(".state.json"), {"parameter": 1})
            checkpoint_guard(path, True, "token", self.candidate, state_required=True)
            checkpoint_guard(path, False, "token", self.candidate, state_required=True)
            write_json(path.with_suffix(".state.json"), {"parameter": 2})
            with self.assertRaisesRegex(ValueError, "fingerprint mismatch"):
                checkpoint_guard(
                    path, False, "token", self.candidate, state_required=True
                )
