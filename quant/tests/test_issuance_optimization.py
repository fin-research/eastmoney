from pathlib import Path
import unittest

import numpy as np
import pandas as pd

from data.rate_data import build_rate_dataset
from model.issuance_forecast import IssuanceForecaster
from model.issuance_optimization import (
    BASELINE,
    PRIMARY_CHALLENGERS,
    optimization_metrics,
    primary_challenger_paths,
    tenor_curve_gap,
    walk_forward_primary,
)
from test_issuance_forecast import raw_rates, primary_history, TERMS


def synthetic_paths():
    rows = []
    for index, date in enumerate(pd.date_range("2022-01-15", periods=16, freq="90D")):
        for name in PRIMARY_CHALLENGERS:
            rows.append(
                {
                    **TERMS,
                    "date_basis": "issue_date",
                    "bond_code": f"TEST{index}",
                    "pricing_date": date,
                    "as_of": date - pd.Timedelta(days=10),
                    "event_lead_days": 10,
                    "label_available_date": date + pd.Timedelta(days=1),
                    "primary_candidate": name,
                    "actual_coupon_bp": 200.0,
                    "prediction_bp": 200.0 if name == "issuer_recent_30" else 204.0,
                    "baseline_prediction_bp": 204.0,
                    "baseline_flat_bp": 205.0,
                }
            )
    return pd.DataFrame(rows)


class IssuanceOptimizationTest(unittest.TestCase):
    def test_curve_gap_has_units_knots_and_tenor_interpolation(self):
        features = pd.DataFrame(
            {"short_term_spread": [0.4] * 5, "term_spread": [1.1] * 5}
        )
        np.testing.assert_allclose(
            tenor_curve_gap(features, [1, 2, 3, 5, 10]), [-40, -20, 0, 20, 70]
        )

    def test_primary_candidates_reuse_market_and_cannot_see_future_labels(self):
        rates = build_rate_dataset(Path("synthetic"), funding_frame=raw_rates())
        history = (
            primary_history()
            .loc[lambda f: f.label_available_date < "2026-10-23"]
            .copy()
        )
        dates = rates.levels_bp.index
        history["market_anchor_date"] = dates.take(
            dates.searchsorted(history.label_available_date, side="right") - 1
        )
        engine = IssuanceForecaster(rates, history)
        as_of = pd.Timestamp("2026-09-21")
        prediction = engine.predict_one(
            as_of, as_of, as_of + pd.Timedelta(days=10), TERMS
        )
        coupon = prediction["coupon_percent"] * 100
        source = prediction["market_source_date"]
        paths = pd.DataFrame(
            [
                {
                    **prediction,
                    "candidate": "lgb_anchor_drift",
                    "pricing_date": prediction["date"],
                    "label_available_date": prediction["date"],
                    "prediction_coupon_bp": coupon,
                    "flat_coupon_bp": coupon - prediction["market_change_bp"],
                    "source_market_bp": rates.levels_bp.loc[source, "AAA_3Y"],
                }
            ]
        )
        before = primary_challenger_paths(paths, engine).set_index("primary_candidate")
        future = history.iloc[[-1]].copy()
        future["label_available_date"] = as_of
        future[["premium_bp", "coupon_bp", "peer_residual_bp"]] = 10000
        changed = IssuanceForecaster(
            rates, pd.concat([history, future], ignore_index=True)
        )
        after = primary_challenger_paths(paths, changed).set_index("primary_candidate")
        pd.testing.assert_frame_equal(before, after)
        self.assertAlmostEqual(before.loc[BASELINE, "prediction_bp"], coupon)
        self.assertAlmostEqual(
            before.loc["issuer_curve_adjusted", "prediction_bp"], coupon
        )
        self.assertTrue(
            before.market_change_bp.eq(prediction["market_change_bp"]).all()
        )

    def test_selector_needs_independent_mature_events_and_ignores_target_outcome(self):
        paths = synthetic_paths()
        selected = walk_forward_primary(paths)
        self.assertTrue(selected.iloc[:8].selected_primary.eq(BASELINE).all())
        self.assertEqual(selected.iloc[8].selected_primary, "issuer_recent_30")
        self.assertEqual(selected.iloc[8].selection_events, 8)
        target = paths.pricing_date.max()
        changed = paths.copy()
        changed.loc[changed.pricing_date.eq(target), "actual_coupon_bp"] = 10000
        same = walk_forward_primary(changed)
        np.testing.assert_allclose(selected.prediction_bp, same.prediction_bp)
        self.assertTrue(
            (
                selected.selection_latest_label.dropna()
                < selected.loc[selected.selection_latest_label.notna(), "as_of"]
            ).all()
        )
        duplicate = pd.concat([paths] * 30, ignore_index=True)
        replay = walk_forward_primary(duplicate)
        self.assertEqual(
            replay.selection_events.tolist(), selected.selection_events.tolist()
        )

    def test_gate_uses_events_and_rejects_missing_predictions(self):
        paths = synthetic_paths()
        metrics = optimization_metrics(paths).set_index("primary_candidate")
        self.assertTrue(metrics.loc["issuer_recent_30", "research_gate_passed"])
        self.assertEqual(metrics.loc["issuer_recent_30", "events"], 16)
        self.assertAlmostEqual(metrics.loc["issuer_recent_30", "event_gain_bp"], 4.0)
        missing = paths.copy()
        index = missing.index[missing.primary_candidate.eq("issuer_recent_30")][0]
        missing.loc[index, "prediction_bp"] = np.nan
        checked = optimization_metrics(missing).set_index("primary_candidate")
        self.assertFalse(checked.loc["issuer_recent_30", "research_gate_passed"])
        self.assertEqual(checked.loc["issuer_recent_30", "requested"], 16)
        self.assertEqual(checked.loc["issuer_recent_30", "predictions"], 15)


if __name__ == "__main__":
    unittest.main()
