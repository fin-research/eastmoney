"""Whole-path maturity, executable minima, payoff units and explanation identities."""

import unittest
from unittest.mock import patch
from tempfile import TemporaryDirectory
from pathlib import Path

import numpy as np
import pandas as pd

from test_timing_policy import synthetic_rates
from model.rate_curve import (
    CURVE_CANDIDATES,
    curve_labels,
    fit_curve,
    predict_curve,
    explain_curve,
    score_curve_paths,
)
from model.statistical_validity import paired_block_test
from model.curve_research import selected_cost_uncertainty, _choose_current_dates


class JointCurveTest(unittest.TestCase):
    def test_frozen_run_is_rejected_before_fetching_or_overwriting_inputs(self):
        from pipeline import run_curve_research

        with TemporaryDirectory() as folder:
            directory = Path(folder)
            (directory / "protocol.json").write_text("{}")
            (directory / "inputs.json").write_text("original")
            with patch("application.curve_research._prepare_issuance_engine") as prepare:
                with self.assertRaisesRegex(ValueError, "already frozen"):
                    run_curve_research(directory, "2026-09-22", None, None, 30, {})
                prepare.assert_not_called()
            self.assertEqual((directory / "inputs.json").read_text(), "original")
            (directory / "protocol.json").unlink()
            with patch("application.curve_research._prepare_issuance_engine") as prepare:
                with self.assertRaisesRegex(ValueError, "directory nonempty"):
                    run_curve_research(directory, "2026-09-22", None, None, 30, {})
                prepare.assert_not_called()
            self.assertEqual((directory / "inputs.json").read_text(), "original")

    def test_fixed_deadline_current_rule_does_not_use_reference_curve_minimum(self):
        horizons = np.array([0, 1, 2, 7, 28, 30, 60])
        net = np.array([0, -5, 0, 0, 0, 0, 10])
        chosen, dates = _choose_current_dates("fixed_60", horizons, net)
        self.assertEqual(chosen, 6)
        np.testing.assert_array_equal(dates, [6])

    def test_selected_rule_calibration_excludes_unmatured_windows(self):
        dates = pd.bdate_range("2020-01-01", periods=180)
        frame = pd.DataFrame(
            {
                "origin": dates,
                "deadline": dates + pd.Timedelta(days=30),
                "policy": "curve_test",
                "realized_cost_bp": -1.0,
                "predicted_selected_bp": -0.5,
            }
        )
        as_of = pd.Timestamp("2021-01-01")
        expected = selected_cost_uncertainty(frame, "curve_test", as_of, -0.5, "AAA_3Y")
        future = frame.copy()
        future["deadline"] = as_of
        future["realized_cost_bp"] = 999
        actual = selected_cost_uncertainty(
            pd.concat([frame, future]), "curve_test", as_of, -0.5, "AAA_3Y"
        )
        self.assertEqual(actual, expected)
        self.assertEqual(actual["samples"], 180)
        self.assertEqual(actual["saving_probability"], 1)

    def test_sixty_day_target_is_mature_and_not_truncated_to_thirty(self):
        rates = synthetic_rates()
        labels, costs = curve_labels(rates, 60)
        self.assertEqual(costs.shape[1], 61)
        origin = pd.Timestamp("2022-01-03")
        expected = (
            rates.levels_bp.loc[origin + pd.Timedelta(days=60), "AAA_3Y"]
            - rates.levels_bp.loc[origin, "AAA_3Y"]
        )
        self.assertAlmostEqual(costs.loc[origin, 60], expected)
        self.assertTrue(labels.deadline.le(rates.levels_bp.index.max()).all())

    def test_joint_fit_is_invariant_to_future_targets_and_shap_reconstructs(self):
        rates = synthetic_rates()
        labels, costs = curve_labels(rates, 30)
        cutoff = pd.Timestamp("2022-01-01")
        candidate = CURVE_CANDIDATES[2]
        original = fit_curve(rates, labels, costs, cutoff, candidate)
        changed = costs.copy()
        changed.loc[labels.deadline >= cutoff] += 999
        modified = fit_curve(rates, labels, changed, cutoff, candidate)
        X = rates.features.loc[[pd.Timestamp("2022-01-03")]]
        np.testing.assert_allclose(
            predict_curve(original, X), predict_curve(modified, X)
        )
        self.assertLess(original["train_deadline_max"], cutoff)
        explanation = explain_curve(original, X, 23)
        self.assertAlmostEqual(
            explanation["base_bp"] + sum(r["shap_bp"] for r in explanation["features"]),
            explanation["prediction_bp"],
            places=7,
        )

    def test_closed_date_is_not_selected_and_sixty_day_baseline_is_named(self):
        rates = synthetic_rates()
        labels, costs = curve_labels(rates, 60)
        origin = pd.Timestamp("2022-01-03")
        one = labels.loc[[origin]]
        predicted = np.zeros((1, 61))
        predicted[0, 5] = -100  # Saturday cannot win.
        predicted[0, 8] = -5
        row = score_curve_paths(
            one, costs.loc[[origin]], predicted, "test", origin
        ).iloc[0]
        self.assertEqual(row.selected_horizon, 8)
        self.assertIn("baseline_60_bp", row.index)
        self.assertNotIn("baseline_30_bp", row.index)

    def test_credit_signal_is_still_scored_on_absolute_funding_cost(self):
        rates = synthetic_rates()
        labels, costs = curve_labels(rates, 30)
        origin = pd.Timestamp("2022-01-03")
        one = labels.loc[[origin]]
        credit = costs.loc[[origin]].copy() * 0
        absolute = credit.copy()
        credit.loc[origin, 8] = -3
        absolute.loc[origin, 8] = 5
        row = score_curve_paths(
            one, credit, credit.to_numpy(), "credit", origin, outcome_costs=absolute
        ).iloc[0]
        self.assertEqual(row.selected_horizon, 8)
        self.assertEqual(row.objective_realized_bp, -3)
        self.assertEqual(row.realized_cost_bp, 5)

    def test_small_number_of_blocks_cannot_gain_precision_from_repetitions(self):
        result = paired_block_test(
            [-2.71, 4.65, 6.81, -2.57, 11.08, 4.80, -0.37, -1.93],
            block_size=3,
            repetitions=99999,
        )
        self.assertEqual(result["status"], "insufficient_blocks")
        self.assertTrue(np.isnan(result["p_one_sided"]))

    def test_short_curve_shap_matches_interpolation_and_no_long_extrapolation(self):
        rates = synthetic_rates()
        labels, costs = curve_labels(rates, 30)
        candidate = next(c for c in CURVE_CANDIDATES if c.name == "curve_short_lgb")
        fit = fit_curve(rates, labels, costs, pd.Timestamp("2022-01-01"), candidate)
        X = rates.features.loc[[pd.Timestamp("2022-01-03")]]
        path = predict_curve(fit, X)[0]
        self.assertEqual(path[0], 0)
        self.assertAlmostEqual(path[2], (path[1] + path[3]) / 2)
        np.testing.assert_allclose(path[5:], path[5])
        for h in (0, 2, 5, 30):
            explanation = explain_curve(fit, X, h)
            self.assertAlmostEqual(
                explanation["base_bp"]
                + sum(r["shap_bp"] for r in explanation["features"]),
                path[h],
                places=7,
            )


if __name__ == "__main__":
    unittest.main()
