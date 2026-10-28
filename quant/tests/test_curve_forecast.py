"""Temporal labels, raw-node gaps and common-denominator auxiliary evaluation."""

from types import SimpleNamespace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

from model.curve_projection import (
    curve_forecast_data,
    fit_curve_forecast,
    predict_curve_forecast,
)
from model.curve_forecast_study import _metrics, _gates, evaluate_curve_forecasts


class CurveForecastTests(unittest.TestCase):
    def setUp(self):
        self.dates = pd.bdate_range("2020-01-01", "2025-03-03")
        self.panel = SimpleNamespace(
            rates=SimpleNamespace(
                market_features=pd.DataFrame(
                    {
                        "rate_gov_1y_level": 1.0,
                        "rate_gov_3y_level": 1.5,
                        "rate_gov_10y_level": 2.0,
                    },
                    index=self.dates,
                )
            ),
            industry_nodes=pd.DataFrame(
                [
                    {
                        "observation_date": day,
                        "tenor_years": tenor,
                        "yield_pct": 2
                        + np.sin(i / 19) / 5
                        + tenor / 20 * np.cos(i / 37)
                        + np.sin(i / 7) * np.cos(tenor) / 100,
                    }
                    for i, day in enumerate(self.dates)
                    for tenor in (1, 3, 5, 7, 10)
                ]
            ),
        )

    def test_natural_days_use_quote_strictly_before_target_and_raw_gaps_stay_missing(
        self,
    ):
        x, y, meta = curve_forecast_data(self.panel)
        at = 900
        origin = self.dates[at] + pd.Timedelta(days=1)
        deadline = origin + pd.Timedelta(days=14)
        ending = self.dates[self.dates.searchsorted(deadline) - 1]
        value = (
            self.panel.industry_nodes.loc[
                self.panel.industry_nodes.observation_date.eq(ending)
                & self.panel.industry_nodes.tenor_years.eq(3),
                "yield_pct",
            ].item()
            * 100
        )
        self.assertEqual(meta.origin.iloc[at], origin)
        self.assertLess(meta.source_date.iloc[at], origin)
        self.assertLess(ending, deadline)
        self.assertAlmostEqual(y.h14_t3.iloc[at], value)
        self.panel.industry_nodes.loc[
            self.panel.industry_nodes.observation_date.eq(ending)
            & self.panel.industry_nodes.tenor_years.eq(3),
            "yield_pct",
        ] = np.nan
        _, second, _ = curve_forecast_data(self.panel)
        self.assertTrue(np.isnan(second.h14_t3.iloc[at]))
        self.assertTrue(np.isfinite(second.h14_t1.iloc[at]))
        self.assertEqual(x.shape[1], 100)
        self.assertEqual(y.shape[1], 15)

    def test_future_quotes_and_unmatured_targets_cannot_change_state(self):
        x, y, meta = curve_forecast_data(self.panel)
        cutoff = pd.Timestamp("2025-01-01")
        first = fit_curve_forecast(x, y, meta, cutoff)
        x.loc[meta.source_date.ge(cutoff)] = 8000
        y.loc[meta.deadline.ge(cutoff)] = -8000
        second = fit_curve_forecast(x, y, meta, cutoff)
        self.assertEqual(first, second)
        self.assertLess(first["audit"]["last_deadline"], "2025-01-01")
        self.assertLess(first["audit"]["last_label_date"], "2025-01-01")
        self.assertGreaterEqual(first["audit"]["first_input_date"], "2022-01-01")
        self.assertEqual(first["audit"]["components"], 3)
        sample = x.iloc[900:902].copy()
        sample.iloc[1, 5] = np.nan
        prediction = predict_curve_forecast(sample, first)
        self.assertTrue(np.isfinite(prediction[0]).all())
        self.assertTrue(np.isnan(prediction[1]).all())
        self.assertEqual(prediction.shape, (2, 15))

    def test_rank_failure_does_not_reduce_components(self):
        x, y, meta = curve_forecast_data(self.panel)
        x[:] = 180.0
        with self.assertRaisesRegex(ValueError, "three identifiable"):
            fit_curve_forecast(x, y, meta, pd.Timestamp("2025-01-01"))

    def test_missing_prediction_preserves_raw_baseline_coverage(self):
        rows = pd.DataFrame(
            {
                "period": "development",
                "lead_days": 1,
                "tenor": 3,
                "origin": pd.to_datetime(["2024-01-03", "2024-02-02", "2024-03-01"]),
                "actual_bp": [180.0, 181.0, 182.0],
                "pls3": [180.0, np.nan, 182.0],
                "current_curve": [179.0, 180.0, 181.0],
                "training_mean": [185.0, 185.0, 185.0],
            }
        )
        metric = _metrics(rows)[0]
        self.assertEqual(metric["requested"], 3)
        self.assertEqual(metric["common_samples"], 2)
        self.assertEqual(
            metric["methods"]["current_curve"]["raw_coverage"]["samples"], 3
        )
        self.assertEqual(metric["methods"]["current_curve"]["samples"], 2)
        self.assertFalse(any(r["passed"] for r in _gates([metric])))

    def test_one_bad_node_cannot_hide_behind_average_improvement(self):
        records = []
        for period in ("development", "recent"):
            for h in (1, 14, 30):
                for t in (1, 3, 5, 7, 10):
                    records.append(
                        {
                            "period": period,
                            "lead_days": h,
                            "tenor": t,
                            "requested": 50,
                            "common_samples": 50,
                            "methods": {
                                name: {"mae_bp": value}
                                for name, value in (
                                    ("pls3", 1.1 if t == 10 else 0.1),
                                    ("current_curve", 1.0),
                                    ("training_mean", 5.0),
                                )
                            },
                        }
                    )
        self.assertTrue(
            all(r["node_equal_mae_bp"]["pls3"] < 1 for r in _gates(records))
        )
        self.assertFalse(any(r["passed"] for r in _gates(records)))

    def test_complete_study_resumes_without_fitting_and_rejects_changed_evidence(self):
        dates = pd.date_range("2025-12-01", "2026-01-31", freq="7D")
        columns = [
            f"sector_{t}_quote_lag_{k}_bp" for t in (1, 3, 5, 7, 10) for k in range(20)
        ]
        targets = [f"h{h}_t{t}" for h in (1, 14, 30) for t in (1, 3, 5, 7, 10)]
        x = pd.DataFrame(180.0, index=dates, columns=columns)
        y = pd.DataFrame(181.0, index=dates, columns=targets)
        meta = pd.DataFrame(
            {"origin": dates + pd.Timedelta(days=1), "source_date": dates}, index=dates
        )

        def fit(x, y, meta, cutoff):
            return {
                "columns": columns,
                "targets": targets,
                "x_mean": [180.0] * 100,
                "coef": np.zeros((15, 100)).tolist(),
                "y_mean": [181.0] * 15,
                "audit": {"cutoff": cutoff.date().isoformat(), "complete_origins": 20},
            }

        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            with (
                patch(
                    "model.curve_forecast_study.curve_forecast_data",
                    return_value=(x, y, meta),
                ),
                patch(
                    "model.curve_forecast_study.fit_curve_forecast", side_effect=fit
                ) as fitting,
            ):
                first = evaluate_curve_forecasts(
                    None, "2026-02-01", output, "synthetic"
                )
                count = fitting.call_count
                second = evaluate_curve_forecasts(
                    None, "2026-02-01", output, "synthetic"
                )
                self.assertEqual(first, second)
                self.assertEqual(fitting.call_count, count)
                self.assertEqual(
                    first["requested_rows"],
                    first["pending_rows"]
                    + first["boundary_rows"]
                    + first["scored_requested_rows"],
                )
                self.assertGreater(first["boundary_rows"], 0)
                self.assertGreater(first["pending_rows"], 0)
                self.assertFalse(first["production_activation"])
                for suffix in (".csv", ".state.json", ".receipt.json"):
                    path = output / ("2025-12" + suffix)
                    original = path.read_bytes()
                    if suffix == ".receipt.json":
                        receipt = json.loads(original)
                        receipt["protocol_sha256"] = "changed"
                        path.write_text(json.dumps(receipt))
                    else:
                        path.write_bytes(original + b"\n")
                    with self.assertRaisesRegex(ValueError, "checkpoint differs"):
                        evaluate_curve_forecasts(
                            None, "2026-02-01", output, "synthetic"
                        )
                    path.write_bytes(original)
                self.assertEqual(fitting.call_count, count)


if __name__ == "__main__":
    unittest.main()
