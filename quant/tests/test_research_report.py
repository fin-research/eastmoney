import copy
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

import numpy as np

from artifacts import export_tree, json_safe, write_json
from reports.build import ROOT, REPORT, source_hashes, validate_evidence
from reports.short_evidence import validate_short_evidence


class ResearchEvidenceTests(unittest.TestCase):
    def test_followup_study_cannot_hide_invalid_comparison_denominators(self):
        data = json.loads((ROOT / "reports/short-coupon.json").read_text())
        followup = copy.deepcopy(data)
        followup.pop("followup_studies", None)
        data["followup_studies"] = [followup]
        validate_short_evidence(data)
        followup["evaluation"]["comparison"][0]["development"][0]["samples"] += 1
        with self.assertRaisesRegex(ValueError, "denominators"):
            validate_short_evidence(data)

    def test_curve_study_requires_its_own_four_comparisons(self):
        data = json.loads((ROOT / "reports/short-coupon.json").read_text())
        data.pop("followup_studies", None)
        data["evaluation"]["representation"] = "curve_pca3"
        with self.assertRaisesRegex(ValueError, "contract"):
            validate_short_evidence(data)
        pca = copy.deepcopy(data["evaluation"]["comparison"][0])
        data["evaluation"]["comparison"].append(pca)
        with self.assertRaisesRegex(ValueError, "contract"):
            validate_short_evidence(data)
        pca["name"] = "ridge_coupon_3y_0_quote_pca"
        pca["candidate"]["feature_set"] = "quote_pca"
        validate_short_evidence(data)
        data["evaluation"]["representation"] = "unknown"
        with self.assertRaisesRegex(ValueError, "contract"):
            validate_short_evidence(data)

    def test_retained_historical_evidence_keeps_denominators_and_null_savings(self):
        data = json.loads((ROOT / "reports/research.json").read_text())
        validate_evidence(data)
        altered = copy.deepcopy(data)
        altered["development"]["rows"][0]["requested"] += 1
        with self.assertRaisesRegex(ValueError, "denominators"):
            validate_evidence(altered)
        altered = copy.deepcopy(data)
        altered["production"]["expected_savings_supported"] = True
        with self.assertRaisesRegex(ValueError, "null savings"):
            validate_evidence(altered)

    def test_calibration_keeps_cold_start_and_no_automatic_release(self):
        data = json.loads((ROOT / "reports/research.json").read_text())
        data["calibration_studies"][0]["production_eligible"] = True
        with self.assertRaisesRegex(ValueError, "cannot authorize production"):
            validate_evidence(data)

    def test_artifact_serialization_preserves_portable_bytes_and_tree_splits(self):
        values = {
            "n": np.int64(2),
            "x": np.float64(1.5),
            "missing": np.nan,
            "date": date(2026, 10, 3),
            "name": "证券公司债",
            "infinite": [float("inf"), -float("inf")],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "evidence.json"
            digest = write_json(path, values)
            expected = (
                '{"n":2,"x":1.5,"missing":null,"date":"2026-10-03",'
                '"name":"证券公司债","infinite":[null,null]}'
            ).encode("utf-8")
            self.assertEqual(path.read_bytes(), expected)
            self.assertEqual(digest, hashlib.sha256(expected).hexdigest())
            with self.assertRaises(TypeError):
                write_json(path, {"unsupported": object()})
            self.assertEqual(path.read_bytes(), expected)
            self.assertEqual(list(path.parent.iterdir()), [path])
        self.assertEqual(json_safe((1, 2)), [1, 2])
        with self.assertRaises(TypeError):
            json_safe(object())
        tree = {
            "decision_type": "==",
            "threshold": "1||2",
            "split_feature": 0,
            "default_left": True,
            "missing_type": "None",
            "internal_count": 3,
            "left_child": {"leaf_value": 1.2, "leaf_count": 1},
            "right_child": {"leaf_value": 2.0, "leaf_count": 2},
        }
        self.assertEqual(export_tree(tree), tree)
        with self.assertRaises(ValueError):
            export_tree({**tree, "decision_type": ">"})


class ResearchReportCLITests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.workspace = Path(temporary.name)
        self.root = self.workspace / "quant"
        files = [ROOT / name for name in source_hashes()]
        files.extend(path for path in (ROOT / "reports").iterdir() if path.is_file())
        files.append(REPORT)
        for path in files:
            destination = self.root / path.relative_to(ROOT, walk_up=True)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)

    def snapshot(self):
        return {
            path.relative_to(self.workspace).as_posix(): hashlib.sha256(
                path.read_bytes()
            ).hexdigest()
            for path in self.workspace.rglob("*")
            if path.is_file()
        }

    def invoke(self, *arguments):
        return subprocess.run(
            [sys.executable, "-B", "scripts/build_report.py", *arguments],
            cwd=self.root,
            capture_output=True,
            text=True,
            timeout=15,
        )

    def test_check_is_readonly_and_preserves_authored_readme(self):
        before = self.snapshot()
        checked = self.invoke("--check")
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertEqual(self.snapshot(), before)
        built = self.invoke()
        self.assertEqual(built.returncode, 0, built.stderr)
        self.assertEqual(self.snapshot(), before)

    def test_changed_readme_is_rejected_without_rewriting_any_file(self):
        report = self.root / "README.md"
        report.write_text(report.read_text() + "\nChanged research conclusion.\n")
        before = self.snapshot()
        result = self.invoke("--check")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("不一致", result.stderr)
        self.assertEqual(self.snapshot(), before)

    def test_invalid_evidence_is_rejected_without_rewriting_any_file(self):
        path = self.root / "reports/research.json"
        data = json.loads(path.read_text())
        data["development"]["rows"][0]["requested"] += 1
        path.write_text(json.dumps(data))
        before = self.snapshot()
        result = self.invoke("--check")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("denominators", result.stderr)
        self.assertEqual(self.snapshot(), before)

    def test_changed_model_source_is_rejected_without_rewriting_any_file(self):
        path = self.root / "model/train.py"
        path.write_text(path.read_text() + "\n# changed source\n")
        before = self.snapshot()
        result = self.invoke("--check")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("模型实现已变化", result.stderr)
        self.assertEqual(self.snapshot(), before)

    def test_changed_workspace_lock_is_rejected_without_rewriting_any_file(self):
        path = self.workspace / "pnpm-lock.yaml"
        path.write_text(path.read_text() + "\n# changed dependency graph\n")
        before = self.snapshot()
        result = self.invoke("--check")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("模型实现已变化", result.stderr)
        self.assertEqual(self.snapshot(), before)

    def test_check_cannot_update_the_review(self):
        before = self.snapshot()
        result = self.invoke("--check", "--review-note", "must not be written")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("检查模式不能更新审阅记录", result.stderr)
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
