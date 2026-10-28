"""Architecture checks protect active imports and sealed research boundaries."""

import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path


class RepositoryBoundaryTests(unittest.TestCase):
    def test_artifact_import_does_not_load_retired_model_or_data(self):
        script = (
            "import model.export, data, sys, json; "
            "print(json.dumps(sorted(sys.modules)))"
        )
        modules = json.loads(subprocess.check_output([sys.executable, "-c", script]))
        for name in (
            "model.train",
            "model.scoring",
            "model.cv",
            "data.data",
            "issue_report",
            "structured_result",
            "archive.margin_flow",
            "torch",
            "pandas",
        ):
            self.assertNotIn(name, modules)

    def test_lazy_legacy_interfaces_keep_their_existing_identity(self):
        from data import FeatureEngineer
        from data.data import FeatureEngineer as original
        from model import check_ood
        from model.ood import check_ood as original_check

        self.assertIs(FeatureEngineer, original)
        self.assertIs(check_ood, original_check)

    def test_sealed_cli_cannot_accidentally_train(self):
        result = subprocess.run(
            [sys.executable, "margin.py"], capture_output=True, text=True
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("python -m archive.margin", result.stderr)
        self.assertIsNone(importlib.util.find_spec("margin_flow"))
        self.assertTrue(Path("archive/margin-source.json").is_file())


if __name__ == "__main__":
    unittest.main()
