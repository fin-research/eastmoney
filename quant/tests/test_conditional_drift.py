import unittest

import numpy as np
import pandas as pd

from model.conditional_drift import fit_conditional_drift, market_states
from model.conditional_diagnostics import (
    market_comparisons,
    paired_saving_probabilities,
    CONDITIONAL_COMPARISON,
)
from model.rate_forecast import (
    RATE_CANDIDATES,
    candidate_features,
    fit_rate_candidate,
    predict_rate_candidate,
)


class ConditionalDriftTest(unittest.TestCase):
    def test_states_shrink_and_sparse_or_unknown_states_fall_back(self):
        features = pd.DataFrame(
            {
                "dr007_vs_policy": [-0.2] * 120 + [0.2] * 120,
                "rate_aaa_3y_change_20": [-10.0] * 120 + [10.0] * 120,
                "rate_aaa_3y_volatility_20": [1.0] * 240,
            }
        )
        labels = pd.Series([-4.0] * 120 + [4.0] * 120)
        model = fit_conditional_drift(features, labels)
        np.testing.assert_allclose(model.predict(features.iloc[[0, -1]]), [-2, 2])
        missing = features.iloc[[0]].copy()
        missing["dr007_vs_policy"] = np.nan
        self.assertEqual(model.predict(missing)[0], 0)
        self.assertEqual(market_states(missing, model.volatility_cutoff)[0], -1)
        sparse = fit_conditional_drift(features.iloc[:20], labels.iloc[:20])
        self.assertEqual(sparse.predict(features.iloc[[0]])[0], -4)
        candidate = next(c for c in RATE_CANDIDATES if c.name == "conditional_drift")
        cols = candidate_features(features, "AAA_3Y", candidate.feature_set)
        fitted = fit_rate_candidate(candidate, features[cols], labels)
        np.testing.assert_allclose(
            predict_rate_candidate(fitted, features.iloc[[0]][cols], candidate), [-2]
        )

    def test_signal_denominator_is_selected_by_prediction_only(self):
        rows = []
        for name in CONDITIONAL_COMPARISON:
            for i, actual in enumerate([-3.0, 3.0]):
                rows.append(
                    {
                        "origin": pd.Timestamp("2025-01-01") + pd.Timedelta(days=i),
                        "candidate": name,
                        "horizon": 30,
                        "prediction_bp": -3.0,
                        "change_bp": actual,
                    }
                )
        comparisons = market_comparisons(pd.DataFrame(rows))
        self.assertTrue(comparisons.signal_samples.eq(2).all())
        self.assertTrue(comparisons.actual_decline_given_signal.eq(0.5).all())
        self.assertTrue(comparisons.difference_low90_bp.isna().all())
        inconsistent = pd.DataFrame(rows)
        inconsistent.loc[0, "change_bp"] = 999
        with self.assertRaisesRegex(ValueError, "inconsistent actual"):
            market_comparisons(inconsistent)

    def test_saving_probability_uses_mature_joint_errors_and_waiting_cost(self):
        rows = []
        dates = pd.date_range("2024-01-01", periods=160)
        for date in dates:
            for horizon in (0, 5):
                rows.append(
                    {
                        "candidate": "conditional_drift",
                        "origin": date,
                        "horizon": horizon,
                        "label_end": date + pd.Timedelta(days=horizon),
                        "deadline": date + pd.Timedelta(days=horizon),
                        "prediction_bp": -3.0 if horizon else 0.0,
                        "change_bp": -2.0 if horizon else 0.0,
                    }
                )
        frame = pd.DataFrame(rows)
        result = paired_saving_probabilities(frame, cost=0.1)
        last = result.iloc[-1]
        self.assertEqual(last.probability_net_saving_gt0, 1)
        self.assertEqual(last.probability_net_saving_gt2, 0)
        self.assertAlmostEqual(last.saving_p10_bp, 1.5)
        self.assertLess(last.calibration_deadline, last.origin)
        frame.loc[frame.origin.eq(dates[-1]), "change_bp"] = 1000
        changed = paired_saving_probabilities(frame, cost=0.1).iloc[-1]
        self.assertEqual(changed.saving_p10_bp, last.saving_p10_bp)


if __name__ == "__main__":
    unittest.main()
