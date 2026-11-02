import copy
import hashlib
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

import numpy as np

from artifacts import export_tree, json_safe, write_json
from reports.evidence import validate_evidence
from reports.short_evidence import validate_short_evidence

ROOT = Path(__file__).resolve().parents[1]


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


if __name__ == "__main__":
    unittest.main()
