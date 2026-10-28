"""利率研究的信息集、标签成熟边界和可执行选日回归。"""

from pathlib import Path
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

from data.rate_data import build_rate_dataset, horizon_labels, purged_training_index
from model.rate_evaluation import evaluate_fixed_origin_policy, evaluate_rate_candidates
from model.rate_forecast import RateCandidate
from model.rate_policy import evaluate_rolling_policy
from model.rate_diagnostics import add_decomposed_predictions


def source_frame():
    dates = pd.bdate_range("2020-01-01", "2023-02-01")
    wave = np.sin(np.arange(len(dates)) / 20) * 0.1
    columns = [
        "DR007",
        "R007",
        "SHIBOR_3M",
        "GOV_1Y",
        "GOV_3Y",
        "GOV_10Y",
        "CDB_3Y",
        "CDB_10Y",
        "AAA_3Y",
        "reverse_repo_rate",
    ]
    return pd.DataFrame(
        {name: 2 + wave + i * 0.1 for i, name in enumerate(columns)}, index=dates
    )


def dataset_from_frame(frame):
    with patch("data.rate_data.load_funding_frame", return_value=frame):
        return build_rate_dataset(Path("synthetic.xlsx"))


class RateInformationSetTest(unittest.TestCase):
    def test_future_changes_do_not_change_historical_features(self):
        frame = source_frame()
        before = dataset_from_frame(frame)
        cutoff = pd.Timestamp("2022-01-03")
        frame.loc[cutoff:, "GOV_3Y"] += 10
        after = dataset_from_frame(frame)
        pd.testing.assert_frame_equal(
            before.features.loc[:cutoff], after.features.loc[:cutoff]
        )
        self.assertLess(before.source_dates.loc[cutoff], cutoff)

    def test_zero_horizon_is_today_rate_against_previous_quote(self):
        data = dataset_from_frame(source_frame())
        labels = horizon_labels(data, "AAA_3Y", 0)
        date = pd.Timestamp("2022-01-03")
        previous = pd.Timestamp("2021-12-31")
        self.assertEqual(labels.loc[date, "label_end"], date)
        self.assertAlmostEqual(
            labels.loc[date, "change_bp"],
            data.levels_bp.loc[date, "AAA_3Y"] - data.levels_bp.loc[previous, "AAA_3Y"],
        )

    def test_calendar_horizon_and_right_censoring(self):
        data = dataset_from_frame(source_frame())
        labels = horizon_labels(data, "AAA_3Y", 30)
        date = pd.Timestamp("2022-01-03")
        self.assertEqual(labels.loc[date, "deadline"], pd.Timestamp("2022-02-02"))
        self.assertTrue((labels.deadline <= data.levels_bp.index.max()).all())
        self.assertTrue((labels.label_end <= labels.deadline).all())
        for invalid in (-1, 31, 1.5, True):
            with self.assertRaises(ValueError):
                horizon_labels(data, "AAA_3Y", invalid)

    def test_long_holidays_do_not_remove_eligible_origins(self):
        frame = source_frame().drop(pd.bdate_range("2022-10-03", "2022-10-07"))
        labels = horizon_labels(dataset_from_frame(frame), "AAA_3Y", 7)
        origin = pd.Timestamp("2022-09-30")
        self.assertIn(origin, labels.index)
        self.assertEqual(labels.loc[origin, "label_end"], origin)
        self.assertEqual(labels.loc[origin, "quote_age_at_deadline_days"], 7)

    def test_purge_checks_label_end_not_just_origin(self):
        data = dataset_from_frame(source_frame())
        labels = horizon_labels(data, "AAA_3Y", 30)
        cutoff = pd.Timestamp("2022-01-03")
        selected = purged_training_index(labels, cutoff)
        self.assertTrue((labels.loc[selected, "label_end"] < cutoff).all())
        self.assertNotIn(pd.Timestamp("2021-12-20"), selected)

    def test_incomplete_latest_quote_does_not_claim_newer_rate_date(self):
        raw = source_frame()
        raw.loc[raw.index[-1], "AAA_3Y"] = 0
        data = dataset_from_frame(raw)
        self.assertEqual(data.audit["incomplete_quote_days"], 1)
        self.assertEqual(data.audit["source_end"], str(raw.index[-2].date()))


class RateEvaluationTest(unittest.TestCase):
    def test_fold_predictions_do_not_use_later_test_values(self):
        frame = source_frame()
        kwargs = dict(
            start="2022-01-01",
            end="2022-04-01",
            horizons=(0, 30),
            targets=("AAA_3Y",),
            candidates=(RateCandidate("ridge", "ridge"),),
        )
        before = evaluate_rate_candidates(dataset_from_frame(frame), **kwargs)
        frame.loc["2022-03-01":, "AAA_3Y"] += 10
        after = evaluate_rate_candidates(dataset_from_frame(frame), **kwargs)
        earlier = before.origin.le(pd.Timestamp("2022-03-01"))
        np.testing.assert_allclose(
            before.loc[earlier, "prediction_bp"], after.loc[earlier, "prediction_bp"]
        )
        self.assertTrue((before.train_label_end < pd.to_datetime(before.fold)).all())
        self.assertTrue((before.label_end < pd.Timestamp("2022-04-01")).all())

    def test_policy_selection_never_uses_realized_future_cost(self):
        origin = pd.Timestamp("2022-01-03")
        paths = pd.DataFrame(
            {
                "origin": [origin] * 3,
                "target": ["AAA_3Y"] * 3,
                "candidate": ["example"] * 3,
                "horizon": [0, 5, 30],
                "prediction_bp": [0, -5, -3],
                "target_bp": [250, 260, 240],
                "label_end": pd.to_datetime(["2022-01-03", "2022-01-07", "2022-02-02"]),
                "deadline": pd.to_datetime(["2022-01-03", "2022-01-08", "2022-02-02"]),
            }
        )
        result = evaluate_fixed_origin_policy(paths).iloc[0]
        self.assertEqual(result.chosen_horizon, 5)
        self.assertEqual(result.saving_vs_immediate_bp, -10)
        self.assertEqual(result.regret_bp, 20)
        paths["target_bp"] = [250, 200, 150]
        self.assertEqual(evaluate_fixed_origin_policy(paths).iloc[0].chosen_horizon, 5)


class RollingRatePolicyTest(unittest.TestCase):
    def test_component_forecast_reconciles_targets_and_units(self):
        frame = pd.DataFrame(
            [
                {
                    "target": target,
                    "candidate": model,
                    "change_bp": actual,
                    "prediction_bp": predicted,
                }
                for target, model, actual, predicted in (
                    ("AAA_3Y", "random_walk", 5.0, 0.0),
                    ("GOV_3Y", "random_walk", 2.0, 0.0),
                    ("GOV_3Y", "historical_drift", 2.0, 0.5),
                    ("CREDIT_3Y", "lgb_anchor_1", 3.0, 0.2),
                )
            ]
        )
        frame["origin"] = pd.Timestamp("2022-01-03")
        frame["horizon"] = 0
        frame["fold"] = "2022-01-01"
        frame["label_end"] = pd.Timestamp("2022-01-03")
        frame["train_label_end"] = pd.Timestamp("2021-12-31")
        frame["train_samples"] = 500
        combined = add_decomposed_predictions(frame)
        row = combined.loc[combined.candidate.eq("decomposed_drift_short")].iloc[0]
        self.assertAlmostEqual(row.prediction_bp, 0.7)
        frame.loc[frame.target.eq("CREDIT_3Y"), "change_bp"] = 300
        with self.assertRaisesRegex(ValueError, "units"):
            add_decomposed_predictions(frame)

    def test_rolling_strategy_waits_then_reassesses_without_hindsight(self):
        dates = pd.date_range("2022-01-03", periods=3)
        rows = []
        for i, origin in enumerate(dates):
            for horizon in range(3 - i):
                rows.append(
                    {
                        "origin": origin,
                        "horizon": horizon,
                        "target": "AAA_3Y",
                        "candidate": "example",
                        "prediction_bp": -horizon if i == 0 else horizon,
                        "target_bp": [250, 255, 240][i + horizon],
                        "label_end": dates[i + horizon],
                        "deadline": dates[i + horizon],
                    }
                )
        frame = pd.DataFrame(rows)
        result = evaluate_rolling_policy(frame, planning_days=2).iloc[0]
        self.assertEqual(result.chosen_date, dates[1])
        self.assertEqual(result.saving_vs_immediate_bp, -5)
        self.assertEqual(result.status, "evaluated")
        frame.loc[frame.label_end.eq(dates[2]), "target_bp"] = 100
        self.assertEqual(
            evaluate_rolling_policy(frame, planning_days=2).iloc[0].chosen_date,
            dates[1],
        )


if __name__ == "__main__":
    unittest.main()
