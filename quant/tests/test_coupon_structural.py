"""Economic offsets, runtime restoration and business decision audit boundaries."""

from dataclasses import asdict
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import numpy as np
import pandas as pd

from data.issuance_industry_tenor import AAA_CURVE_CODE, prepare_industry_nodes
from model.export import write_json
from model.issuance_study_protocol import (
    BASIS_CANDIDATES,
    ROBUST_CANDIDATES,
    STRUCTURAL_CANDIDATES,
    load_spec,
)
from model.issuance_output import coupon_snapshot
from model.issuance_export import export_coupon_bundle
from model.issuance_study_report import group_diagnostics, structural_report
from model.issuance_timing_audit import coupon_timing_audit, timing_summary
from model.issuance_unified import CouponCandidate, CouponModel, coupon_anchor
from tests.test_issuance_study import paired_fixture, study_spec
from tests.test_unified_coupon import sample_panel


def structural_panel():
    panel = sample_panel()
    panel.industry_nodes = prepare_industry_nodes(
        [
            {
                "curve_code": AAA_CURVE_CODE,
                "observation_date": date,
                "tenor_years": tenor,
                "yield_pct": 2.5 + tenor * 0.1,
            }
            for date in panel.rates.market_features.index
            for tenor in (1, 3, 5, 10)
        ]
    )
    return panel


class CouponStructuralTests(unittest.TestCase):
    def test_basis_registry_is_frozen(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "spec.json"
            spec = {
                **study_spec(),
                "schema_version": 4,
                "candidates": [asdict(c) for c in BASIS_CANDIDATES],
            }
            path.write_text(json.dumps(spec))
            self.assertEqual(load_spec(path)[0], spec)
            spec["candidates"][2]["years"] = 3
            path.write_text(json.dumps(spec))
            with self.assertRaisesRegex(ValueError, "exactly"):
                load_spec(path)

    def test_industry_history_does_not_mix_missing_curve_premiums(self):
        panel = structural_panel()
        panel.events = panel.events.iloc[:2].copy()
        for name, value in {
            "issuer": "own",
            "rating": "AAA",
            "bond_type": "证券公司债",
            "placement_type": "公募",
            "tenor": 3.0,
        }.items():
            panel.events[name] = value
        panel.events["coupon_bp"] = [300.0, 400.0]
        panel.events["history_premium_bp"] = [70.0, 170.0]
        dates = panel.rates.market_features.index
        missing = dates[
            dates.searchsorted(panel.events.pricing_date.iloc[1], side="left") - 1
        ]
        panel.industry_nodes = panel.industry_nodes.loc[
            panel.industry_nodes.observation_date.ne(missing)
        ]
        request = pd.DataFrame(
            [
                {
                    **panel.events.iloc[0].to_dict(),
                    "origin": pd.Timestamp("2023-02-01"),
                    "lead_days": 30,
                }
            ]
        )

        def features(query):
            return panel.features(
                query,
                include_weighted_primary=True,
                include_industry_tenor=True,
                include_industry_basis=True,
            )

        candidate = BASIS_CANDIDATES[2]
        original = features(request)
        self.assertAlmostEqual(original.issuer_shrunk_industry_basis_bp.iloc[0], 20)
        self.assertEqual(original.issuer_industry_basis_observations.iloc[0], 1)
        self.assertAlmostEqual(coupon_anchor(original, candidate)[0], 300)
        for changed in (request.assign(issuer="new"), request.assign(rating="unknown")):
            self.assertAlmostEqual(
                features(changed).issuer_shrunk_industry_basis_bp.iloc[0], 20
            )
        no_history = features(request.assign(issuer="new", rating="unknown"))
        self.assertEqual(no_history.industry_basis_fallback.iloc[0], 1)
        self.assertAlmostEqual(coupon_anchor(no_history, candidate)[0], 230)
        late = panel.events.iloc[0].to_dict()
        late.update(
            bond_code="late.SH",
            pricing_date=pd.Timestamp("2023-01-31"),
            label_available_date=request.origin.iloc[0],
            coupon_bp=1000,
            history_premium_bp=770,
        )
        panel.events = pd.concat(
            [panel.events, pd.DataFrame([late])], ignore_index=True
        )
        pd.testing.assert_frame_equal(original, features(request))
        panel.events.loc[panel.events.bond_code.eq("late.SH"), "coupon_bp"] = 2000
        pd.testing.assert_frame_equal(original, features(request))
        future = panel.industry_nodes.observation_date >= request.origin.iloc[0]
        panel.industry_nodes.loc[future, "yield_pct"] += 1
        pd.testing.assert_frame_equal(original, features(request))
        quote = dates[dates.searchsorted(request.origin.iloc[0], side="left") - 1]
        panel.industry_nodes = panel.industry_nodes.loc[
            panel.industry_nodes.observation_date.ne(quote)
        ]
        missing_current = features(request)
        self.assertEqual(missing_current.industry_basis_fallback.iloc[0], 1)
        primary = CouponCandidate("lgb", "primary_residual", 5, 2, "weighted_primary")
        np.testing.assert_allclose(
            coupon_anchor(missing_current, candidate),
            coupon_anchor(missing_current, primary),
        )

    def test_bundle_unknown_category_fixture_recomputes_matching_history(self):
        panel = sample_panel()
        panel.rates.audit = {"feature_groups": []}
        requests = panel.requests((0, 7, 30))
        model = CouponModel(CouponCandidate("ridge", "excess", 5)).fit(
            panel.features(requests), requests, "2026-09-01"
        )
        snapshot = {
            "as_of_date": "2026-09-23",
            "terms": {},
            "window_days": 30,
            "issue_size_yi": 30,
        }
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            export_coupon_bundle(
                panel, model, {}, {"datasets": {"funding": []}}, snapshot, directory
            )
            fixtures = json.loads(
                (directory / "python-request-features.json").read_text()
            )
            request, feature = fixtures["requests"][-1], fixtures["features"][-1]
            for name in ("issuer", "rating", "bond_type", "placement_type"):
                self.assertEqual(request[name], feature[name])
            self.assertEqual(feature["issuer_observations"], 0)
            self.assertEqual(feature["peer_observations"], 0)

    def test_offset_is_known_reference_with_explicit_missing_fallback(self):
        features = pd.DataFrame(
            {
                "known_treasury_bp": [200.0] * 3,
                "industry_aaa_tenor_bp": [240, np.nan, 250],
                "industry_aaa_available": [1, 0, 0],
                "issuer_shrunk_premium_bp": [30, np.nan, np.nan],
                "peer_premium_mean_bp": [40, 50, np.nan],
            }
        )
        industry = CouponCandidate("lgb", "industry_excess", 5, 2, "combined")
        primary = CouponCandidate("ridge", "primary_residual", 5, 1, "weighted_primary")
        np.testing.assert_equal(coupon_anchor(features, industry), [240, 200, 200])
        np.testing.assert_equal(coupon_anchor(features, primary), [230, 250, 200])
        with self.assertRaisesRegex(ValueError, "industry target"):
            coupon_anchor(features, CouponCandidate("ridge", "industry_excess", 5))

    def test_restored_prediction_contribution_and_js_agree_for_new_targets(self):
        panel = structural_panel()
        requests = panel.requests((0, 7, 30))
        features = panel.features(
            requests,
            include_weighted_primary=True,
            include_industry_tenor=True,
            include_industry_basis=True,
        )
        script = """import fs from 'node:fs';
import {couponPrediction,couponExplanation} from './online/coupon-model.mjs';
const x=JSON.parse(fs.readFileSync(process.argv[1]));
console.log(JSON.stringify(x.vectors.map((v,i)=>({p:couponPrediction(x.model,v,x.anchors[i]),s:couponExplanation(x.model,v,x.anchors[i])}))));"""
        for kind in ("ridge", "lgb"):
            for target, feature_set in (
                ("industry_excess", "combined"),
                ("primary_residual", "weighted_primary"),
                ("industry_basis_residual", "industry_basis"),
            ):
                with self.subTest(kind=kind, target=target):
                    model = CouponModel(
                        CouponCandidate(kind, target, 5, 0, feature_set)
                    ).fit(features, requests, "2025-09-01")
                    sample = features.iloc[-4:].copy()
                    sample.loc[sample.index[-1], "industry_aaa_tenor_bp"] = np.nan
                    sample.loc[sample.index[-1], "issuer_shrunk_premium_bp"] = np.nan
                    prediction = model.predict(sample)
                    contributions = model.contributions(sample)
                    np.testing.assert_allclose(
                        prediction, contributions.sum(axis=1), atol=1e-8
                    )
                    with tempfile.TemporaryDirectory() as tmp:
                        path = Path(tmp) / "case.json"
                        write_json(
                            path,
                            {
                                "model": model.export(),
                                "vectors": model.encode(sample).to_numpy().tolist(),
                                "anchors": sample.known_treasury_bp.tolist(),
                            },
                        )
                        values = json.loads(
                            subprocess.check_output(
                                [
                                    "node",
                                    "--input-type=module",
                                    "-e",
                                    script,
                                    str(path),
                                ],
                                text=True,
                            )
                        )
                    np.testing.assert_allclose(
                        [v["p"] for v in values], prediction, atol=1e-8
                    )
                    np.testing.assert_allclose(
                        [v["s"]["values"] + [v["s"]["expected"]] for v in values],
                        contributions,
                        atol=1e-8,
                    )

    def test_versioned_protocol_preserves_original_and_freezes_new_registry(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "spec.json"
            spec = study_spec()
            spec.update(
                schema_version=2, candidates=[asdict(c) for c in STRUCTURAL_CANDIDATES]
            )
            path.write_text(json.dumps(spec))
            self.assertEqual(load_spec(path)[0], spec)
            spec["candidates"][2]["years"] = 2
            path.write_text(json.dumps(spec))
            with self.assertRaisesRegex(ValueError, "exactly"):
                load_spec(path)
            spec.update(
                schema_version=3, candidates=[asdict(c) for c in ROBUST_CANDIDATES]
            )
            path.write_text(json.dumps(spec))
            self.assertEqual(load_spec(path)[0], spec)

    def test_robust_losses_have_explicit_units_and_do_not_publish_expected_savings(
        self,
    ):
        panel = structural_panel()
        requests = panel.requests((0, 7, 30))
        features = panel.features(
            requests, include_weighted_primary=True, include_industry_tenor=True
        )
        for profile, loss, estimand in (
            (4, "regression_l1", "conditional_median"),
            (5, "huber", "huber_center"),
        ):
            model = CouponModel(
                CouponCandidate(
                    "lgb", "industry_excess", 3, profile, "combined", "front30"
                )
            ).fit(features, requests, "2025-09-01")
            self.assertEqual(model.audit["loss"], loss)
            self.assertEqual(model.audit["estimand"], estimand)
            if profile == 5:
                self.assertEqual(model.estimator.get_params()["alpha"], 10)
                self.assertEqual(model.audit["huber_delta_bp"], 10)
            np.testing.assert_allclose(
                model.predict(features.iloc[-2:]),
                model.contributions(features.iloc[-2:]).sum(axis=1),
                atol=1e-8,
            )
            with self.assertRaisesRegex(ValueError, "cannot publish"):
                coupon_snapshot(panel, model, {}, "2026-09-23", 30, {}, 30)

    def test_tenor_day_counts_do_not_fragment_protective_groups(self):
        rows = paired_fixture()
        rows["tenor"] = [1.0027, 1.0055] * 22
        groups = group_diagnostics(rows)
        tenor = [g for g in groups if g["dimension"] == "tenor_bucket"]
        self.assertEqual(len(tenor), 1)
        self.assertEqual(tenor[0]["candidate"]["samples"], 44)
        self.assertTrue(tenor[0]["sufficient"])
        old = group_diagnostics(rows, business_tenors=False)
        self.assertEqual(len([g for g in old if g["dimension"] == "tenor"]), 2)

    def test_both_control_gates_are_required(self):
        rows = paired_fixture(301).drop(columns="predicted_bp_b0")
        b2 = rows.assign(predicted_bp=[310, 290] * 22)
        b0 = rows.assign(predicted_bp=300)
        report = structural_report(rows, b2, b0)
        self.assertFalse(report["gates"]["passed"])
        self.assertIn("b0_h30_mae_improvement", report["gates"]["failures"])

    def test_missing_secondary_paths_stay_in_requested_denominator(self):
        panel = structural_panel()
        requests = panel.requests((0, 7, 30))
        features = panel.features(
            requests, include_weighted_primary=True, include_industry_tenor=True
        )
        model = CouponModel(
            CouponCandidate("ridge", "industry_excess", 5, 0, "combined")
        ).fit(features, requests, "2025-09-01")
        rows = requests.loc[requests.lead_days.eq(30)].iloc[-2:]
        audit = coupon_timing_audit(panel, model, rows)
        summary = timing_summary(audit)
        self.assertEqual(summary["requested_events"], 2)
        self.assertEqual(summary["covered_events"], 2)
        self.assertEqual(len(summary["scenarios"]), 3)
        self.assertFalse(summary["production_eligible"])
        before = audit.copy()
        future = panel.industry_nodes.observation_date >= rows.origin.max()
        panel.industry_nodes.loc[future, "yield_pct"] += 0.5
        after = coupon_timing_audit(panel, model, rows)
        pd.testing.assert_series_equal(before.selected_date, after.selected_date)
        np.testing.assert_allclose(
            before.predicted_saving_bp, after.predicted_saving_bp
        )
        self.assertFalse(
            np.allclose(before.direction_error_bp, after.direction_error_bp)
        )
        panel.industry_nodes = None
        missing = timing_summary(coupon_timing_audit(panel, model, rows))
        self.assertEqual(missing["requested_events"], 2)
        self.assertEqual(missing["covered_events"], 0)
