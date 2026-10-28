"""Synthetic registry boundaries; never real forward evidence."""

from concurrent.futures import ThreadPoolExecutor
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from application import prospective as app
from data.prospective_ledger import Ledger
from model import prospective_protocol as contract

AT = "2026-10-03T03:00:00+00:00"
SOURCE = b"synthetic scheme evidence"


def scheme(identity=True):
    return {
        "scheme_id": "plan",
        "version": 1,
        "parent_sha256": None,
        "issuer_id": "issuer",
        "terms": {
            "issuer": "synthetic issuer",
            "rating": "AAA",
            "tenor": 3,
            "bond_type": "证券公司债",
            "placement_type": "公募",
        },
        "issue_size_yi": 1,
        "bond_identity": {"code": "123456.SH", "original_issue_date": "2026-11-03"}
        if identity
        else None,
        "planned_pricing": {"start": "2026-11-01", "end": "2026-11-05"},
        "source_sha256": contract.checksum(SOURCE),
    }


class RegistryTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.ledger = Ledger(self.root / "ledger")
        for name in ("data.prospective_ledger.now", "application.prospective.now"):
            clock = patch(name, return_value=AT)
            clock.start()
            self.addCleanup(clock.stop)
        app.initialize(self.ledger, "synthetic", contract.CONTROL)
        self.bundle = self.root / "bundle"
        self.bundle.mkdir()
        model = contract.encoded({"candidate": contract.CONTROL})
        (self.bundle / "model.json").write_bytes(model)
        self.manifest = {
            "models": {
                "main": {"file": "model.json", "sha256": contract.checksum(model)}
            },
            "training_as_of": "2026-10-01",
            "retrain_after": "2026-10-31",
            "model_version": "synthetic",
            "calendar": {"year": 2026},
        }
        self.manifest_file = self.bundle / "manifest.json"
        self.manifest_file.write_bytes(contract.encoded(self.manifest))
        self.input_file = self.root / "inputs.json"
        self.input_file.write_bytes(contract.encoded({"as_of_date": "2026-10-03"}))

    def prepare(self, requests=("r1",), identity=True, candidate_manifest=None):
        registered = app.register_scheme(self.ledger, scheme(identity), SOURCE)
        batch = {
            "batch_id": "b1",
            "origin_date": "2026-10-03",
            "requests": [
                {
                    "request_id": request,
                    "scheme_sha256": registered["payload_sha256"],
                    "control_manifest_sha256": contract.checksum(
                        self.manifest_file.read_bytes()
                    ),
                    "candidate_manifest_sha256": contract.checksum(
                        candidate_manifest or self.manifest_file.read_bytes()
                    ),
                    "calendar_sha256": contract.checksum(
                        contract.encoded(self.manifest["calendar"])
                    ),
                    "input_sha256": contract.checksum(self.input_file.read_bytes()),
                    "window_days": 30,
                }
                for request in requests
            ],
        }
        app.register_batch(self.ledger, batch)
        return registered, batch

    def fake_infer(self, manifest, model, inputs, terms, window, input_sha256):
        result = {
            "terms": terms["terms"],
            "window_days": window,
            "as_of_date": inputs["as_of_date"],
            "issue_size_yi": terms["issue_size_yi"],
            "online_run": {
                "model_version": manifest["model_version"],
                "input_sha256": input_sha256,
            },
            "forecast": [{"date": "2026-11-02", "coupon_percent": 2.0}],
        }
        return contract.encoded(result), result

    def predict(self, request="r1"):
        return app.predict(
            self.ledger, "b1", request, self.bundle, self.bundle, self.input_file
        )

    def label(self, **changes):
        value = {
            "kind": "synthetic-label",
            "code": "123456.SH",
            "original_issue_date": "2026-11-03",
            "pricing_date": "2026-11-02",
            "coupon_percent": 2.1,
        }
        return app.register_synthetic_label(self.ledger, {**value, **changes})

    def test_protocol_and_explicit_terms_cannot_drift(self):
        value = copy.deepcopy(self.ledger.events()[0]["payload"])
        value["h30"] = "choose neighboring day"
        with self.assertRaisesRegex(ValueError, "rule mismatch"):
            contract.validate_protocol(value)
        for missing in ("placement_type", "rating"):
            value = scheme()
            del value["terms"][missing]
            with self.assertRaisesRegex(ValueError, "explicit"):
                app.register_scheme(self.ledger, value, SOURCE)
        with patch(
            "application.prospective.source_hashes", return_value={"changed": "0" * 64}
        ):
            with self.assertRaisesRegex(ValueError, "source or runtime changed"):
                app.audit_registry(self.ledger)

    def test_scheme_parent_keeps_original_and_rejects_branches(self):
        original, _ = self.prepare()
        value = scheme()
        value.update(version=2, parent_sha256=original["payload_sha256"])
        value["terms"]["tenor"] = 5
        revised = app.register_scheme(self.ledger, value, SOURCE)
        self.assertEqual(
            json.loads(self.ledger.object(original["payload_sha256"]))["terms"][
                "tenor"
            ],
            3,
        )
        self.assertEqual(
            app.register_scheme(self.ledger, value, SOURCE)["event_sha256"],
            revised["event_sha256"],
        )
        value["terms"]["tenor"] = 4
        with self.assertRaisesRegex(ValueError, "conflict"):
            app.register_scheme(self.ledger, value, SOURCE)
        value.update(version=3, parent_sha256=original["payload_sha256"])
        with self.assertRaisesRegex(ValueError, "parent"):
            app.register_scheme(self.ledger, value, SOURCE)

    def test_denominator_includes_failed_and_unexecuted_requests(self):
        self.prepare(("r1", "r2"))
        self.input_file.write_bytes(b"{}")
        outcome = self.predict()
        self.assertEqual(outcome["payload"]["status"], "failed")
        self.assertIn(contract.checksum(b"{}"), outcome["attachments"])
        audit = app.audit_registry(self.ledger)
        self.assertEqual(
            (audit["expected_requests"], audit["executed_requests"]), (2, 1)
        )
        self.assertEqual(
            [row["status"] for row in audit["rows"]], ["failed", "not_executed"]
        )
        self.assertEqual(audit["eligible_forward_events"], 0)

    def test_batch_is_required_and_requests_cannot_be_reused(self):
        with self.assertRaisesRegex(ValueError, "registered first"):
            self.predict()
        _, batch = self.prepare()
        batch["batch_id"] = "other"
        with self.assertRaisesRegex(ValueError, "reused"):
            app.register_batch(self.ledger, batch)
        with self.assertRaisesRegex(ValueError, "denominator"):
            self.predict("unknown")

    def test_partial_pair_and_retry_do_not_replace_results(self):
        self.prepare()
        result = self.fake_infer(
            self.manifest, {}, {"as_of_date": "2026-10-03"}, scheme(), 30, "0" * 64
        )
        with patch(
            "application.prospective._infer",
            side_effect=[result, ValueError("synthetic candidate failure")],
        ):
            first = self.predict()
        self.assertEqual(first["payload"]["roles"]["control"]["status"], "success")
        self.assertEqual(first["payload"]["roles"]["candidate"]["status"], "failed")
        with patch(
            "application.prospective._infer",
            side_effect=AssertionError("must not execute"),
        ):
            retry = self.predict()
        self.assertEqual(first["event_sha256"], retry["event_sha256"])

    def test_frozen_manifests_models_methods_and_monthly_rule_reject_drift(self):
        original_model = (self.bundle / "model.json").read_bytes()
        for failure in ("manifest", "model", "validity", "method"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as path:
                ledger = Ledger(path)
                app.initialize(ledger, "synthetic", contract.CONTROL)
                event = app.register_scheme(ledger, scheme(), SOURCE)
                manifest = copy.deepcopy(self.manifest)
                if failure == "validity":
                    manifest["retrain_after"] = "2027-01-01"
                if failure == "method":
                    changed = {**contract.CONTROL, "years": 3}
                    model = contract.encoded({"candidate": changed})
                    (self.bundle / "model.json").write_bytes(model)
                    manifest["models"]["main"]["sha256"] = contract.checksum(model)
                self.manifest_file.write_bytes(contract.encoded(manifest))
                batch = {
                    "batch_id": "b1",
                    "origin_date": "2026-10-03",
                    "requests": [
                        {
                            "request_id": "r1",
                            "scheme_sha256": event["payload_sha256"],
                            "control_manifest_sha256": contract.checksum(
                                self.manifest_file.read_bytes()
                            ),
                            "candidate_manifest_sha256": contract.checksum(
                                self.manifest_file.read_bytes()
                            ),
                            "calendar_sha256": contract.checksum(
                                contract.encoded(self.manifest["calendar"])
                            ),
                            "input_sha256": contract.checksum(
                                self.input_file.read_bytes()
                            ),
                            "window_days": 30,
                        }
                    ],
                }
                app.register_batch(ledger, batch)
                if failure == "manifest":
                    self.manifest_file.write_bytes(b"{}")
                if failure == "model":
                    (self.bundle / "model.json").write_bytes(b"{}")
                result = app.predict(
                    ledger, "b1", "r1", self.bundle, self.bundle, self.input_file
                )
                self.assertEqual(result["payload"]["status"], "failed")
                self.assertEqual(app.audit_registry(ledger)["expected_requests"], 1)
                self.manifest_file.write_bytes(contract.encoded(self.manifest))
                (self.bundle / "model.json").write_bytes(original_model)

    def test_synthetic_h30_selection_is_by_commit_order_and_never_forward(self):
        self.prepare(("r1", "r2"))
        with patch("application.prospective._infer", side_effect=self.fake_infer):
            self.predict("r2")
            self.predict("r1")
        self.label()
        audit = app.audit_registry(self.ledger)
        self.assertEqual(audit["synthetic_h30_events"], 1)
        rows = {row["request_id"]: row for row in audit["rows"]}
        self.assertEqual(rows["r1"]["status"], "duplicate_event_origin")
        self.assertEqual(rows["r2"]["status"], "synthetic_h30_local_unanchored")
        self.assertTrue(all(not row["forward_eligible"] for row in audit["rows"]))

    def test_unknown_identity_cannot_select_future_label(self):
        self.prepare(identity=False)
        with patch("application.prospective._infer", side_effect=self.fake_infer):
            self.predict()
        self.label()
        self.assertEqual(
            app.audit_registry(self.ledger)["rows"][0]["status"], "unresolved_identity"
        )

    def test_first_pair_is_locked_before_future_exact_point_filter(self):
        self.prepare(("r1", "r2"))
        calls = []

        def infer(*args):
            _, result = self.fake_infer(*args)
            if len(calls) < 2:
                result["forecast"][0]["date"] = "2026-11-01"
            calls.append(1)
            return contract.encoded(result), result

        with patch("application.prospective._infer", side_effect=infer):
            self.predict("r1")
            self.predict("r2")
        self.label()
        audit = app.audit_registry(self.ledger)
        self.assertEqual(
            [row["status"] for row in audit["rows"]],
            ["exact_pricing_point_unavailable", "duplicate_event_origin"],
        )
        self.assertEqual(audit["synthetic_h30_events"], 0)

    def test_interrupted_attempt_is_unknown_and_never_silently_reexecuted(self):
        _, batch = self.prepare()
        event = next(row for row in self.ledger.events() if row["kind"] == "batch")
        self.ledger.append(
            "attempt",
            "attempt:r1",
            {"batch_sha256": event["payload_sha256"], "request": batch["requests"][0]},
        )
        self.assertEqual(
            app.audit_registry(self.ledger)["rows"][0]["status"], "interrupted_unknown"
        )
        with patch(
            "application.prospective._infer",
            side_effect=AssertionError("must not rerun"),
        ):
            outcome = self.predict()
        self.assertEqual(outcome["payload"]["status"], "interrupted_unknown")
        self.assertEqual(app.audit_registry(self.ledger)["executed_requests"], 1)

    def test_label_known_before_prediction_is_explicit_replay(self):
        self.prepare()
        self.label()
        with patch("application.prospective._infer", side_effect=self.fake_infer):
            self.predict()
        audit = app.audit_registry(self.ledger)
        self.assertEqual(audit["rows"][0]["status"], "known_synthetic_label_replay")
        self.assertEqual(audit["synthetic_h30_events"], 0)

    def test_shared_calendar_is_registered_before_both_predictions(self):
        candidate = self.root / "candidate"
        candidate.mkdir()
        manifest = {**self.manifest, "calendar": {"year": 2027}}
        bytes_ = contract.encoded(manifest)
        (candidate / "manifest.json").write_bytes(bytes_)
        (candidate / "model.json").write_bytes(
            (self.bundle / "model.json").read_bytes()
        )
        self.prepare(candidate_manifest=bytes_)
        with patch("application.prospective._infer", side_effect=self.fake_infer):
            result = app.predict(
                self.ledger, "b1", "r1", self.bundle, candidate, self.input_file
            )
        self.assertEqual(result["payload"]["roles"]["control"]["status"], "success")
        self.assertIn(
            "shared calendar mismatch",
            result["payload"]["roles"]["candidate"]["reason"],
        )
        self.assertEqual(result["payload"]["status"], "failed")

    def test_concurrent_same_request_commits_one_pair_only(self):
        self.prepare()
        with patch(
            "application.prospective._infer", side_effect=self.fake_infer
        ) as infer:
            with ThreadPoolExecutor(max_workers=4) as pool:
                outcomes = list(pool.map(lambda _: self.predict(), range(8)))
        self.assertEqual(infer.call_count, 2)
        self.assertEqual(len({row["event_sha256"] for row in outcomes}), 1)
        self.assertEqual(app.audit_registry(self.ledger)["executed_requests"], 1)

    def test_cross_day_commit_is_not_promoted_to_same_day_h30(self):
        self.prepare()
        with (
            patch("application.prospective._infer", side_effect=self.fake_infer),
            patch(
                "data.prospective_ledger.now",
                side_effect=[AT, "2026-10-04T03:00:00+00:00"],
            ),
        ):
            self.predict()
        self.label()
        self.assertEqual(
            app.audit_registry(self.ledger)["rows"][0]["status"], "replay_or_late"
        )

    def test_conflicting_labels_cannot_select_closest_coupon(self):
        self.prepare()
        with patch("application.prospective._infer", side_effect=self.fake_infer):
            self.predict()
        self.label()
        self.label(coupon_percent=1.9)
        self.assertEqual(
            app.audit_registry(self.ledger)["rows"][0]["status"],
            "synthetic_label_ambiguous",
        )

    def test_origin_backfill_is_not_h30(self):
        self.prepare()
        with (
            patch("application.prospective._infer", side_effect=self.fake_infer),
            patch(
                "application.prospective.now", return_value="2026-10-04T03:00:00+00:00"
            ),
        ):
            self.predict()
        self.label()
        self.assertEqual(
            app.audit_registry(self.ledger)["rows"][0]["status"], "replay_or_late"
        )

    def test_exact_point_and_preexisting_scheme_are_required(self):
        with patch(
            "data.prospective_ledger.now", return_value="2026-10-01T03:00:00+00:00"
        ):
            self.prepare()

        def missing_point(*args):
            _, result = self.fake_infer(*args)
            result["forecast"][0]["date"] = "2026-11-01"
            return contract.encoded(result), result

        with patch("application.prospective._infer", side_effect=missing_point):
            self.predict()
        self.label()
        self.assertEqual(
            app.audit_registry(self.ledger)["rows"][0]["status"],
            "exact_pricing_point_unavailable",
        )

    def test_cancel_and_conditions_changed_remain_in_denominator(self):
        event, _ = self.prepare()
        with patch("application.prospective._infer", side_effect=self.fake_infer):
            self.predict()
        self.label()
        value = scheme()
        value.update(version=2, parent_sha256=event["payload_sha256"])
        app.register_scheme(self.ledger, value, SOURCE)
        self.assertEqual(
            app.audit_registry(self.ledger)["rows"][0]["status"], "conditions_changed"
        )
        app.cancel_scheme(self.ledger, event["payload_sha256"])
        self.assertEqual(
            app.audit_registry(self.ledger)["rows"][0]["status"], "cancelled"
        )
        self.assertEqual(app.audit_registry(self.ledger)["expected_requests"], 1)


class LedgerStorageTest(unittest.TestCase):
    def test_concurrent_commit_conflict_restart_and_integrity(self):
        with tempfile.TemporaryDirectory() as path:

            def submit(index):
                return Ledger(path).append(
                    "test", f"key-{index}", {"index": index}, [b"synthetic"]
                )

            with ThreadPoolExecutor(max_workers=8) as pool:
                rows = list(pool.map(submit, range(24)))
            self.assertEqual(len({row["sequence"] for row in rows}), 24)
            ledger = Ledger(path)
            self.assertEqual(ledger.audit()["events"], 24)
            existing = next(row for row in ledger.events() if row["key"] == "key-0")
            self.assertEqual(submit(0)["event_sha256"], existing["event_sha256"])
            with self.assertRaisesRegex(ValueError, "conflict"):
                ledger.append("test", "key-0", {"index": 100}, [b"synthetic"])
            content = Path(path) / "objects" / existing["payload_sha256"]
            original = content.read_bytes()
            content.write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "tampered"):
                ledger.audit()
            content.write_bytes(original)
            (Path(path) / "events/00000002.json").unlink()
            with self.assertRaisesRegex(ValueError, "gap"):
                ledger.audit()

    def test_interrupted_commit_recovers_without_overwrite(self):
        with tempfile.TemporaryDirectory() as path:
            ledger = Ledger(path)
            real_link = os.link

            def interrupted(source, target):
                if Path(target).parent.name == "events":
                    raise OSError("synthetic interruption")
                return real_link(source, target)

            with patch("data.prospective_ledger.os.link", side_effect=interrupted):
                with self.assertRaisesRegex(OSError, "interruption"):
                    ledger.append("test", "one", {"index": 1}, [b"synthetic"])
            self.assertEqual(ledger.audit()["events"], 0)
            self.assertTrue(ledger.audit()["orphan_objects"])
            self.assertEqual(
                Ledger(path).append("test", "one", {"index": 1}, [b"synthetic"])[
                    "sequence"
                ],
                1,
            )
            self.assertFalse(Ledger(path).audit()["orphan_objects"])
            self.assertFalse(Ledger(path).audit()["forward_eligible"])


if __name__ == "__main__":
    unittest.main()
