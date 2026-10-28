import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import numpy as np
import pandas as pd

from data.issuance_eligibility import issuance_kind_audit
from data.issuance_event_ledger import issuance_event_ledger
from model.issuance_diagnostics import (
    diagnostic_report,
    error_metrics,
    period_metrics,
    training_diagnostics,
)
from model.issuance_evaluation import _best_candidate
from model.issuance_unified import (
    LGB_PROFILES,
    SPARSE_DAY_COUNTS,
    SPARSE_LEADS,
    CouponCandidate,
    CouponModel,
    _event_lead_weights,
)
from tests.test_unified_coupon import sample_panel


class CouponDiagnosticTests(unittest.TestCase):
    def test_c_stage_profiles_keep_frozen_control_unchanged(self):
        self.assertEqual(LGB_PROFILES[0]["min_child_samples"], 160)
        self.assertEqual(LGB_PROFILES[1]["min_child_samples"], 240)
        self.assertEqual(
            [
                (profile["min_child_samples"], profile["min_child_weight"])
                for profile in LGB_PROFILES[2:4]
            ],
            [(20, 4.0), (20, 8.0)],
        )

    def test_lead_policies_preserve_one_weight_per_real_event(self):
        rows = pd.DataFrame(
            {
                "bond_code": ["a"] * 91 + ["b"] * 3,
                "lead_days": list(range(91)) + [7, 30, 90],
            }
        )
        front = _event_lead_weights(rows, "front30")
        self.assertAlmostEqual(front[:91].sum(), 1.0)
        self.assertAlmostEqual(front[91:].sum(), 1.0)
        self.assertAlmostEqual(front[:31].sum(), 0.7)
        self.assertAlmostEqual(front[31:61].sum(), 0.2)
        self.assertAlmostEqual(front[61:91].sum(), 0.1)
        self.assertEqual(sum(SPARSE_DAY_COUNTS.values()), 91)
        sparse = rows.loc[rows.lead_days.isin(SPARSE_LEADS)].reset_index(drop=True)
        weights = _event_lead_weights(sparse, "sparse_grid")
        np.testing.assert_allclose(
            pd.DataFrame({"bond_code": sparse.bond_code, "weight": weights})
            .groupby("bond_code")
            .weight.sum(),
            [1.0, 1.0],
        )

    def test_event_ledger_keeps_one_reason_per_source_record(self):
        base = dict(
            bond_code="100001.SZ",
            short_name="新券",
            issuer_name="issuer",
            bond_type="证券公司债",
            placement_type="公募",
            original_tenor_years=3,
            issue_amount_100m=10,
            tender_date="2024-05-20",
            issue_date="2024-05-22",
            maturity_date="2027-05-22",
            final_coupon_pct=2.5,
            interest_rate_type="固息",
            has_option=False,
        )
        rows = [
            base,
            {**base, "bond_code": "100002.SZ", "tender_date": None},
            {**base, "bond_code": "100003.SZ", "tender_date": "2020-01-02"},
            {**base, "bond_code": "100004.SZ", "has_option": True},
        ]
        inputs = {"as_of_date": "2025-01-01", "datasets": {"bond_issuance": rows}}
        ledger = issuance_event_ledger(inputs, market_start="2020-12-28")
        self.assertEqual(
            ledger.exclusion_reason.tolist(),
            [
                "included",
                "invalid_pricing_date",
                "no_prior_market_quote",
                "included",
            ],
        )
        self.assertEqual(ledger.training_eligible.sum(), 2)
        self.assertTrue(ledger.bond_code.is_unique)
        self.assertFalse(ledger.history_vintage_verified.any())

    def test_reopening_requires_contract_evidence_and_keeps_extreme_new_issue(self):
        original = dict(
            bond_code="100001.SZ",
            short_name="原券",
            issue_date="2023-01-01",
            maturity_date="2028/1/1",
            final_coupon_pct=3.35,
            issuer_name="issuer",
            bond_type="证券公司次级债",
            interest_rate_type="固息",
            has_option=False,
        )
        records = [
            original,
            {
                **original,
                "bond_code": "100001X.SZ",
                "short_name": "原券(续发)",
                "issue_date": "2025-01-01",
                "maturity_date": "2028-01-01",
            },
            {
                **original,
                "bond_code": "100001X2.SZ",
                "issue_date": "2025-01-01",
                "final_coupon_pct": 2.0,
            },
            {**original, "bond_code": "100002.SZ", "final_coupon_pct": 12.0},
        ]
        kinds = issuance_kind_audit(pd.DataFrame(records)).issuance_kind.tolist()
        self.assertEqual(
            kinds,
            [
                "new_coupon",
                "fixed_coupon_reopening",
                "unverified_reopening",
                "new_coupon",
            ],
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "events.json"
            path.write_text(json.dumps(records))
            script = """import fs from 'node:fs';
import {issuanceKinds} from './online/coupon-features.mjs';
console.log(JSON.stringify([...issuanceKinds(JSON.parse(fs.readFileSync(process.argv[1]))).values()]));"""
            actual = subprocess.check_output(
                ["node", "--input-type=module", "-e", script, str(path)],
                cwd=Path(__file__).resolve().parents[1],
                text=True,
            )
        self.assertEqual(json.loads(actual), kinds)

    def test_overprediction_remains_negative_bias_not_success_objective(self):
        values = error_metrics([100, 100, np.nan], [105, 105, 105])
        self.assertEqual(values["bias_bp"], -5)
        self.assertEqual(values["mae_bp"], 5)
        self.assertEqual(values["missing"], 1)
        base = {"failure": None, "candidate": {"kind": "ridge"}}
        candidates = [
            {**base, "name": "accurate", "mae_bp": 2, "rmse_bp": 3, "win_rate": 0},
            {**base, "name": "overpredict", "mae_bp": 8, "rmse_bp": 9, "win_rate": 1},
        ]
        self.assertEqual(_best_candidate(candidates)["name"], "accurate")

    def test_training_audit_does_not_include_future_or_excluded_labels(self):
        panel = sample_panel()
        requests = panel.requests((7, 14, 30, 60, 90))
        features = panel.features(requests)
        model = CouponModel(CouponCandidate("ridge", "excess", 3)).fit(
            features, requests, "2025-01-01", ("issuer0",)
        )
        expected = training_diagnostics(
            model, features, requests, "2025-01-01", ("issuer0",)
        )
        altered = requests.copy()
        future = ~model.training_mask(requests, "2025-01-01", ("issuer0",))
        altered.loc[future, "coupon_bp"] += 10000
        self.assertEqual(
            expected,
            training_diagnostics(model, features, altered, "2025-01-01", ("issuer0",)),
        )
        self.assertAlmostEqual(model.audit["weight_sum"], model.audit["events"])

    def test_years_and_splits_stay_separate_and_repeated_events_rejected(self):
        rows = pd.DataFrame(
            dict(
                bond_code=["a", "b"],
                pricing_date=["2025-01-01", "2026-01-01"],
                lead_days=[30, 30],
                coupon_bp=[100, 100],
                predicted_bp=[110, 90],
                simple_bp=[105, 105],
            )
        )
        report = diagnostic_report([], rows.iloc[:1], rows.iloc[1:])
        self.assertFalse(report["training_and_final_used_for_selection"])
        self.assertEqual(report["development"][0]["bias_bp"], -10)
        self.assertEqual(report["final"][0]["bias_bp"], 10)
        self.assertNotIn("win_rate", report["final"][0])
        with self.assertRaisesRegex(ValueError, "duplicate issuance"):
            period_metrics(pd.concat([rows, rows]), split="invalid")


if __name__ == "__main__":
    unittest.main()
