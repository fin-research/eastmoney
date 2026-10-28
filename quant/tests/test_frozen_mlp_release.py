"""Seal membership, receipts and audit identity remain mandatory after selection."""

from copy import deepcopy
from dataclasses import asdict
import json
from pathlib import Path
import tempfile
import unittest

from model.frozen_mlp import POLICY, load_frozen_release
from model.issuance_study_protocol import digest
from model.issuance_unified import CouponCandidate
from tests.test_frozen_mlp import synthetic_state


class FrozenReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "study").mkdir()
        self.sources = {}
        state = synthetic_state()
        state.update(training_cutoff="2026-01-01", training_label_end="2025-12-23")
        self.folds = [f"tscv-{year}" for year in range(2021, 2026)] + [
            "validation-2026"
        ]
        self.save(
            "protocol",
            "study/protocol.json",
            {
                "settings": state["settings"],
                "folds": [{"name": name, "status": "ready"} for name in self.folds],
            },
        )
        state["protocol_sha256"] = self.sources["protocol"]["sha256"]
        self.save("state", "study/validation-2026.state.json", state)
        self.save("optimizer", "study/validation-2026.optimizer.json", {})
        self.save("optimizer_raw", "study/validation-2026.optimizer-raw.npz", {})
        self.save(
            "optimizer_warnings",
            "study/validation-2026.optimizer-raw.warnings.json",
            {},
        )
        self.save("predictions", "study/validation-2026.csv", {})
        receipt = {"protocol_sha256": self.sources["protocol"]["sha256"]}
        for name, key in [
            ("state", "state"),
            ("optimizer", "optimizer"),
            ("optimizer_raw", "optimizer_raw"),
            ("optimizer_warnings", "optimizer_warnings"),
            ("predictions", "predictions"),
        ]:
            receipt[key + "_sha256"] = self.sources[name]["sha256"]
        self.save("receipt", "study/validation-2026.receipt.json", receipt)
        self.save("attempt", "study/validation-2026.attempt.json", {})
        originals = list(self.sources.items())
        for fold in self.folds[:-1]:
            for name, source in originals:
                if name == "protocol":
                    continue
                target = Path(source["path"]).name.replace("validation-2026", fold)
                self.save(
                    fold + name,
                    "study/" + target,
                    json.loads(Path(source["path"]).read_text()),
                )
        audit = dict(
            all_passed=True,
            fit_calls=0,
            states=6,
            checks=[{"fold": name} for name in self.folds],
            protocol_sha256=self.sources["protocol"]["sha256"],
            artifacts={
                Path(v["path"]).name: v["sha256"]
                for n, v in self.sources.items()
                if n != "protocol"
            },
        )
        self.save("audit", "study/all-independent-audit.json", audit)
        self.reseal()
        self.value = dict(
            release_policy=POLICY,
            adoption={"authorized_by": "user"},
            training_label_cutoff="2026-01-01",
            forecast_horizons=[1, 14, 30],
            expected_savings_supported=False,
            issuance_scope="public_only",
            candidate=asdict(
                CouponCandidate("mlp", "coupon", 0, feature_set="quote_history")
            ),
            metrics=[],
            training_tscv={"qualified": False},
            sources=self.sources,
        )
        self.path = self.root / "release.json"
        self.persist()

    def save(self, name, path, value):
        file = self.root / path
        file.write_text(json.dumps(value))
        self.sources[name] = {"path": str(file), "sha256": digest(file)}

    def reseal(self):
        items = [
            {"path": str(Path(v["path"]).relative_to(self.root)), "sha256": v["sha256"]}
            for n, v in self.sources.items()
            if n not in ("summary", "inventory")
        ]
        self.save("inventory", "inventory.final.json", items)
        self.save(
            "summary",
            "summary.json",
            dict(
                inventory_sha256=self.sources["inventory"]["sha256"],
                independent_audit_sha256=self.sources["audit"]["sha256"],
                validation={"metrics": []},
                tscv={"qualified": False},
            ),
        )

    def persist(self):
        self.path.write_text(json.dumps(self.value))

    def test_old_failed_qualification_does_not_block_loading(self):
        self.assertFalse(load_frozen_release(self.path)["training_tscv"]["qualified"])

    def test_rehashed_replacement_outside_inventory_is_rejected(self):
        replacement = self.root / "replacement.json"
        replacement.write_text(Path(self.sources["state"]["path"]).read_text())
        self.sources["state"] = {
            "path": str(replacement),
            "sha256": digest(replacement),
        }
        self.persist()
        with self.assertRaisesRegex(ValueError, "absent from sealed inventory"):
            load_frozen_release(self.path)

    def test_audit_failure_cannot_be_relabelled_as_successful_release(self):
        path = Path(self.sources["audit"]["path"])
        audit = json.loads(path.read_text())
        audit["all_passed"] = False
        self.save("audit", str(path.relative_to(self.root)), audit)
        self.reseal()
        self.persist()
        with self.assertRaisesRegex(ValueError, "independent audit mismatch"):
            load_frozen_release(self.path)

    def test_receipt_cannot_point_to_a_different_optimizer(self):
        path = Path(self.sources["receipt"]["path"])
        receipt = json.loads(path.read_text())
        receipt["optimizer_sha256"] = "0" * 64
        self.save("receipt", str(path.relative_to(self.root)), receipt)
        self.reseal()
        self.persist()
        with self.assertRaisesRegex(ValueError, "audit artifact|receipt or audit"):
            load_frozen_release(self.path)

    def test_metric_changes_do_not_modify_frozen_study(self):
        original = deepcopy(self.value)
        self.value["metrics"] = [{"mae_bp": 0}]
        self.persist()
        with self.assertRaisesRegex(ValueError, "differs from sealed evidence"):
            load_frozen_release(self.path)
        self.assertEqual(original["training_tscv"], self.value["training_tscv"])
