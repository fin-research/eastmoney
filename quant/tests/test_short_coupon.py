"""Evidence completeness and frozen selection for the three-horizon study."""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import pandas as pd

from artifacts import write_json
from data.coupon_quotes import QUOTE_COLUMNS
from model.short_coupon import (
    CONTROL,
    short_candidates,
    summarize_short,
    load_short_release,
)
from model.issuance_study import checkpoint_guard
from model.issuance_study_protocol import digest


class ShortCouponTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.expected = pd.DataFrame(
            [
                dict(
                    bond_code=f"B{i}",
                    origin=origin,
                    lead_days=h,
                    pricing_date=str(
                        (pd.Timestamp(origin) + pd.Timedelta(days=h)).date()
                    ),
                    label_available_date=str(
                        (pd.Timestamp(origin) + pd.Timedelta(days=h + 1)).date()
                    ),
                    coupon_bp=200.0 + i,
                    valuation_bp=203.0 + i,
                )
                for i, origin in enumerate(("2024-01-10", "2024-02-10", "2026-02-10"))
                for h in (1, 14, 30)
            ]
        )
        self.expected = self.expected.assign(**{name: 200.0 for name in QUOTE_COLUMNS})
        self.expected.to_csv(self.directory / "expected-events.csv", index=False)
        write_json(
            self.directory / "protocol.json",
            dict(
                sources={},
                runtime={},
                audit={"issuance_scope": "public_only"},
                expected_sha256=digest(self.directory / "expected-events.csv"),
            ),
        )
        self.token = digest(self.directory / "protocol.json")
        self.predictions = {}
        for c, error in zip(
            (*short_candidates(), CONTROL), (2.0, 1.0, 4.0), strict=True
        ):
            rows = self.expected.drop(columns="valuation_bp").assign(
                predicted_bp=self.expected.coupon_bp + error
            )
            for month, group in rows.groupby(
                pd.to_datetime(rows.origin).dt.strftime("%Y-%m")
            ):
                path = self.directory / c.name / f"{month}.csv"
                path.parent.mkdir(exist_ok=True)
                group.to_csv(path, index=False)
                write_json(
                    path.with_suffix(".diagnostics.json"),
                    {"training_label_end": "2023-12-31"},
                )
                checkpoint_guard(path, True, self.token, c)
            self.predictions[c.name] = rows
        self.result = summarize_short(
            self.predictions, self.expected, self.token, "public_only"
        )
        self.path = self.directory / "release-evaluation.json"
        write_json(self.path, self.result)

    def load(self):
        with (
            patch("model.short_coupon.source_hashes", return_value={}),
            patch("model.short_coupon.runtime_identity", return_value={}),
        ):
            return load_short_release(self.path)

    def test_fresh_result_loads_and_selects_history(self):
        self.assertEqual(self.result, self.load())
        self.assertEqual(self.result["candidate"]["feature_set"], "quote_history")
        self.assertEqual(self.result["sample_count"], 3)
        self.assertEqual(self.result["forecast_horizons"], [1, 14, 30])

    def test_curve_study_only_selects_the_fixed_pca_candidate(self):
        pca = short_candidates("curve_pca3")[-1]
        predictions = dict(self.predictions)
        predictions[pca.name] = self.expected.assign(
            predicted_bp=self.expected.coupon_bp + 0.5
        )
        result = summarize_short(
            predictions, self.expected, self.token, "public_only", "curve_pca3"
        )
        self.assertEqual(result["candidate"]["feature_set"], "quote_pca")
        self.assertEqual(len(result["comparison"]), 4)
        # An accurate former sequence control must never become the challenger.
        predictions[pca.name]["predicted_bp"] = self.expected.coupon_bp + 5
        result = summarize_short(
            predictions, self.expected, self.token, "public_only", "curve_pca3"
        )
        self.assertIsNone(result["candidate"])
        self.assertTrue(result["comparison"][1]["control_only"])

    def test_deleted_month_is_rejected(self):
        next((self.directory / CONTROL.name).glob("*.csv")).unlink()
        with self.assertRaisesRegex(ValueError, "incomplete"):
            self.load()

    def test_product_study_cannot_select_a_former_control(self):
        candidate = short_candidates("product_quote")[-1]
        predictions = dict(self.predictions)
        predictions[candidate.name] = self.expected.assign(
            predicted_bp=self.expected.coupon_bp + 0.5
        )
        result = summarize_short(
            predictions, self.expected, self.token, "public_only", "product_quote"
        )
        self.assertEqual(result["candidate"]["feature_set"], "quote_product")
        predictions[candidate.name]["predicted_bp"] = self.expected.coupon_bp + 5
        result = summarize_short(
            predictions, self.expected, self.token, "public_only", "product_quote"
        )
        self.assertIsNone(result["candidate"])
        self.assertTrue(result["comparison"][1]["control_only"])

    def test_changed_candidate_and_metrics_are_rejected(self):
        altered = {
            **self.result,
            "candidate": self.result["comparison"][0]["candidate"],
        }
        write_json(self.path, altered)
        with self.assertRaisesRegex(ValueError, "selection/metrics"):
            self.load()
        altered = {**self.result, "sample_count": 4}
        write_json(self.path, altered)
        with self.assertRaisesRegex(ValueError, "selection/metrics"):
            self.load()

    def test_labels_and_denominator_are_identical_across_candidates(self):
        self.predictions[CONTROL.name].loc[0, "coupon_bp"] = 999
        with self.assertRaisesRegex(ValueError, "labels"):
            summarize_short(self.predictions, self.expected, self.token, "public_only")

    def test_no_qualified_candidate_does_not_release(self):
        dynamic = short_candidates()[1]
        self.predictions[dynamic.name]["predicted_bp"] = self.expected.coupon_bp + 5
        result = summarize_short(
            self.predictions, self.expected, self.token, "public_only"
        )
        self.assertIsNone(result["candidate"])
        self.assertEqual(result["status"], "no_qualified_candidate")
