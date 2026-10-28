from pathlib import Path
import json
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

from data.issuance_calendar import IssuanceCalendar
from data.rate_data import build_rate_dataset, purged_training_index
from data.rate_inputs import financing_rate_inputs
from data.online_inputs import SOURCES
from model.issuance_forecast import IssuanceForecaster
from model.issuance_decision import issuance_decision
from model.issuance_validation import (
    calibrate_coupon_window,
    evaluate_issuance_forecasts,
    issuance_validation_metrics,
)


def raw_rates():
    dates = pd.bdate_range("2022-01-03", "2026-10-23").union(
        pd.DatetimeIndex(["2026-09-20"])
    )
    wave = np.sin(np.arange(len(dates)) / 20) * 0.02
    columns = [
        "DR007",
        "R007",
        "SHIBOR_3M",
        "reverse_repo_rate",
        "GOV_1Y",
        "GOV_3Y",
        "GOV_10Y",
        "CDB_3Y",
        "CDB_10Y",
        "AAA_3Y",
    ]
    return pd.DataFrame(
        {name: 1.0 + i * 0.1 + wave for i, name in enumerate(columns)}, index=dates
    )


def primary_history():
    dates = pd.date_range("2024-01-01", periods=14, freq="90D")
    return pd.DataFrame(
        {
            "issuer": ["A"] * len(dates),
            "rating": ["AAA"] * len(dates),
            "tenor": [3.0] * len(dates),
            "bond_type": ["证券公司债"] * len(dates),
            "label_available_date": dates,
            "premium_bp": np.arange(len(dates), dtype=float),
            "coupon_bp": 200 + np.arange(len(dates), dtype=float),
            "peer_residual_bp": [0.0] * len(dates),
        }
    )


TERMS = {"issuer": "A", "rating": "AAA", "tenor": 3.0, "bond_type": "证券公司债"}


class IssuanceForecastTest(unittest.TestCase):
    def engine(self, raw, history=None):
        data = build_rate_dataset(Path("synthetic.xlsx"), funding_frame=raw)
        return IssuanceForecaster(
            data, primary_history() if history is None else history
        )

    def test_four_product_scenarios_keep_missing_terms_unpriced(self):
        date = pd.Timestamp("2026-09-21")
        engine = self.engine(raw_rates())
        window, _ = engine.window(date, 30, TERMS)
        scenarios = engine.product_scenarios(date, window.iloc[0], TERMS)
        self.assertEqual(
            [(row["tenor"], row["bond_type"]) for row in scenarios],
            [
                (3, "证券公司债"),
                (5, "证券公司债"),
                (3, "证券公司次级债"),
                (5, "证券公司次级债"),
            ],
        )
        self.assertIsNotNone(scenarios[0]["coupon_percent"])
        self.assertTrue(all(row["coupon_percent"] is None for row in scenarios[1:]))

    def test_validation_hit_rate_uses_actual_coupon_error(self):
        predictions = pd.DataFrame(
            {
                "status": ["estimated", "estimated"],
                "as_of": pd.to_datetime(["2026-03-01", "2026-03-02"]),
                "bond_code": ["A", "B"],
                "lead_days": [0, 0],
                "error_bp": [4.0, -6.0],
                "actual_coupon_bp": [180.0, 180.0],
                "coupon_percent": [1.76, 1.86],
                "market_change_bp": [0.0, 0.0],
            }
        )
        self.assertEqual(
            issuance_validation_metrics(predictions).iloc[0].hit_rate_5bp, 0.5
        )

    def test_all_calendar_horizons_and_forecast_does_not_see_future(self):
        as_of = pd.Timestamp("2026-09-21")
        raw = raw_rates()
        before, _ = self.engine(raw).window(as_of, 30, TERMS)
        changed = raw.copy()
        changed.loc[changed.index >= as_of, :] += 10
        history = primary_history()
        history.loc[
            history.label_available_date >= as_of, ["coupon_bp", "premium_bp"]
        ] += 100
        after, _ = self.engine(changed, history).window(as_of, 30, TERMS)
        np.testing.assert_allclose(before.coupon_percent, after.coupon_percent)
        self.assertEqual(len(before), 17)
        self.assertEqual(before.date.iloc[-1], pd.Timestamp("2026-10-21"))
        self.assertTrue((before.market_source_date < as_of).all())
        self.assertTrue((before.market_train_label_end < as_of).all())
        self.assertFalse(before.date.between("2026-10-01", "2026-10-07").any())
        self.assertNotIn(pd.Timestamp("2026-09-25"), before.date.tolist())

    def test_short_window_and_stale_quote_gate(self):
        raw = raw_rates()
        engine = self.engine(raw)
        window, _ = engine.window("2026-09-21", 1, TERMS)
        self.assertEqual(window.lead_days.tolist(), [0, 1])
        with self.assertRaisesRegex(ValueError, "stale"):
            self.engine(raw.loc[raw.index < "2026-09-20"]).window(
                "2026-09-21", 30, TERMS
            )
        for invalid in (0, 31, True):
            with self.assertRaises(ValueError):
                engine.window("2026-09-21", invalid, TERMS)

    def test_validation_includes_pricing_on_observed_makeup_quote_day(self):
        engine = self.engine(raw_rates())
        dataset = pd.DataFrame(
            [
                {
                    **TERMS,
                    "bond_code": "A.SZ",
                    "decision_date": pd.Timestamp("2026-09-20"),
                    "coupon_bp": 200.0,
                    "anchor_market_bp": 190.0,
                    "label_available_date": pd.Timestamp("2026-09-21"),
                },
                {
                    **TERMS,
                    "bond_code": "B.SZ",
                    "decision_date": pd.Timestamp("2026-09-19"),
                    "coupon_bp": 200.0,
                    "anchor_market_bp": 190.0,
                    "label_available_date": pd.Timestamp("2026-09-21"),
                },
            ]
        )
        result = evaluate_issuance_forecasts(engine, dataset, horizons=(0, 1))
        self.assertEqual(result.bond_code.tolist(), ["A.SZ", "A.SZ"])
        self.assertTrue((result.market_source_date < result.as_of).all())

    def test_market_clock_keeps_makeup_workday_before_first_issuance(self):
        engine = self.engine(raw_rates())
        window, _ = engine.window("2026-09-20", 2, TERMS)
        self.assertEqual(window.date.iloc[0], pd.Timestamp("2026-09-21"))
        self.assertEqual(window.forecast_origin.iloc[0], pd.Timestamp("2026-09-20"))
        self.assertEqual(window.effective_horizon.tolist(), [1, 2])
        path = pd.DataFrame(engine.market_path("2026-09-21", 30)).set_index("date")
        self.assertEqual(len(path), 31)
        self.assertTrue(path.loc["2026-10-10", "quote_day"])
        self.assertFalse(path.loc["2026-10-10", "issuance_day"])
        self.assertEqual(
            path.loc["2026-10-11", "value_date"], pd.Timestamp("2026-10-10")
        )

    def test_holiday_labels_must_finish_before_training_cutoff(self):
        labels = pd.DataFrame(
            {
                "label_end": pd.to_datetime(["2026-09-24"]),
                "deadline": pd.to_datetime(["2026-09-27"]),
            },
            index=pd.to_datetime(["2026-09-20"]),
        )
        self.assertEqual(
            len(purged_training_index(labels, pd.Timestamp("2026-09-26"))), 0
        )

    def test_tree_shap_reconstructs_coupon_and_is_not_legacy_deviation(self):
        engine = self.engine(raw_rates())
        for target in ("2026-09-21", "2026-10-21"):
            result = engine.explain("2026-09-21", "2026-09-21", target, TERMS)
            self.assertEqual(result["method"], "tree_path_dependent")
            self.assertAlmostEqual(
                result["base_coupon_bp"]
                + sum(row["shap_bp"] for row in result["features"]),
                result["prediction_coupon_bp"],
                places=8,
            )
            self.assertTrue(
                any(abs(row["shap_bp"]) > 1e-8 for row in result["features"])
            )


class IssuanceCalendarAndBridgeTest(unittest.TestCase):
    def test_makeup_quote_workday_is_not_exchange_issuance_day(self):
        calendar = IssuanceCalendar()
        for date in ("2026-09-20", "2026-10-10"):
            self.assertTrue(calendar.is_quote_workday(date))
            self.assertFalse(calendar.is_issuance_day(date))
        self.assertEqual(
            calendar.previous_quote_day("2026-09-21"), pd.Timestamp("2026-09-20")
        )
        self.assertEqual(len(calendar.issuance_dates("2026-10-01", "2026-10-07")), 0)
        with self.assertRaises(ValueError):
            calendar.issuance_dates("2026-12-31", "2027-01-02")

    def test_source_bridge_preserves_history_and_checks_benchmark_identity(self):
        raw = raw_rates().loc["2026-07-01":"2026-09-20"]
        local = raw.loc[:"2026-09-18"].copy()
        local.loc["2026-09-18", ["GOV_1Y", "GOV_3Y", "GOV_10Y", "AAA_3Y"]] = 0
        rows = [
            {
                "field": code,
                "observation_date": str(date.date()),
                "published_date": str(date.date()),
                "value": float(raw.loc[date, name]),
            }
            for date in raw.index
            for code, name in SOURCES["funding"].items()
        ]
        payload = {"as_of_date": "2026-09-21", "datasets": {"funding": rows}}
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "inputs.json"
            file.write_text(json.dumps(payload))
            with patch("data.rate_inputs.load_funding_frame", return_value=local):
                joined, audit = financing_rate_inputs(
                    Path("unused"), pd.Timestamp("2026-09-21"), file
                )
                self.assertEqual(audit["appended_dates"], ["2026-09-18", "2026-09-20"])
                self.assertEqual(
                    joined.loc["2026-09-18", "AAA_3Y"], raw.loc["2026-09-18", "AAA_3Y"]
                )
                self.assertEqual(local.loc["2026-09-18", "AAA_3Y"], 0)
                next(
                    row
                    for row in rows
                    if row["field"] == "E1000413"
                    and row["observation_date"] == "2026-09-10"
                )["value"] += 0.1
                file.write_text(json.dumps(payload))
                with self.assertRaisesRegex(ValueError, "mismatch"):
                    financing_rate_inputs(
                        Path("unused"), pd.Timestamp("2026-09-21"), file
                    )


class IssuanceDecisionTest(unittest.TestCase):
    def test_joint_interval_scales_market_risk_but_keeps_issuer_risk(self):
        as_of = pd.Timestamp("2026-09-21")
        dates = pd.bdate_range("2026-01-01", periods=40)
        history = pd.DataFrame(
            [
                {
                    **TERMS,
                    "as_of": date,
                    "date": date + pd.Timedelta(days=3),
                    "label_available_date": date + pd.Timedelta(days=4),
                    "lead_days": 3,
                    "error_bp": 8.0,
                    "market_error_bp": 4.0,
                    "premium_error_bp": 4.0,
                    "market_volatility_bp": 2.0,
                }
                for date in dates
            ]
        )
        window = pd.DataFrame(
            [
                {
                    **TERMS,
                    "as_of": as_of,
                    "date": as_of + pd.Timedelta(days=3),
                    "lead_days": 3,
                    "coupon_percent": 2.0,
                    "market_volatility_bp": 1.0,
                }
            ]
        )
        result = calibrate_coupon_window(window, history, as_of, volatility_scaled=True)
        self.assertAlmostEqual(result.coupon_low_percent.iloc[0], 2.06)
        future = history.iloc[[0]].copy()
        future["as_of"] = as_of
        future["date"] = as_of + pd.Timedelta(days=3)
        future["label_available_date"] = as_of + pd.Timedelta(days=4)
        future[["error_bp", "market_error_bp", "premium_error_bp"]] = 1000
        same = calibrate_coupon_window(
            window, pd.concat([history, future]), as_of, volatility_scaled=True
        )
        pd.testing.assert_frame_equal(result, same)

    def test_waiting_cost_units_and_future_pair_outcomes(self):
        as_of = pd.Timestamp("2026-09-21")
        frame = pd.DataFrame(
            [
                {**TERMS, "date": as_of, "coupon_percent": 2.0},
                {**TERMS, "date": as_of + pd.Timedelta(days=5), "coupon_percent": 1.97},
            ]
        )
        pairs = pd.DataFrame(
            [
                {
                    **TERMS,
                    "origin": as_of - pd.Timedelta(days=50),
                    "label_available_date": as_of - pd.Timedelta(days=40),
                    "lead_days": 5,
                    "saving_error_bp": error,
                }
                for error in np.linspace(-1, 1, 25)
            ]
        )
        decision, _ = issuance_decision(frame, pairs, as_of)
        self.assertEqual(decision["action"], "等待")
        self.assertAlmostEqual(decision["annual_saving_wan"], 90)
        without_pairs, _ = issuance_decision(frame, pairs.iloc[:0], as_of)
        self.assertEqual(without_pairs["action"], "等待")
        costly, _ = issuance_decision(frame, pairs, as_of, waiting_cost_bp_day=1)
        self.assertEqual(
            costly["first_issuance_date"], costly["lowest_expected_cost_date"]
        )
        future = pairs.copy()
        future["label_available_date"] = as_of + pd.Timedelta(days=1)
        future["saving_error_bp"] = -1000
        same, _ = issuance_decision(frame, pd.concat([pairs, future]), as_of)
        self.assertEqual(decision, same)


if __name__ == "__main__":
    unittest.main()
