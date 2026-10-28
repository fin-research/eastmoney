from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

from choice.data_api import ChoiceAPIError, ChoiceResult
from data.primary_pricing import (
    build_primary_pricing_dataset,
    refresh_pricing_metadata,
    eligible_primary_bonds,
)
from data.issuance_scope import EXCLUDED_PRIVATE_CODES
from data.rate_data import RateDataset
from model.primary_pricing import (
    evaluate_primary_pricing,
    primary_history_statistics,
    primary_error_interval,
)


def pricing_history():
    dates = pd.date_range("2022-01-03", periods=8, freq="7D")
    return pd.DataFrame(
        {
            "bond_code": [str(i) for i in range(8)],
            "issuer": ["A", "B"] * 4,
            "rating": ["AAA"] * 8,
            "tenor": [3.0] * 8,
            "bond_type": ["证券公司债"] * 8,
            "decision_date": dates,
            "label_available_date": dates + pd.Timedelta(days=2),
            "source_date": dates - pd.Timedelta(days=1),
            "premium_bp": np.arange(8.0),
            "known_market_bp": [200.0] * 8,
            "coupon_bp": 200 + np.arange(8.0),
            "peer_residual_bp": [np.nan] * 8,
        }
    )


class PrimaryPricingTimeTest(unittest.TestCase):
    def test_interval_uses_only_mature_out_of_sample_errors(self):
        dates = pd.bdate_range("2022-01-03", periods=40)
        frame = pd.DataFrame(
            {
                "issuer": ["A"] * 40,
                "rating": ["AAA"] * 40,
                "tenor": [3.0] * 40,
                "bond_type": ["证券公司债"] * 40,
                "candidate": ["issuer_absolute"] * 40,
                "origin": dates,
                "label_available_date": dates + pd.Timedelta(days=1),
                "coupon_bp": 200 + np.arange(40.0),
                "prediction_bp": [200.0] * 40,
                "status": ["estimated"] * 40,
            }
        )
        as_of = dates[35]
        before = primary_error_interval(frame, frame.iloc[0], "issuer_absolute", as_of)
        frame.loc[frame.label_available_date.ge(as_of), "coupon_bp"] += 1000
        after = primary_error_interval(frame, frame.iloc[0], "issuer_absolute", as_of)
        self.assertEqual(before, after)
        self.assertLess(after["calibration_latest_label"], as_of)
        self.assertGreaterEqual(after["calibration_samples"], 30)

    def test_future_outcomes_do_not_change_earlier_predictions(self):
        history = pricing_history()
        before, _ = evaluate_primary_pricing(history)
        history.loc[history.index >= 6, ["coupon_bp", "premium_bp"]] += 100
        after, _ = evaluate_primary_pricing(history)
        cols = ["bond_code", "candidate", "prediction_bp", "history_latest_date"]
        pd.testing.assert_frame_equal(
            before.loc[before.bond_code.lt("6"), cols],
            after.loc[after.bond_code.lt("6"), cols],
        )

    def test_same_day_outcome_excluded_and_peer_types_stay_separate(self):
        history = pricing_history()
        row = history.iloc[5]
        history.loc[0, "label_available_date"] = row.decision_date
        history.loc[1, "bond_type"] = "证券公司次级债"
        history.loc[2, "rating"] = "AA"
        stats = primary_history_statistics(history, row, row.decision_date)
        self.assertEqual(stats["peer_n"], 2)
        self.assertLess(stats["history_latest_date"], row.decision_date)
        self.assertTrue(np.isnan(stats["peer_premium_bp"]))

    def test_same_issuer_same_day_tranches_do_not_inflate_sample_size(self):
        history = pricing_history()
        history = pd.concat([history, history.iloc[[0]]], ignore_index=True)
        stats = primary_history_statistics(
            history, history.iloc[5], pd.Timestamp("2022-03-01")
        )
        self.assertEqual(stats["peer_n"], 8)


class PricingMetadataTest(unittest.TestCase):
    def test_verified_private_exclusions_apply_before_any_pricing_history(self):
        codes = [*EXCLUDED_PRIVATE_CODES, "UNKNOWN.SZ"]
        bonds = pd.DataFrame(
            {
                "bond_code": [c.lower() for c in codes],
                "tenor": 3.0,
                "has_option": "否",
                "利率类型": "固息",
            }
        )
        selected = eligible_primary_bonds(bonds)
        self.assertEqual(selected.bond_code.tolist(), ["unknown.sz"])
        self.assertEqual(len(bonds), len(codes))

    def test_pricing_day_precedes_feature_cutoff_and_issuance_rating_used(self):
        dates = pd.bdate_range("2022-01-03", periods=5)
        rates = RateDataset(
            pd.DataFrame(index=dates),
            pd.DataFrame({"AAA_3Y": [200, 201, 202, 203, 204]}, index=dates),
            pd.Series(dates, index=dates),
            {},
        )
        bonds = pd.DataFrame(
            {
                "bond_code": ["A.SH", "B.SZ"],
                "issuer": ["issuer"] * 2,
                "rating": ["AAA"] * 2,
                "tenor": [3.0] * 2,
                "bond_type": ["证券公司债"] * 2,
                "issue_date": [dates[-1]] * 2,
                "coupon": [2.1] * 2,
                "has_option": ["否"] * 2,
                "利率类型": ["固息"] * 2,
            }
        )
        metadata = pd.DataFrame(
            {
                "bond_code": ["A.SH", "B.SZ"],
                "announcement_date": ["2022/1/5", "15:00-19:00"],
                "pricing_date": ["2022/1/5", "15:00-19:00"],
                "issuance_rating": ["AA+", "AAA"],
                "final_coupon": [2.1, 2.1],
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metadata.csv"
            metadata.to_csv(path, index=False)
            data, audit = build_primary_pricing_dataset(rates, path, bonds=bonds)
            metadata.loc[0, "pricing_date"] = "2022/1/10"
            metadata.to_csv(path, index=False)
            conflicts, conflict_audit = build_primary_pricing_dataset(
                rates, path, bonds=bonds
            )
            self.assertTrue(conflicts.empty)
            self.assertEqual(conflict_audit["pricing_after_issue_start_quarantined"], 1)
        self.assertEqual(len(data), 1)
        self.assertEqual(data.iloc[0].rating, "AA+")
        self.assertEqual(data.iloc[0].known_market_bp, 201)
        self.assertEqual(data.iloc[0].anchor_market_bp, 202)
        self.assertEqual(data.iloc[0].label_available_date, dates[-1])
        self.assertEqual(audit["missing_metadata_or_final_coupon"], 1)

    def test_failed_next_batch_preserves_successful_cache(self):
        bonds = pd.DataFrame(
            {
                "bond_code": ["A.SH", "B.SZ"],
                "tenor": [3.0, 3.0],
                "has_option": ["否", "否"],
                "利率类型": ["固息", "固息"],
            }
        )
        first = ChoiceResult(
            0,
            None,
            rows=(
                {
                    "code": "A.SH",
                    "TENDERANNCDATE": "2022/1/5",
                    "ISSCORPCREDITRAT": "AAA",
                    "TENDERFINALCOUPON": 2.0,
                    "TENDERDATE": "2022/1/6",
                },
            ),
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metadata.csv"
            with (
                patch(
                    "data.primary_pricing.BondDataBuilder.bond_data", return_value=bonds
                ),
                patch(
                    "data.primary_pricing.css",
                    side_effect=[first, ChoiceAPIError("unauthorized")],
                ) as query,
            ):
                with self.assertRaises(ChoiceAPIError):
                    refresh_pricing_metadata(path, batch_size=1)
                self.assertEqual(query.call_count, 2)
            self.assertEqual(pd.read_csv(path).bond_code.tolist(), ["A.SH"])

    def test_vendor_uppercase_symbol_maps_back_to_source_code(self):
        bonds = pd.DataFrame(
            {
                "bond_code": ["123456x.SZ"],
                "tenor": [3.0],
                "has_option": ["否"],
                "利率类型": ["固息"],
            }
        )
        response = ChoiceResult(
            0,
            None,
            rows=(
                {
                    "code": "123456X.SZ",
                    "TENDERANNCDATE": "2022/1/5",
                    "ISSCORPCREDITRAT": "AAA",
                    "TENDERFINALCOUPON": 2.0,
                    "TENDERDATE": "2022/1/6",
                },
            ),
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metadata.csv"
            with (
                patch(
                    "data.primary_pricing.BondDataBuilder.bond_data", return_value=bonds
                ),
                patch("data.primary_pricing.css", return_value=response),
            ):
                refresh_pricing_metadata(path)
            self.assertEqual(pd.read_csv(path).bond_code.tolist(), ["123456x.SZ"])


if __name__ == "__main__":
    unittest.main()
