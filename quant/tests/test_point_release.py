"""Stored point-release policies keep loading after the code-drift checks were removed."""

from dataclasses import asdict
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import pandas as pd

from model import issuance_point_release as release
from model.issuance_study_protocol import PUBLIC_CANDIDATES, digest


class LegacyPointPolicyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.candidate = PUBLIC_CANDIDATES[0]
        development = root / "development" / "study"
        development.mkdir(parents=True)
        (development / "selection.json").write_text("{}")
        (development / "protocol.json").write_text("{}")
        self.directory = root / "point"
        self.directory.mkdir()
        self.policy = {
            "development_selection": str(development / "selection.json"),
            "development_selection_sha256": digest(development / "selection.json"),
            "development_protocol_sha256": digest(development / "protocol.json"),
            "selected": asdict(self.candidate),
            "identity_sha256": "token",
            "spec": {"development_end": "2025-01-01", "as_of": "2026-01-01"},
            "release_adapter_changes": {
                "main.py": {"study_sha256": "0" * 64, "release_sha256": "1" * 64}
            },
            "source_identity_version": 2,
            "release_code": {"main.py": "2" * 64},
            "runtime": {"python": "3"},
        }
        (self.directory / "protocol.json").write_text(json.dumps(self.policy))
        (self.directory / "validation.json").write_text(
            json.dumps(
                {
                    "candidate": asdict(self.candidate),
                    "estimand": "huber_center",
                    "expected_savings_supported": False,
                    "release_policy": "user_authorized_best_public_point",
                    "selected_passed_gates": True,
                }
            )
        )

    def load(self):
        rows = pd.DataFrame(
            {
                "bond_code": ["A", "B"],
                "origin": pd.to_datetime(["2025-02-03", "2025-03-03"]),
                "label_available_date": pd.to_datetime(["2025-04-01", "2025-05-01"]),
                "placement_type": ["公募", "公募"],
            }
        )
        best = {"gates": {"passed": True}}
        value = {
            "point_directory": str(self.directory),
            "point_protocol_sha256": digest(self.directory / "protocol.json"),
            "point_validation_sha256": digest(self.directory / "validation.json"),
            "metrics": [],
            "sample_count": 2,
            "prediction_start": "2025-02-03",
            "prediction_end": "2025-03-03",
            **json.loads((self.directory / "validation.json").read_text()),
        }
        with (
            patch.object(
                release,
                "_derived_selection",
                return_value=({}, {}, best, self.candidate),
            ),
            patch.object(release, "_verified_months", return_value=rows),
            patch.object(release, "_metric_rows", return_value=[]),
            patch.object(release, "frozen_sigmas", return_value={}),
        ):
            return value, release.load_point_release(value)

    def test_stored_policy_with_adapter_changes_and_code_hashes_still_loads(self):
        value, loaded = self.load()
        self.assertEqual(loaded, value)

    def test_selection_provenance_is_still_checked(self):
        self.policy["selected"] = {**self.policy["selected"], "name": "other"}
        (self.directory / "protocol.json").write_text(json.dumps(self.policy))
        with self.assertRaisesRegex(ValueError, "provenance mismatch"):
            self.load()


if __name__ == "__main__":
    unittest.main()
