"""Public population is shared by training, history and the online runtime."""

from dataclasses import asdict
import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import pandas as pd

from data.issuance_sample_scope import scoped_coupon_inputs
from data.industry_source import PROFILE
from model.issuance_output import coupon_snapshot
from model.issuance_study import save_development
from model.issuance_study_protocol import PUBLIC_CANDIDATES, load_spec
from tests.test_issuance_study import paired_fixture, study_spec
from tests.test_unified_coupon import sample_panel


class PublicCouponTests(unittest.TestCase):
    def test_scope_preserves_raw_and_filters_all_bond_histories_in_both_runtimes(self):
        inputs = {
            "issuance_scope": "public_only",
            "datasets": {
                "bond_issuance": [
                    {"bond_code": code, "placement_type": placement}
                    for code, placement in (
                        ("A.SH", "公募"),
                        ("B.SH", "私募"),
                        ("C.SH", None),
                    )
                ],
                "issue": [
                    {"entity_key": code.lower()} for code in ("A.SH", "B.SH", "C.SH")
                ],
                "issuer_daily": [
                    {"placement_type": p} for p in ("公募", "私募", "未知")
                ],
                "funding": [{"value": 1}],
            },
        }
        original = copy.deepcopy(inputs)
        actual, audit = scoped_coupon_inputs(inputs)
        self.assertEqual(inputs, original)
        self.assertEqual(len(actual["datasets"]["bond_issuance"]), 1)
        self.assertEqual(actual["datasets"]["issue"], [{"entity_key": "a.sh"}])
        self.assertEqual(
            actual["datasets"]["issuer_daily"], [{"placement_type": "公募"}]
        )
        self.assertEqual(audit["scope_excluded_private_events"], 1)
        self.assertEqual(audit["scope_excluded_unknown_events"], 1)
        script = """import fs from 'node:fs';
import {couponInputs} from './online/coupon-features.mjs';
const x=JSON.parse(fs.readFileSync(process.argv[1]));
console.log(JSON.stringify(couponInputs(x)));"""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "inputs.json"
            path.write_text(json.dumps(inputs))
            js = json.loads(
                subprocess.check_output(
                    ["node", "--input-type=module", "-e", script, str(path)], text=True
                )
            )
        self.assertEqual(js, actual)
        old = {**inputs, "issuance_scope": "all"}
        self.assertIs(scoped_coupon_inputs(old)[0], old)
        with self.assertRaisesRegex(ValueError, "unsupported"):
            scoped_coupon_inputs({**inputs, "issuance_scope": "typo"})

    def test_public_snapshot_rejects_private_and_unknown_before_prediction(self):
        from types import SimpleNamespace

        panel = sample_panel()
        panel.audit["issuance_scope"] = "public_only"
        model = SimpleNamespace(candidate=SimpleNamespace(estimand="conditional_mean"))
        for placement in ("私募", "未知", None):
            with self.assertRaisesRegex(ValueError, "confirmed public"):
                coupon_snapshot(
                    panel,
                    model,
                    {},
                    "2026-09-23",
                    30,
                    {"placement_type": placement},
                    30,
                )

    def test_public_registry_and_authorized_selection_preserve_failed_gates(self):
        self.assertEqual(len(PUBLIC_CANDIDATES), 19)
        spec = {
            **study_spec(),
            "schema_version": 5,
            "issuance_scope": "public_only",
            "release_policy": "user_authorized_best_mean",
            "candidates": [asdict(c) for c in PUBLIC_CANDIDATES],
        }
        rows = (
            paired_fixture(301)
            .drop(columns="predicted_bp_b0")
            .assign(placement_type="公募")
        )
        results = {
            c.name: rows.assign(predicted_bp=300.0 + i)
            for i, c in enumerate(PUBLIC_CANDIDATES)
        }
        # A robust model can have lower MAE; it must not become an expected-cost model.
        robust = next(c for c in PUBLIC_CANDIDATES if c.estimand != "conditional_mean")
        results[robust.name] = rows.assign(predicted_bp=300.0)
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch(
                "model.issuance_study.pricing_decomposition",
                return_value=pd.DataFrame(),
            ),
        ):
            root = Path(tmp)
            request = root / "request.json"
            request.write_text(json.dumps(spec))
            self.assertEqual(load_spec(request)[0], spec)
            selection = save_development(None, results, {}, root, "identity", spec)
            self.assertEqual(selection["status"], "user_authorized_best_public_mean")
            self.assertNotEqual(selection["selected"], asdict(robust))
            self.assertFalse(selection["selected_passed_gates"])
            failed = save_development(
                None, results, {"missing": "fit failed"}, root, "identity", spec
            )
            self.assertIsNone(failed["selected"])


class PublicReleaseEntryTests(unittest.TestCase):
    def test_online_infer_fetches_manifest_groups_and_binds_scope(self):
        from online_pipeline import run_online

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = {
                "required_input_groups": ["funding", "industry_nodes"],
                "issuance_scope": "public_only",
            }
            (root / "manifest.json").write_text(json.dumps(manifest))
            (root / "result.json").write_text("{}")
            with (
                patch(
                    "application.online.fetch_inputs",
                    return_value={"as_of_date": "2026-10-02", "datasets": {}},
                ) as fetch,
                patch("application.online.subprocess.run"),
                patch("model.release_eligibility.require_active_model"),
            ):
                run_online("infer", root, "2026-10-02")
            fetch.assert_called_once_with(
                "2026-10-02", groups=("funding", "industry_nodes")
            )
            self.assertEqual(
                json.loads((root / "inputs.json").read_text())["issuance_scope"],
                "public_only",
            )

    def test_normal_forecast_uses_locked_candidate_input_groups(self):
        from pipeline import run_issuance_forecast

        candidate = next(
            c
            for c in PUBLIC_CANDIDATES
            if c.target == "industry_excess" and c.estimand == "conditional_mean"
        )
        value = {"candidate": asdict(candidate), "issuance_scope": "public_only"}
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch("model.issuance_release.load_public_release", return_value=value),
            patch("model.release_eligibility.require_active_model"),
            patch(
                "application.forecast._coupon_inputs",
                return_value={"as_of_date": "2026-10-02", "datasets": {}},
            ) as inputs,
            patch(
                "data.issuance_training.IssuancePanel.from_inputs",
                side_effect=RuntimeError("panel sentinel"),
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "panel sentinel"):
                run_issuance_forecast(
                    Path(tmp),
                    "2026-10-02",
                    30,
                    None,
                    {"placement_type": "公募"},
                    coupon_selection=Path("frozen.json"),
                )
            self.assertIn("industry_nodes", inputs.call_args.args[3])

    def test_release_rejects_smoke_stage_and_missing_validation_rows(self):
        from model.issuance_release import build_public_release
        from model.issuance_diagnostics import period_metrics

        candidate = PUBLIC_CANDIDATES[0]
        selection = {
            "selected": asdict(candidate),
            "identity_sha256": "identity",
            "selected_passed_gates": False,
        }
        rows = (
            paired_fixture()
            .drop(columns="predicted_bp_b0")
            .assign(
                placement_type="公募",
                origin="2025-10-01",
                label_available_date="2025-11-01",
            )
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            protocol = root / "development.json"
            protocol.write_text("{}")
            spec = {
                "stage": "smoke",
                "development_end": "2025-09-01",
                "as_of": "2026-09-23",
            }
            report = {
                "stage": "smoke",
                "identity_sha256": "identity",
                "failures": {},
                "metrics": {
                    candidate.name: period_metrics(rows, split="historical-report")
                },
            }
            (root / "protocol.json").write_text(
                json.dumps({"spec": spec, "identity_sha256": "identity"})
            )
            (root / "report.json").write_text(json.dumps(report))
            with (
                patch(
                    "model.issuance_release._public_selection",
                    return_value=(root / "selection.json", selection, protocol),
                ),
                patch("model.issuance_release._verified_months", return_value=rows),
            ):
                with self.assertRaisesRegex(ValueError, "historical validation"):
                    build_public_release(root / "selection.json", root, None)
                spec["stage"] = "historical-report"
                report["stage"] = "historical-report"
                (root / "protocol.json").write_text(
                    json.dumps({"spec": spec, "identity_sha256": "identity"})
                )
                (root / "report.json").write_text(json.dumps(report))
                with patch(
                    "model.issuance_release._verified_months",
                    return_value=rows.iloc[:-1],
                ):
                    with self.assertRaisesRegex(ValueError, "denominator"):
                        build_public_release(root / "selection.json", root, None)

    def test_load_release_rejects_edited_metrics(self):
        from model.issuance_release import load_public_release

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sel = root / "selection.json"
            protocol = root / "protocol.json"
            report = root / "report.json"
            for p in (sel, protocol, report):
                p.write_text("{}")
            from model.issuance_study_protocol import digest

            value = {
                "candidate": {},
                "issuance_scope": "public_only",
                "selection_path": str(sel),
                "selection_sha256": digest(sel),
                "protocol_sha256": digest(protocol),
                "historical_report_path": str(report),
                "historical_report_sha256": digest(report),
                "metrics": [{"mae_bp": 1}],
            }
            path = root / "release.json"
            path.write_text(json.dumps(value))
            expected = {**value, "metrics": [{"mae_bp": 2}]}
            with (
                patch(
                    "model.issuance_release._public_selection",
                    return_value=(sel, {"selected": {}}, protocol),
                ),
                patch(
                    "model.issuance_release.build_public_release", return_value=expected
                ),
            ):
                with self.assertRaisesRegex(ValueError, "monthly evidence"):
                    load_public_release(path)


class HuberPointPublicationTests(unittest.TestCase):
    def test_authorized_huber_has_null_savings_and_unchanged_shap_additivity(self):
        import numpy as np
        from model.issuance_unified import CouponModel, CouponCandidate
        from model.issuance_export import export_coupon_bundle
        from tests.test_coupon_structural import structural_panel

        panel = structural_panel()
        panel.audit["issuance_scope"] = "public_only"
        panel.rates.audit = {"feature_groups": []}
        panel.rates.levels_bp = pd.DataFrame(
            {"GOV_3Y": panel.rates.market_features.rate_gov_3y_level * 100}
        )
        panel.events = panel.events.loc[
            panel.events.placement_type.eq("公募")
        ].reset_index(drop=True)
        requests = panel.requests((0, 7, 30))
        candidate = CouponCandidate(
            "lgb", "industry_excess", 5, 5, "combined", "front30"
        )
        features = panel.features(
            requests, include_weighted_primary=True, include_industry_tenor=True
        )
        model = CouponModel(candidate).fit(features, requests, "2026-09-01")
        model.audit["issuance_scope"] = "public_only"
        evaluation = {
            "estimand": "huber_center",
            "issuance_scope": "public_only",
            "expected_savings_supported": False,
            "release_policy": "user_authorized_best_public_point",
            "metrics": [],
        }
        terms = {
            "issuer": "issuer1",
            "rating": "AAA",
            "bond_type": "证券公司债",
            "placement_type": "公募",
            "tenor": 3,
        }
        snapshot = coupon_snapshot(
            panel, model, evaluation, "2026-09-23", 30, terms, 30
        )
        self.assertIn("not expected", snapshot["decision"]["scope"])
        for row in snapshot["forecast"]:
            for field in ("expected_saving_bp", "net_saving_bp", "annual_saving_wan"):
                self.assertIsNone(row[field])
        for field in (
            "expected_net_saving_bp",
            "annual_saving_wan",
            "saving_probability",
            "saving_p10_bp",
        ):
            self.assertIsNone(snapshot["decision"][field])
        explanation = snapshot["explanation"]
        self.assertAlmostEqual(
            explanation["base_coupon_bp"]
            + sum(x["shap_bp"] for x in explanation["features"]),
            explanation["prediction_coupon_bp"],
        )
        np.testing.assert_allclose(
            model.predict(features),
            model.contributions(features).sum(axis=1),
            atol=1e-8,
        )
        nodes = panel.industry_nodes.assign(
            observation_date=panel.industry_nodes.observation_date.dt.strftime(
                "%Y-%m-%d"
            )
        ).to_dict(orient="records")
        inputs = {
            "issuance_scope": "public_only",
            "datasets": {"industry_nodes": nodes},
            "industry_source_profile": PROFILE,
        }
        with tempfile.TemporaryDirectory() as tmp:
            manifest = export_coupon_bundle(
                panel, model, evaluation, inputs, snapshot, Path(tmp)
            )
            self.assertEqual(manifest["estimand"], "huber_center")
            self.assertIs(manifest["expected_savings_supported"], False)
        for changed in (
            {**evaluation, "estimand": "conditional_mean"},
            {**evaluation, "expected_savings_supported": True},
            {},
        ):
            with self.assertRaisesRegex(ValueError, "cannot publish"):
                coupon_snapshot(panel, model, changed, "2026-09-23", 30, terms, 30)
