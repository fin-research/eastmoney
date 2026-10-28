"""Study boundaries, immutable inputs, paired gates and offline dispatch."""

from dataclasses import asdict
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

from model.issuance_study import (
    checkpoint_guard,
    historical_candidate,
    save_development,
)
from model.issuance_study_protocol import (
    STUDY_CANDIDATES,
    digest,
    immutable_json,
    load_spec,
    load_study_inputs,
    stage_mask,
    validate_rows,
)
from model.issuance_study_report import development_gates, pricing_decomposition
from tests.test_unified_coupon import sample_panel


def study_spec(stage="development"):
    return {
        "schema_version": 1,
        "stage": stage,
        "as_of": "2026-09-23",
        "development_start": "2023-01-01",
        "development_end": "2025-09-01",
        "candidates": [asdict(c) for c in STUDY_CANDIDATES],
        "input_sha256": "a" * 64,
        "nodes_sha256": "b" * 64,
        "nodes_path": "nodes.csv",
    }


def paired_fixture(prediction=301.0):
    return pd.DataFrame(
        [
            {
                "bond_code": f"{year}-{i}",
                "origin": f"{year}-01-01",
                "lead_days": 30,
                "pricing_date": f"{year}-01-31",
                "year": year,
                "tenor": 3.0,
                "issuer": "example",
                "rating": "AAA",
                "bond_type": "证券公司债",
                "placement_type": "公募",
                "coupon_bp": 300.0,
                "predicted_bp": prediction,
                "predicted_bp_b0": 310.0 if i % 2 else 290.0,
            }
            for year in (2023, 2024)
            for i in range(22)
        ]
    )


class IssuanceStudyTests(unittest.TestCase):
    def test_stage_masks_use_mature_labels_and_never_cross_final(self):
        requests = pd.DataFrame(
            {
                "origin": pd.to_datetime(
                    [
                        "2023-01-01",
                        "2023-02-01",
                        "2025-08-20",
                        "2025-09-01",
                        "2026-09-20",
                    ]
                ),
                "label_available_date": pd.to_datetime(
                    [
                        "2023-01-31",
                        "2023-03-01",
                        "2025-09-19",
                        "2025-10-01",
                        "2026-09-23",
                    ]
                ),
                "lead_days": [30] * 5,
            }
        )
        self.assertEqual(
            stage_mask(requests, study_spec()).tolist(),
            [True, True, False, False, False],
        )
        self.assertEqual(
            stage_mask(requests, study_spec("smoke")).tolist(),
            [True, False, False, False, False],
        )
        self.assertEqual(
            stage_mask(requests, study_spec("historical-report")).tolist(),
            [False, False, False, True, False],
        )

    def test_fixed_registry_input_hash_and_immutable_protocol(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "spec.json"
            spec = study_spec()
            path.write_text(json.dumps(spec))
            self.assertEqual(load_spec(path)[0], spec)
            with self.assertRaisesRegex(ValueError, "as-of"):
                load_spec(path, "2026-09-22")
            spec["candidates"][1]["profile"] = 3
            path.write_text(json.dumps(spec))
            with self.assertRaisesRegex(ValueError, "exactly"):
                load_spec(path)
            with self.assertRaisesRegex(ValueError, "input SHA"):
                load_study_inputs(path, path, study_spec())
            target = Path(tmp) / "protocol.json"
            immutable_json(target, {"data": 1})
            original = target.read_bytes()
            with self.assertRaisesRegex(ValueError, "fingerprint"):
                immutable_json(target, {"data": 2})
            self.assertEqual(target.read_bytes(), original)

    def test_checkpoint_rejects_missing_events_changed_labels_and_nan(self):
        rows = paired_fixture()
        self.assertEqual(len(validate_rows(rows, rows)), 44)
        for bad in (
            rows.iloc[:-1],
            rows.assign(coupon_bp=301),
            rows.assign(predicted_bp=np.nan),
            pd.concat([rows.iloc[:-1], rows.iloc[:1]]),
        ):
            with self.subTest(size=len(bad)), self.assertRaises(ValueError):
                validate_rows(bad, rows)

    def test_bias_gate_blocks_better_mae_and_small_groups_stay_diagnostic(self):
        good = development_gates(paired_fixture())
        self.assertTrue(good["passed"])
        failed = development_gates(paired_fixture(302.0))
        self.assertLess(
            failed["h30"]["candidate"]["mae_bp"], failed["h30"]["b0"]["mae_bp"]
        )
        self.assertEqual(failed["failures"], ["h30_absolute_bias"])
        group = paired_fixture()
        group.loc[0, "rating"] = "AA"
        self.assertFalse(
            next(r for r in development_gates(group)["groups"] if r["value"] == "AA")[
                "sufficient"
            ]
        )

    def test_failed_matrix_has_no_selection_and_does_not_run_final(self):
        rows = paired_fixture(302.0).drop(columns=["predicted_bp_b0"])
        control = rows.assign(predicted_bp=[290, 310] * 22)
        results = {c.name: rows.copy() for c in STUDY_CANDIDATES}
        results[STUDY_CANDIDATES[0].name] = control
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch(
                "model.issuance_study.pricing_decomposition",
                return_value=pd.DataFrame(),
            ),
        ):
            result = save_development(None, results, {}, Path(tmp), "identity")
            self.assertIsNone(result["selected"])
            self.assertFalse(result["final_period_touched"])
            self.assertFalse((Path(tmp) / "test").exists())

    def test_historical_report_rejects_unqualified_or_changed_selection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            protocol = {"identity": {}, "identity_sha256": "id", "spec": study_spec()}
            (root / "protocol.json").write_text(json.dumps(protocol))
            selection = {
                "identity_sha256": "id",
                "selected": None,
                "final_period_touched": False,
            }
            path = root / "selection.json"
            path.write_text(json.dumps(selection))
            spec = {
                **study_spec("historical-report"),
                "development_directory": ".",
                "selection_sha256": digest(path),
            }
            with self.assertRaisesRegex(ValueError, "qualified"):
                historical_candidate(spec, root / "request.json", {})
            path.write_text(
                json.dumps({**selection, "selected": asdict(STUDY_CANDIDATES[1])})
            )
            with self.assertRaisesRegex(ValueError, "SHA256"):
                historical_candidate(spec, root / "request.json", {})
            selection.update(
                selected=asdict(STUDY_CANDIDATES[1]),
                status="qualified_for_historical_report",
                failures={},
                ranking=[
                    {
                        "candidate": asdict(STUDY_CANDIDATES[1]),
                        "gates": {"passed": False},
                    }
                ],
            )
            path.write_text(json.dumps(selection))
            spec["selection_sha256"] = digest(path)
            with self.assertRaisesRegex(ValueError, "did not pass"):
                historical_candidate(spec, root / "request.json", {})

    def test_checkpoint_receipt_rejects_replaced_predictions_or_candidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "2024-01.csv"
            path.write_text("predicted_bp\n300\n")
            path.with_suffix(".diagnostics.json").write_text("{}")
            with self.assertRaisesRegex(ValueError, "receipt"):
                checkpoint_guard(path, False, "id", STUDY_CANDIDATES[0])
            checkpoint_guard(path, True, "id", STUDY_CANDIDATES[0])
            checkpoint_guard(path, False, "id", STUDY_CANDIDATES[0])
            with self.assertRaisesRegex(ValueError, "fingerprint"):
                checkpoint_guard(path, False, "id", STUDY_CANDIDATES[1])
            path.write_text("predicted_bp\n301\n")
            with self.assertRaisesRegex(ValueError, "fingerprint"):
                checkpoint_guard(path, False, "id", STUDY_CANDIDATES[0])

    def test_decomposition_uses_each_bond_tenor_and_realized_rates_only_in_report(self):
        panel = sample_panel()
        requests = panel.requests((30,)).iloc[-3:].copy()
        requests["tenor"] = [3, 5, 10]
        rows = requests.assign(predicted_bp=300.0, simple_bp=290.0)
        before = panel.rates.market_features.copy()
        diagnostic = pricing_decomposition(panel, rows)
        np.testing.assert_allclose(
            diagnostic.origin_anchor_bp, [230, 230 + 80 / 7, 270]
        )
        np.testing.assert_allclose(
            diagnostic.overprediction_bp,
            diagnostic.market_move_bp + diagnostic.excess_error_bp,
        )
        pd.testing.assert_frame_equal(panel.rates.market_features, before)
        self.assertFalse(diagnostic.coupon_publication_time_verified.any())

    def test_cli_requires_explicit_snapshot_and_backtest(self):
        result = subprocess.run(
            [sys.executable, "main.py", "--study-protocol", "missing.json"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("requires --issuance-backtest", result.stderr)

    def test_protocol_dispatch_cannot_call_online_fetch_or_default_evaluator(self):
        from pipeline import run_coupon_backtest

        with (
            patch("model.issuance_study.run_study", return_value={"ok": True}) as run,
            patch(
                "application.evaluation._coupon_inputs", side_effect=AssertionError("network path")
            ),
            patch(
                "model.issuance_evaluation.evaluate_coupons",
                side_effect=AssertionError("default search"),
            ),
        ):
            self.assertEqual(
                run_coupon_backtest(Path("out"), None, Path("input"), Path("spec")),
                {"ok": True},
            )
            run.assert_called_once_with(Path("spec"), Path("input"), Path("out"), None)
