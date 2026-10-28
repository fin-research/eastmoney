"""Time and tenor weighted primary coupon evidence, including JS parity."""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import numpy as np
import pandas as pd

from data.issuance_primary_features import WEIGHTED_PRIMARY_COLUMNS
from model.issuance_unified import CouponCandidate, CouponModel
from tests.test_unified_coupon import sample_panel


class WeightedPrimaryTests(unittest.TestCase):
    def test_time_tenor_shrinkage_and_future_invariance(self):
        panel = sample_panel()
        requests = pd.DataFrame(
            [
                dict(
                    issuer="issuer1",
                    rating="AAA",
                    bond_type="证券公司债",
                    placement_type="公募",
                    tenor=5.0,
                    issue_size=20.0,
                    lead_days=30,
                    origin=pd.Timestamp("2024-06-01"),
                ),
                dict(
                    issuer="new issuer",
                    rating="AAA",
                    bond_type="证券公司债",
                    placement_type="公募",
                    tenor=5.0,
                    issue_size=20.0,
                    lead_days=30,
                    origin=pd.Timestamp("2024-06-01"),
                ),
            ]
        )
        features = panel.features(requests, include_weighted_primary=True)
        self.assertTrue(set(WEIGHTED_PRIMARY_COLUMNS).issubset(features))
        self.assertTrue(np.isfinite(features.issuer_weighted_premium_bp.iloc[0]))
        self.assertEqual(
            features.issuer_shrunk_premium_bp.iloc[1],
            features.peer_weighted_premium_bp.iloc[1],
        )
        self.assertTrue(np.isnan(features.issuer_weighted_neff.iloc[1]))
        before = features[list(WEIGHTED_PRIMARY_COLUMNS)].copy()
        panel.events.loc[
            panel.events.label_available_date >= "2024-06-01", "history_premium_bp"
        ] += 1000
        pd.testing.assert_frame_equal(
            before,
            panel.features(requests, include_weighted_primary=True)[
                list(WEIGHTED_PRIMARY_COLUMNS)
            ],
        )

    def test_python_js_values_and_legacy_model_columns(self):
        panel = sample_panel()
        requests = panel.requests((30,))
        features = panel.features(requests, include_weighted_primary=True)
        legacy = CouponModel(CouponCandidate("ridge", "excess", 3)).fit(
            features, requests, "2025-09-01"
        )
        weighted = CouponModel(
            CouponCandidate("ridge", "excess", 3, feature_set="weighted_primary")
        ).fit(features, requests, "2025-09-01")
        self.assertFalse(set(WEIGHTED_PRIMARY_COLUMNS) & set(legacy.numeric))
        self.assertTrue(set(WEIGHTED_PRIMARY_COLUMNS).issubset(weighted.numeric))
        index = (
            int(requests.index[requests.origin.eq("2024-06-01")][0])
            if requests.origin.eq("2024-06-01").any()
            else 45
        )
        request = requests.iloc[index]
        market = panel.rates.market_features.reset_index(names="date")
        events = panel.events.copy()
        market["date"] = market.date.dt.strftime("%Y-%m-%d")
        events["label_available_date"] = events.label_available_date.dt.strftime(
            "%Y-%m-%d"
        )
        payload = {
            "context": {
                "features": market.to_dict(orient="records"),
                "events": events[
                    [
                        "bond_code",
                        "issuer",
                        "rating",
                        "bond_type",
                        "placement_type",
                        "tenor",
                        "label_available_date",
                        "history_premium_bp",
                    ]
                ].to_dict(orient="records"),
            },
            "request": request[
                [
                    "issuer",
                    "rating",
                    "bond_type",
                    "placement_type",
                    "tenor",
                    "issue_size",
                    "lead_days",
                    "origin",
                ]
            ].to_dict(),
        }
        payload["request"]["origin"] = request.origin.strftime("%Y-%m-%d")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "case.json"
            path.write_text(json.dumps(payload, default=str))
            script = """import fs from 'node:fs';
import {couponFeature} from './online/coupon-features.mjs';
const data=JSON.parse(fs.readFileSync(process.argv[1]));
const context={...data.context,secondary:new Map()};
console.log(JSON.stringify(couponFeature(context,data.request)));"""
            actual = json.loads(
                subprocess.check_output(
                    ["node", "--input-type=module", "-e", script, str(path)],
                    cwd=Path(__file__).resolve().parents[1],
                    text=True,
                )
            )
        for name in WEIGHTED_PRIMARY_COLUMNS:
            expected = features.iloc[index][name]
            if np.isnan(expected):
                self.assertIsNone(actual[name], name)
            else:
                self.assertAlmostEqual(actual[name], expected, places=8, msg=name)


if __name__ == "__main__":
    unittest.main()
