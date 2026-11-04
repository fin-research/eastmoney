"""Protect the label clock, absence of look-ahead and scale behaviour of the range model."""

import unittest

import numpy as np
import pandas as pd

from model.timing_range import (
    daily_scale,
    range_forecast,
    window_change,
)


def walk(days=1200, step=1.0, seed=3, start=300.0):
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range("2019-01-02", periods=days)
    return pd.Series(start + np.cumsum(rng.normal(0, step, days)), index=dates)


class WindowChangeTests(unittest.TestCase):
    def test_label_uses_next_quote_as_decision_day(self):
        dates = pd.to_datetime(
            ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04", "2024-03-01"]
        )
        levels = pd.Series([10.0, 20.0, 30.0, 50.0, 90.0], index=dates)
        labels = window_change(levels, horizon=2)
        # Origin 01-01 decides on 01-02; quotes in (01-02, 01-04] are 30 and 50.
        self.assertAlmostEqual(labels.iloc[0], 40.0 - 20.0)
        self.assertAlmostEqual(labels.iloc[1], 50.0 - 30.0)
        # Windows that reach beyond the last quote stay unknown.
        self.assertTrue(labels.iloc[2:].isna().all())

    def test_future_quotes_do_not_change_earlier_labels_or_scale(self):
        levels = walk()
        changed = levels.copy()
        changed.iloc[-40:] += 500
        self.assertTrue(
            np.allclose(
                window_change(levels).iloc[:-80], window_change(changed).iloc[:-80]
            )
        )
        self.assertTrue(
            np.allclose(
                daily_scale(levels).iloc[:-40].dropna(),
                daily_scale(changed).iloc[:-40].dropna(),
            )
        )


class RangeForecastTests(unittest.TestCase):
    def test_scaling_quotes_scales_the_range(self):
        base = range_forecast(walk())
        double = range_forecast(walk() * 2)
        self.assertAlmostEqual(double["daily_sigma_bp"], 2 * base["daily_sigma_bp"])
        self.assertAlmostEqual(
            double["bands_bp"]["80"][1], 2 * base["bands_bp"]["80"][1]
        )

    def test_recent_volatility_widens_the_range_without_direction(self):
        calm, shock = walk(), walk()
        rng = np.random.default_rng(9)
        shock.iloc[-30:] = shock.iloc[-31] + np.cumsum(rng.normal(0, 5.0, 30))
        calm_range, shock_range = range_forecast(calm), range_forecast(shock)
        self.assertGreater(
            shock_range["bands_bp"]["80"][1], calm_range["bands_bp"]["80"][1]
        )
        for result in (calm_range, shock_range):
            low, high = result["bands_bp"]["80"]
            self.assertAlmostEqual(low, -high)
            self.assertAlmostEqual(
                result["p_issue_now_better"], result["p_waiting_better"]
            )
            self.assertAlmostEqual(
                result["p_issue_now_better"] + result["p_waiting_better"],
                result["p_material_move"],
            )

    def test_wider_material_threshold_lowers_material_probability(self):
        levels = walk()
        self.assertGreater(
            range_forecast(levels, material_bp=2)["p_material_move"],
            range_forecast(levels, material_bp=10)["p_material_move"],
        )

    def test_short_or_invalid_history_is_rejected(self):
        with self.assertRaises(ValueError):
            range_forecast(walk(days=200))
        duplicated = walk()
        duplicated.index = duplicated.index.where(
            np.arange(len(duplicated)) != 5, duplicated.index[4]
        )
        with self.assertRaises(ValueError):
            range_forecast(duplicated)
        with self.assertRaises(ValueError):
            range_forecast(walk(start=-1000.0))


if __name__ == "__main__":
    unittest.main()
