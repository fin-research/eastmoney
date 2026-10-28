"""Business invariants for expanding windows and cost-based recommendations."""
import contextlib
import io
import unittest

import numpy as np
import pandas as pd

from model.cv import BondTimingModel, TimeSeriesCV


class TimeSeriesCVTest(unittest.TestCase):
    def test_unsorted_rows_keep_original_positions_without_future_leakage(self):
        dates = pd.Series(pd.date_range("2020-01-01", "2024-01-01", freq="MS"))
        dates = dates.sample(frac=1, random_state=7).reset_index(drop=True)
        with contextlib.redirect_stdout(io.StringIO()):
            folds = TimeSeriesCV(n_splits=10, val_months=6).split(dates)
        self.assertEqual(len(folds), 4)
        previous_train = set()
        for train, validation in folds:
            self.assertTrue(previous_train.issubset(set(train)))
            self.assertTrue(set(train).isdisjoint(validation))
            self.assertLess(dates.iloc[train].max(), dates.iloc[validation].min())
            self.assertEqual(len(validation), 6)
            previous_train = set(train)
        self.assertEqual(dates.iloc[folds[0][1]].min(), pd.Timestamp("2022-01-01"))

    def test_insufficient_history_does_not_create_partial_validation_window(self):
        dates = pd.Series(pd.date_range("2020-01-01", periods=28, freq="MS"))
        self.assertEqual(TimeSeriesCV().split(dates), [])

    def test_lower_predicted_cost_selects_cheaper_issuance_days(self):
        predicted = np.arange(20, dtype=float)
        actual = predicted - 10
        result = BondTimingModel.evaluate_timing_value(predicted, actual)
        self.assertEqual(result["n_recommended"], 5)
        self.assertAlmostEqual(result["recommended_mean_bp"], -8)
        self.assertAlmostEqual(result["baseline_mean_bp"], -0.5)
        self.assertAlmostEqual(result["cost_saving_bp"], 7.5)
        self.assertEqual(result["win_rate"], 1)
        self.assertTrue(result["monotonic"])
        self.assertAlmostEqual(result["ic"], 1)

    def test_baseline_learns_a_simple_out_of_sample_signal(self):
        train = np.arange(100, dtype=float).reshape(-1, 1)
        validation = np.arange(100, 120, dtype=float).reshape(-1, 1)
        results = BondTimingModel(["signal"]).train_baseline(
            train, train[:, 0] * 2, validation, validation[:, 0] * 2, verbose=False
        )
        for result in results.values():
            self.assertLess(result["rmse"], 3)
            self.assertGreater(result["ic"], 0.99)
