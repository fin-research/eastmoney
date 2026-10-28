import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import pandas as pd

from data.rate_data import (
    build_rate_dataset,
    calendar_training_data,
    purged_training_index,
)
from model.issuance_forecast import IssuanceForecaster
from model.issuance_backtest import (
    apply_event_overrides,
    evaluate_issue_paths,
    evaluate_pair_policy,
    path_metrics,
)
from test_issuance_forecast import raw_rates, primary_history, TERMS


class EventBacktestTest(unittest.TestCase):
    def test_weekend_clock_uses_only_prior_quote_and_full_maturity(self):
        rates = build_rate_dataset(Path("synthetic"), funding_frame=raw_rates())
        features, labels = calendar_training_data(rates, 3)
        origin = pd.Timestamp("2026-09-19")
        self.assertEqual(labels.loc[origin, "source_date"], pd.Timestamp("2026-09-18"))
        self.assertEqual(features.loc[origin, "decision_weekday"], 5)
        self.assertEqual(labels.loc[origin, "deadline"], pd.Timestamp("2026-09-22"))
        self.assertNotIn(
            origin, purged_training_index(labels, pd.Timestamp("2026-09-22"))
        )
        self.assertIn(origin, purged_training_index(labels, pd.Timestamp("2026-09-23")))

    def test_monthly_forecast_has_frozen_past_training_and_true_shap(self):
        rates = build_rate_dataset(Path("synthetic"), funding_frame=raw_rates())
        engine = IssuanceForecaster(rates, primary_history(), "direct_lgb_shrink")
        date = pd.Timestamp("2026-09-19")
        result = engine.predict_one(
            date, date + pd.Timedelta(days=1), date + pd.Timedelta(days=10), TERMS
        )
        self.assertEqual(result["forecast_origin"], date)
        self.assertEqual(result["effective_horizon"], 10)
        self.assertLess(result["market_train_label_end"], pd.Timestamp("2026-09-01"))
        shap = engine.explain(
            date, date + pd.Timedelta(days=1), date + pd.Timedelta(days=10), TERMS
        )
        self.assertAlmostEqual(
            shap["base_coupon_bp"] + sum(x["shap_bp"] for x in shap["features"]),
            result["coupon_percent"] * 100,
        )

    def test_official_issue_date_excludes_already_priced_origins(self):
        rates = build_rate_dataset(Path("synthetic"), funding_frame=raw_rates())
        engine = IssuanceForecaster(rates, primary_history(), "random_walk")
        frame = pd.DataFrame(
            [
                {
                    **TERMS,
                    "bond_code": "A.SZ",
                    "issue_date": pd.Timestamp("2026-09-21"),
                    "decision_date": pd.Timestamp("2026-09-18"),
                    "coupon_bp": 200,
                    "anchor_market_bp": 190,
                    "label_available_date": pd.Timestamp("2026-09-21"),
                }
            ]
        )
        result = evaluate_issue_paths(engine, frame)
        self.assertEqual(len(result), 30)
        excluded = result.loc[result.status.eq("already_priced_excluded")]
        self.assertEqual(excluded.event_lead_days.tolist(), [1, 2])
        self.assertEqual(path_metrics(result, ("candidate",)).samples.iloc[0], 28)

    def test_audited_correction_preserves_raw_and_delays_label(self):
        frame = pd.DataFrame(
            {
                "bond_code": ["A.SZ"],
                "issue_date": pd.to_datetime(["2026-09-18"]),
                "decision_date": pd.to_datetime(["2026-09-18"]),
                "label_available_date": pd.to_datetime(["2026-09-18"]),
            }
        )
        correction = [
            {
                "bond_code": "A.SZ",
                "original_issue_date": "2026-09-18",
                "issue_date": "2026-09-21",
                "source_url": "https://disc.static.szse.cn/official.pdf",
            }
        ]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "correction.json"
            path.write_text(json.dumps(correction))
            revised = apply_event_overrides(frame, path)
            self.assertEqual(revised.issue_date.iloc[0], pd.Timestamp("2026-09-21"))
            self.assertEqual(
                revised.label_available_date.iloc[0], pd.Timestamp("2026-09-21")
            )
            self.assertEqual(frame.issue_date.iloc[0], pd.Timestamp("2026-09-18"))
            with self.assertRaisesRegex(ValueError, "original date"):
                apply_event_overrides(revised, path)

    def test_pair_policy_cannot_calibrate_on_its_own_or_future_outcome(self):
        pairs = pd.DataFrame(
            [
                {
                    **TERMS,
                    "origin": pd.Timestamp("2026-09-01"),
                    "lead_days": 20,
                    "label_available_date": pd.Timestamp("2026-09-21"),
                    "prediction_saving_bp": 5.0,
                    "actual_saving_bp": 20.0,
                    "saving_error_bp": 15.0,
                }
                for _ in range(25)
            ]
        )
        result = evaluate_pair_policy(pairs)
        self.assertFalse(result.wait.any())
        self.assertTrue(result.prior_calibration_pairs.eq(0).all())
        self.assertTrue(np.allclose(result.realized_saving_vs_immediate_bp, 0))


if __name__ == "__main__":
    unittest.main()
