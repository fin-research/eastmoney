"""Protect the clock, the absence of look-ahead and the signal rule of the catch-up forecast."""

import unittest

import numpy as np
import pandas as pd

from model import timing_nowcast as nowcast


def synthetic(days=900, seed=5):
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range("2019-01-02", periods=days)
    liquid = pd.DataFrame(
        {name: 200 + np.cumsum(rng.normal(0, 1.5, days)) for name in nowcast.LIQUID},
        index=dates,
    )
    # Smoothed sector curve: each day it closes 60% of the gap to the liquid curve.
    sector = np.empty(days)
    sector[0] = liquid.CDB3.iloc[0]
    for i in range(1, days):
        sector[i] = sector[i - 1] + 0.6 * (liquid.CDB3.iloc[i] - sector[i - 1])
    funding = pd.Series(200 + np.cumsum(rng.normal(0, 1, days)), index=dates)
    return pd.Series(sector, index=dates), liquid, funding


class FeatureAndTargetTests(unittest.TestCase):
    def test_targets_are_measured_from_the_next_quote(self):
        dates = pd.bdate_range("2024-01-01", periods=8)
        sector = pd.Series([10.0, 11, 13, 16, 20, 25, 31, 38], index=dates)
        target = nowcast.targets(sector)
        self.assertEqual(target.catch_up.iloc[0], 1.0)
        self.assertEqual(target.wait_1.iloc[0], 13 - 11)
        self.assertEqual(target.wait_3.iloc[0], 20 - 11)
        self.assertTrue(np.isnan(target.wait_5.iloc[3]))

    def test_features_ignore_later_quotes(self):
        sector, liquid, funding = synthetic()
        base = nowcast.build_features(sector, liquid, funding)
        sector2, liquid2, funding2 = sector.copy(), liquid.copy(), funding.copy()
        sector2.iloc[-30:] += 100
        liquid2.iloc[-30:] += 100
        funding2.iloc[-30:] += 100
        changed = nowcast.build_features(sector2, liquid2, funding2)
        pd.testing.assert_frame_equal(base.iloc[:-30], changed.iloc[:-30])


class FitTests(unittest.TestCase):
    def test_lagging_curve_is_forecastable_from_liquid_moves(self):
        sector, liquid, funding = synthetic()
        features = nowcast.build_features(sector, liquid, funding)
        target = nowcast.targets(sector)
        forecast = nowcast.walk_forward(features, target, "2021-06-01")
        self.assertGreater(forecast.catch_up.corr(target.catch_up), 0.35)

    def test_forecast_never_uses_targets_that_were_not_yet_known(self):
        sector, liquid, funding = synthetic()
        features = nowcast.build_features(sector, liquid, funding)
        target = nowcast.targets(sector)
        base = nowcast.walk_forward(features, target, "2021-06-01")
        poisoned = target.copy()
        poisoned.iloc[-40:] = 1e6
        changed = nowcast.walk_forward(features, poisoned, "2021-06-01")
        cutoff = features.index[-40] - pd.Timedelta(days=45)
        pd.testing.assert_frame_equal(base.loc[:cutoff], changed.loc[:cutoff])

    def test_short_history_is_rejected(self):
        sector, liquid, funding = synthetic(days=300)
        features = nowcast.build_features(sector, liquid, funding)
        with self.assertRaises(ValueError):
            nowcast.fit(features, nowcast.targets(sector).catch_up)


class SignalTests(unittest.TestCase):
    def test_threshold_rule(self):
        self.assertEqual(nowcast.signal(0.8), "尽快")
        self.assertEqual(nowcast.signal(-0.8), "暂缓")
        self.assertEqual(nowcast.signal(0.2), "等待")
        self.assertEqual(nowcast.signal(-0.5), "等待")


if __name__ == "__main__":
    unittest.main()
