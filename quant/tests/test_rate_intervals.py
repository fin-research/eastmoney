import unittest

import pandas as pd

from model.rate_intervals import calibrate_rate_intervals


class RateIntervalTest(unittest.TestCase):
    def test_only_mature_residuals_and_paired_errors_are_used(self):
        rows = []
        for origin in pd.date_range("2022-01-01", periods=3):
            for horizon in (0, 1):
                rows.append(
                    {
                        "target": "AAA_3Y",
                        "candidate": "example",
                        "origin": origin,
                        "horizon": horizon,
                        "prediction_bp": 0.0,
                        "change_bp": 1.0,
                        "label_end": origin + pd.Timedelta(days=horizon),
                        "current_bp": 100.0,
                    }
                )
        history = pd.DataFrame(rows)
        hidden = history.origin.eq(pd.Timestamp("2022-01-02")) & history.horizon.eq(1)
        history.loc[hidden, "label_end"] = pd.Timestamp("2022-01-10")
        predictions = history.iloc[:2].copy()
        predictions["origin"] = pd.Timestamp("2022-01-05")
        predictions["label_end"] = pd.Timestamp("2022-01-06")
        predictions.loc[predictions.horizon.eq(1), "prediction_bp"] = -1.0
        result = calibrate_rate_intervals(predictions, history, min_history=2)
        future = result.loc[result.horizon.eq(1)].iloc[0]
        self.assertEqual(future.calibration_samples, 2)
        self.assertLess(future.calibration_label_end, future.origin)
        self.assertAlmostEqual(future.lower_rate_percent, 1.0)
        self.assertAlmostEqual(future.upper_rate_percent, 1.0)
        self.assertEqual(future.probability_cheaper_than_today, 1.0)
        history.loc[hidden, "change_bp"] = 999
        again = calibrate_rate_intervals(predictions, history, min_history=2)
        pd.testing.assert_frame_equal(result, again)

    def test_insufficient_calibration_does_not_fabricate_interval(self):
        row = pd.DataFrame(
            {
                "target": ["AAA_3Y"],
                "candidate": ["example"],
                "origin": pd.to_datetime(["2022-01-03"]),
                "horizon": [0],
                "prediction_bp": [0.0],
                "change_bp": [1.0],
                "label_end": pd.to_datetime(["2022-01-03"]),
                "current_bp": [100.0],
            }
        )
        result = calibrate_rate_intervals(row, row).iloc[0]
        self.assertEqual(result.interval_status, "insufficient_calibration")
        self.assertTrue(pd.isna(result.lower_change_bp))


if __name__ == "__main__":
    unittest.main()
