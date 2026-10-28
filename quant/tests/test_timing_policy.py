"""Protect the decision objective, maturity clock and economic evaluation cohort."""

import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

from data.rate_data import RateDataset
from model.timing_policy import (
    TimingCandidate,
    _action_frame,
    action_labels,
    choose_actions,
    evaluate_timing_policies,
    select_policy,
)
from model.timing_research import research_admission


def synthetic_rates():
    dates = pd.bdate_range("2019-01-01", "2023-01-01")
    phase = np.arange(len(dates)) / 15
    market = pd.DataFrame(
        {
            "dr007_vs_policy": np.cos(phase),
            "rate_aaa_3y_volatility_20": np.ones(len(dates)),
        },
        index=dates,
    )
    levels = pd.DataFrame({"AAA_3Y": 250 + 10 * np.sin(phase)}, index=dates)
    return RateDataset(
        market.shift(),
        levels,
        pd.Series(dates, index=dates).shift(),
        {"source": "synthetic"},
        market,
    )


class TimingPolicyTest(unittest.TestCase):
    def test_target_excludes_same_day_rate_prediction(self):
        data = synthetic_rates()
        labels = action_labels(data)
        origin = pd.Timestamp("2022-01-03")
        endpoint = labels.loc[origin, "date_7"]
        self.assertEqual(labels.loc[origin, "cost_0"], 0)
        self.assertAlmostEqual(
            labels.loc[origin, "cost_7"],
            data.levels_bp.loc[endpoint, "AAA_3Y"]
            - data.levels_bp.loc[origin, "AAA_3Y"],
        )

    def test_holiday_price_carry_does_not_erase_waiting_cost(self):
        origin = pd.Timestamp("2022-01-03")
        labels = pd.DataFrame(
            {
                "deadline": [origin + pd.Timedelta(days=30)],
                **{f"cost_{h}": [0.0] for h in (0, 7, 30)},
                **{f"date_{h}": [origin] for h in (0, 7, 30)},
            },
            index=[origin],
        )
        row = _action_frame(
            labels,
            np.array([[0, -1, -2]]),
            TimingCandidate("test", "zero"),
            0,
            origin,
            0.1,
        ).iloc[0]
        self.assertAlmostEqual(row.baseline_7_bp, 0.7)
        self.assertAlmostEqual(row.baseline_30_bp, 3.0)
        self.assertEqual(row.chosen_horizon, 7)

    def test_actions_use_costs_and_explicit_neutral_margin(self):
        forecasts = np.array([[0, 3, 4], [0, -3, -1], [0, -2, -5]])
        np.testing.assert_array_equal(
            choose_actions(forecasts, np.tile([0, 7, 30], (3, 1))), [0, 1, 2]
        )
        self.assertEqual(
            choose_actions(np.array([[0, -1, -2]]), np.array([[0, 7, 30]]), margin=2)[
                0
            ],
            1,
        )
        with self.assertRaisesRegex(ValueError, "nonfinite"):
            choose_actions(np.array([[0, np.nan, 1]]), np.array([[0, 7, 30]]))

    def test_inner_selection_cannot_see_unmatured_or_future_returns(self):
        origins = pd.date_range("2020-01-01", periods=24, freq="MS")
        rows = [
            {
                "origin": date,
                "deadline": date + pd.Timedelta(days=30),
                "policy": name,
                "realized_cost_bp": cost,
            }
            for date in origins
            for name, cost in (("fixed_7", 1), ("candidate", -1))
        ]
        frame = pd.DataFrame(rows)
        cutoff = pd.Timestamp("2022-01-01")
        before = select_policy(frame, cutoff)
        self.assertEqual(before[0], "candidate")
        self.assertLess(before[2], cutoff)
        late = frame.copy()
        late["deadline"] = cutoff
        late["realized_cost_bp"] = -1e9
        after = select_policy(pd.concat([frame, late]), cutoff)
        self.assertEqual(before, after)
        with self.assertRaisesRegex(ValueError, "identical policy coverage"):
            select_policy(frame.iloc[1:], cutoff)

    def test_nested_backtest_does_not_retrain_on_outer_results(self):
        before = synthetic_rates()
        after = synthetic_rates()
        after.levels_bp.loc["2022-03-01":, "AAA_3Y"] += 100
        candidates = (
            TimingCandidate(
                "cost_scaled_ridge_local",
                "ridge",
                "local",
                100,
                normalize_volatility=True,
            ),
            TimingCandidate("cost_ridge_local", "ridge", "local", 100),
        )
        with patch("model.timing_policy.TIMING_CANDIDATES", candidates):
            left, _ = evaluate_timing_policies(
                before, start="2022-01-01", end="2022-04-01"
            )
            right, _ = evaluate_timing_policies(
                after, start="2022-01-01", end="2022-04-01"
            )
        # All Q1 feature rows were unchanged; changing outcomes cannot change actions.
        np.testing.assert_array_equal(left.chosen_horizon, right.chosen_horizon)
        self.assertTrue(
            left.loc[left.train_deadline_max.notna(), "train_deadline_max"]
            .lt("2022-01-01")
            .all()
        )
        self.assertFalse(left.realized_cost_bp.equals(right.realized_cost_bp))

    def test_insufficient_or_only_one_baseline_evidence_cannot_pass(self):
        tests = pd.DataFrame(
            {
                "policy": ["nested_cost_policy"],
                "period": ["development"],
                "baseline": ["fixed_0"],
                "significant_95": [True],
                "gain_bp": [10],
            }
        )
        admission = research_admission(tests)
        self.assertFalse(admission["historical_proxy_gate_passed"])
        self.assertFalse(admission["production_activation"])


if __name__ == "__main__":
    unittest.main()
