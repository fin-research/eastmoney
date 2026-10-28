"""外部两融报告方法的可复现性与集成权重测试。"""

from __future__ import annotations

import unittest

import numpy as np
import pandas as pd

from archive.margin_flow.report_method_experiment import ReportMethodForecastEngine


class TestReportMethodForecastEngine(unittest.TestCase):
    def test_paths_are_deterministic_and_cached(self):
        dates = pd.bdate_range("2025-01-01", periods=100)
        balance = pd.Series(
            10_000.0 + np.linspace(0.0, 500.0, len(dates)),
            index=dates,
        )
        engine = ReportMethodForecastEngine(
            max_horizon=5,
            n_simulations=128,
            random_seed=7,
        )

        first = engine.paths(balance, dates[-1])
        second = engine.paths(balance * 2.0, dates[-1])

        self.assertIs(first, second)
        self.assertEqual(
            set(first),
            {"report_arima211", "report_holt_damped", "report_mc_median"},
        )
        for path in first.values():
            self.assertEqual(path.shape, (5,))
            self.assertTrue(np.isfinite(path).all())

    def test_ensemble_weights_match_report_for_short_and_medium_horizons(self):
        paths = {
            "report_arima211": np.full(20, 100.0),
            "report_holt_damped": np.full(20, 200.0),
            "report_mc_median": np.full(20, 300.0),
        }

        short = ReportMethodForecastEngine.ensemble_value(paths, 5)
        medium = ReportMethodForecastEngine.ensemble_value(paths, 20)

        self.assertAlmostEqual(short, 0.7 * (0.55 * 100 + 0.45 * 200) + 0.3 * 300)
        self.assertAlmostEqual(
            medium,
            0.6 * (0.45 * 100 + 0.55 * 200) + 0.4 * 300,
        )


if __name__ == "__main__":
    unittest.main()
