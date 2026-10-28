"""Production entry points refuse unreviewed and suspended model identities."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from model.release_eligibility import require_active_model


class ReleaseEligibilityTests(unittest.TestCase):
    def test_missing_identity_does_not_connect(self):
        with patch("model.release_eligibility.psycopg.connect") as connect:
            for value in (None, "", "invalid"):
                with self.assertRaisesRegex(ValueError, "quality_review_required"):
                    require_active_model(value)
            connect.assert_not_called()

    def test_explicit_approval_and_suspension_use_read_only_parameterized_query(self):
        version = "0" * 20
        for row in (None, ("suspended", "data_quality"), ("active", "verified")):
            connection = MagicMock()
            connection.execute.return_value.fetchone.return_value = row
            with (
                patch.dict("os.environ", {"DATABASE_URL": "test"}),
                patch("model.release_eligibility.load_dotenv"),
                patch("model.release_eligibility.psycopg.connect") as connect,
            ):
                connect.return_value.__enter__.return_value = connection
                if row and row[0] == "active":
                    require_active_model(version)
                else:
                    with self.assertRaisesRegex(ValueError, "Model suspended"):
                        require_active_model(version)
            self.assertEqual(
                connection.execute.call_args_list[0].args,
                ("SET TRANSACTION READ ONLY",),
            )
            self.assertEqual(connection.execute.call_args_list[1].args[1], (version,))

    def test_infer_rejects_before_fetching_or_running_old_runtime(self):
        from application.online import run_online

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "manifest.json").write_text(json.dumps({"model_version": "0" * 20}))
            with (
                patch(
                    "model.release_eligibility.require_active_model",
                    side_effect=ValueError("Model suspended: data_quality"),
                ),
                patch("application.online.fetch_inputs") as fetch,
                patch("application.online.subprocess.run") as run,
            ):
                with self.assertRaisesRegex(ValueError, "data_quality"):
                    run_online("infer", root, "2026-10-26")
                fetch.assert_not_called()
                run.assert_not_called()

    def test_forecast_rejects_before_reading_data_or_restoring_imputed_model(self):
        from application.forecast import run_issuance_forecast

        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch(
                    "model.issuance_release.load_public_release",
                    return_value={"candidate": {}},
                ),
                patch("application.forecast._coupon_inputs") as fetch,
            ):
                with self.assertRaisesRegex(ValueError, "quality_review_required"):
                    run_issuance_forecast(
                        Path(tmp),
                        "2026-10-26",
                        30,
                        None,
                        {},
                        coupon_selection=Path("selection.json"),
                    )
                fetch.assert_not_called()

    def test_train_rejects_before_fetching_or_writing_inputs(self):
        from application.online import run_online

        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch(
                    "model.issuance_release.load_public_release",
                    return_value={"candidate": {}},
                ),
                patch("application.online.fetch_inputs") as fetch,
                patch("application.online.write_json") as write,
            ):
                with self.assertRaisesRegex(ValueError, "quality_review_required"):
                    run_online(
                        "train",
                        Path(tmp),
                        "2026-10-26",
                        coupon_selection=Path("selection.json"),
                    )
                fetch.assert_not_called()
                write.assert_not_called()
