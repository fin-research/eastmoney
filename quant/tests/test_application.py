"""Behavioral contracts for the application and frozen-source boundaries."""

from itertools import combinations
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from application.arguments import parse_args
from application.cli import MODES, dispatch, main
from research_sources import source_hashes


class ApplicationTests(unittest.TestCase):
    def test_cli_help_does_not_import_model_or_data_dependencies(self):
        script = "import main, sys, json; print(json.dumps(sorted(sys.modules)))"
        modules = json.loads(subprocess.check_output([sys.executable, "-c", script]))
        for name in (
            "pandas",
            "numpy",
            "model.train",
            "data.data",
            "application.forecast",
        ):
            self.assertNotIn(name, modules)
        result = subprocess.run(
            [sys.executable, "main.py", "--help"], capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("--study-protocol", result.stdout)

    def test_all_conflicting_modes_reject_before_importing_workflows(self):
        for (first, message), (second, _) in combinations(MODES, 2):
            with self.subTest(first=first, second=second):
                flags = [
                    "--" + first.replace("_", "-"),
                    "--" + second.replace("_", "-"),
                ]
                if second == "online":
                    flags.append("infer")
                with self.assertRaisesRegex(SystemExit, message):
                    dispatch(parse_args(flags))

    def test_monitor_restarts_root_entry_with_original_arguments(self):
        flags = ["--online", "infer", "--as-of", "2026-10-03"]
        with (
            patch.dict(os.environ, {}, clear=True),
            patch(
                "model.research_resources.bounded_command", return_value=75
            ) as monitor,
        ):
            self.assertEqual(main(flags), 75)
        self.assertEqual(
            monitor.call_args.args[0],
            [sys.executable, str(Path.cwd() / "main.py"), *flags],
        )

    def test_forecast_dispatch_preserves_terms_and_writes_requested_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = Path(tmp) / "result.json"
            args = parse_args(
                ["--placement-type", "私募", "--tenor", "5", "--output", str(result)]
            )
            with patch(
                "application.cli.pipeline.run_issuance_forecast",
                return_value={"ok": True},
            ) as forecast:
                self.assertEqual(dispatch(args), {"ok": True})
            self.assertEqual(forecast.call_args.args[4]["placement_type"], "私募")
            self.assertEqual(forecast.call_args.args[4]["tenor"], 5)
            self.assertEqual(json.loads(result.read_text()), {"ok": True})

    def test_new_deleted_and_changed_sources_invalidate_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "application").mkdir()
            code = root / "application/forecast.py"
            before = source_hashes(root)
            code.write_text("first")
            added = source_hashes(root)
            self.assertNotEqual(before, added)
            code.write_text("second")
            self.assertNotEqual(added, source_hashes(root))
            code.unlink()
            self.assertEqual(before, source_hashes(root))

    def test_identity_covers_actual_wrappers_runtime_packages_and_locks(self):
        sources = source_hashes()
        for name in (
            "main.py",
            "pipeline.py",
            "online_pipeline.py",
            "application/cli.py",
            "application/inputs.py",
            "artifacts.py",
            "research_sources.py",
            "model/__init__.py",
            "data/__init__.py",
            "data/issuance_calendar.py",
            "online/coupon-model.mjs",
            "../package.json",
            "../pnpm-workspace.yaml",
            "../pnpm-lock.yaml",
            "../vendor/xlsx-0.20.3.tgz",
            "uv.lock",
        ):
            self.assertIn(name, sources)


class MonorepoSourceGitTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.repository = Path(temporary.name).resolve()
        self.root = self.repository / "quant"
        self.root.mkdir()
        for name in (
            "package.json",
            "pnpm-workspace.yaml",
            "pnpm-lock.yaml",
            "vendor/xlsx-0.20.3.tgz",
        ):
            path = self.repository / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("original " + name)
        (self.root / "main.py").write_text("# source")
        self.git("init", "-q")
        self.git("config", "user.name", "Source identity test")
        self.git("config", "user.email", "source@example.invalid")
        self.git("add", ".")
        self.git("commit", "-qm", "Original source")

    def git(self, *args):
        return subprocess.check_output(
            ["git", *args], cwd=self.repository, text=True
        ).strip()

    def test_root_dependency_history_resolves_without_parent_segments(self):
        from scripts import register_reproduction as reproduction

        revision = self.git("rev-parse", "HEAD")
        checksum = hashlib.sha256(
            (self.repository / "pnpm-lock.yaml").read_bytes()
        ).hexdigest()
        (self.repository / "pnpm-lock.yaml").write_text("changed graph")
        self.git("add", "pnpm-lock.yaml")
        self.git("commit", "-qm", "Change dependency graph")
        with patch.object(reproduction, "ROOT", self.root):
            self.assertEqual(
                reproduction._restored_commit("../pnpm-lock.yaml", checksum), revision
            )
            with self.assertRaises(ValueError):
                reproduction._restored_commit("../../outside", checksum)

    def test_dirty_root_dependencies_reject_freezing_before_any_evidence_read(self):
        from scripts import register_reproduction as reproduction

        for name in (
            "package.json",
            "pnpm-workspace.yaml",
            "pnpm-lock.yaml",
            "vendor/xlsx-0.20.3.tgz",
        ):
            path = self.repository / name
            original = path.read_text()
            path.write_text("uncommitted dependency change")
            with self.subTest(name=name), patch.object(reproduction, "ROOT", self.root):
                with self.assertRaisesRegex(
                    ValueError, "Commit the reviewed implementation"
                ):
                    reproduction.register(None, None, None, None)
            path.write_text(original)

    def test_vendor_bytes_are_part_of_source_identity(self):
        before = source_hashes(self.root)
        archive = self.repository / "vendor/xlsx-0.20.3.tgz"
        archive.write_bytes(b"changed vendor content")
        after = source_hashes(self.root)
        self.assertNotEqual(
            before["../vendor/xlsx-0.20.3.tgz"], after["../vendor/xlsx-0.20.3.tgz"]
        )

    def test_calibration_registration_resolves_root_dependency_paths(self):
        from model import issuance_calibration_study as calibration

        sources = {
            "../pnpm-lock.yaml": hashlib.sha256(
                (self.repository / "pnpm-lock.yaml").read_bytes()
            ).hexdigest()
        }
        with (
            patch.object(
                calibration,
                "__file__",
                str(self.root / "model/issuance_calibration_study.py"),
            ),
            patch.object(calibration, "source_hashes", return_value=sources),
            patch.object(calibration, "runtime_identity", return_value={}),
            patch.object(calibration, "source_inventory", return_value={}),
            patch.object(
                calibration,
                "_source_predictions",
                return_value=(None, {"identity_sha256": "original"}),
            ),
        ):
            value = calibration.register_study(
                self.root, self.root, self.root / "outputs"
            )
        self.assertEqual(value["transform_code"], sources)


class ReproductionProvenanceTests(unittest.TestCase):
    @staticmethod
    def _fixture(root):
        from research_sources import runtime_identity
        from model.issuance_study_protocol import digest
        from tests.test_issuance_study import study_spec
        import copy

        nodes = root / "nodes.csv"
        nodes.write_text("curve fixture")
        original_spec = study_spec()
        original_spec["nodes_sha256"] = digest(nodes)
        for candidate in original_spec["candidates"]:
            candidate.pop("market_change")
        original = root / "original.json"
        original.write_text(json.dumps(original_spec))
        protocol = root / "protocol.json"
        protocol.write_text(
            json.dumps({"spec": original_spec, "identity_sha256": "original"})
        )
        selection = root / "selection.json"
        selection.write_text(json.dumps({"identity_sha256": "original"}))
        revision = "a" * 40
        inventory = root / "migration-inventory.json"
        value = {
            "source_revision": revision,
            "current_sources": source_hashes(),
            "runtime": runtime_identity(),
            "original_evidence": {
                role: {"path": str(file), "sha256": digest(file)}
                for role, file in {
                    "spec": original,
                    "protocol": protocol,
                    "selection": selection,
                }.items()
            },
        }
        inventory.write_text(json.dumps(value))
        spec = copy.deepcopy(original_spec)
        for candidate in spec["candidates"]:
            candidate["market_change"] = "none"
        spec["reproduction"] = {
            "purpose": "reproduction-under-current-code",
            "source_revision": revision,
            "original_spec_sha256": digest(original),
            "original_protocol_sha256": digest(protocol),
            "original_selection_sha256": digest(selection),
            "inventory_sha256": digest(inventory),
        }
        request = root / "request.json"
        request.write_text(json.dumps(spec))
        return request, spec, original, nodes, inventory, original_spec

    def test_reproduction_binds_design_hash_roles_sources_and_original_artifacts(self):
        from model.issuance_study_protocol import load_spec
        import copy

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            request, spec, original, nodes, inventory, original_spec = self._fixture(
                root
            )
            self.assertEqual(load_spec(request)[0], spec)
            for key, changed in (
                ("development_start", "2022-01-01"),
                ("development_end", "2025-08-01"),
                ("as_of", "2026-09-24"),
                ("input_sha256", "d" * 64),
            ):
                modified = copy.deepcopy(spec)
                modified[key] = changed
                request.write_text(json.dumps(modified))
                with (
                    self.subTest(field=key),
                    self.assertRaisesRegex(ValueError, "design differs"),
                ):
                    load_spec(request)
            modified = copy.deepcopy(spec)
            modified["reproduction"]["original_spec_sha256"] = "d" * 64
            request.write_text(json.dumps(modified))
            with self.assertRaisesRegex(ValueError, "hash linkage"):
                load_spec(request)
            relocated = root / "relocated.csv"
            relocated.write_bytes(nodes.read_bytes())
            modified = copy.deepcopy(spec)
            modified["nodes_path"] = "relocated.csv"
            modified["stage"] = "smoke"
            request.write_text(json.dumps(modified))
            self.assertEqual(load_spec(request)[0], modified)
            relocated.write_text("different curve")
            with self.assertRaisesRegex(ValueError, "node contents"):
                load_spec(request)
            request.write_text(json.dumps(spec))
            original.write_text('{"changed":true}')
            with self.assertRaisesRegex(ValueError, "original evidence changed"):
                load_spec(request)
            original.write_text(json.dumps(original_spec))
            with patch("research_sources.source_hashes", return_value={}):
                with self.assertRaisesRegex(ValueError, "source, runtime"):
                    load_spec(request)
            inventory.write_text("{}")
            with self.assertRaisesRegex(ValueError, "checksum"):
                load_spec(request)


if __name__ == "__main__":
    unittest.main()
