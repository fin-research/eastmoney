"""Protect the clock, the absence of look-ahead and the signal rule of the catch-up forecast."""

import json
import os
from pathlib import Path
import unittest

import numpy as np
import pandas as pd

from data.issuance_calendar import CALENDAR_2026
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


def archived_inputs(
    sector, liquid, funding, source="2026-10-27", as_of="2026-10-28", days=65
):
    window = sector.index[-days:]
    rows = [
        {
            "field": code,
            "observation_date": str(date.date()),
            "published_date": str(date.date()),
            "value": float(liquid[name][date]) / 100,
        }
        for name, code in nowcast.CODES.items()
        for date in window
    ] + [
        {
            "field": nowcast.FUNDING_CODE,
            "observation_date": str(date.date()),
            "published_date": str(date.date()),
            "value": float(funding[date]) / 100,
        }
        for date in window
    ]
    return {
        "as_of_date": as_of,
        "required_source_date": source,
        "datasets": {
            "funding": rows,
            "sector3": [
                {"observation_date": str(d.date()), "yield_pct": float(sector[d]) / 100}
                for d in window
            ],
        },
    }


class LiveTests(unittest.TestCase):
    def setUp(self):
        dates = pd.bdate_range(end="2026-10-27", periods=900)
        sector, liquid, funding = synthetic()
        self.sector = pd.Series(sector.to_numpy(), index=dates)
        self.liquid = liquid.set_axis(dates)
        self.funding = pd.Series(funding.to_numpy(), index=dates)
        self.features = nowcast.build_features(self.sector, self.liquid, self.funding)
        self.target = nowcast.targets(self.sector)
        forecasts = nowcast.walk_forward(self.features, self.target, "2024-06-01")
        both = pd.DataFrame({"f": forecasts.wait_3, "y": self.target.wait_3}).dropna()
        self.model = nowcast.export_model(self.features, self.target, both.y - both.f)
        self.manifest = {
            "model_version": "0" * 20,
            "training_label_cutoff": "2026-10-20",
            "calendar": CALENDAR_2026,
            "validation": {"sample_count": 1},
        }

    def test_live_row_equals_the_research_row(self):
        inputs = archived_inputs(self.sector, self.liquid, self.funding)
        live = nowcast.live_features(inputs)
        np.testing.assert_allclose(
            live.to_numpy(), self.features.iloc[[-1]].to_numpy(), atol=1e-9
        )

    def test_snapshot_follows_the_threshold_and_probabilities_sum_to_one(self):
        inputs = archived_inputs(self.sector, self.liquid, self.funding)
        snapshot = nowcast.nowcast_snapshot(self.manifest, self.model, inputs)
        wait = snapshot["forecast"]["wait_bp"]
        self.assertEqual(snapshot["decision"]["action"], nowcast.signal(wait))
        self.assertAlmostEqual(sum(snapshot["probabilities"].values()), 1.0)
        self.assertEqual(
            snapshot["base_conclusion"]["verdict"], snapshot["decision"]["action"]
        )

    def test_probabilities_move_with_the_forecast(self):
        low = nowcast.outcome_probabilities(self.model, -3.0)
        high = nowcast.outcome_probabilities(self.model, 3.0)
        self.assertGreater(low["defer"], high["defer"])
        self.assertGreater(high["issue"], low["issue"])

    def test_stale_or_wrong_day_inputs_are_rejected(self):
        inputs = archived_inputs(self.sector, self.liquid, self.funding)
        inputs["datasets"]["funding"] = [
            row
            for row in inputs["datasets"]["funding"]
            if not (
                row["field"] == "E1000174" and row["observation_date"] == "2026-10-27"
            )
        ]
        with self.assertRaises(ValueError):
            nowcast.live_features(inputs)
        wrong = archived_inputs(
            self.sector, self.liquid, self.funding, source="2026-10-26"
        )
        with self.assertRaises(ValueError):
            nowcast.nowcast_snapshot(self.manifest, self.model, wrong)

    def assert_close(self, stored, fresh, path):
        """Fitted floats may differ in the last bits across BLAS builds."""
        if isinstance(stored, dict):
            self.assertEqual(stored.keys(), fresh.keys(), path)
            for key in stored:
                self.assert_close(stored[key], fresh[key], f"{path}/{key}")
        elif isinstance(stored, list):
            self.assertEqual(len(stored), len(fresh), path)
            for i, (a, b) in enumerate(zip(stored, fresh, strict=True)):
                self.assert_close(a, b, f"{path}/{i}")
        elif isinstance(stored, float):
            self.assertAlmostEqual(
                stored, fresh, delta=1e-9 * max(1.0, abs(stored)), msg=path
            )
        else:
            self.assertEqual(stored, fresh, path)

    def test_future_rows_and_duplicate_sector_dates_are_rejected(self):
        base = archived_inputs(self.sector, self.liquid, self.funding)

        def changed(edit):
            inputs = json.loads(json.dumps(base))
            edit(inputs["datasets"])
            return inputs

        def row(code):
            return {
                "field": code,
                "observation_date": "2026-10-28",
                "published_date": "2026-10-28",
                "value": 2.0,
            }

        def unpublished(datasets):
            datasets["funding"][0]["published_date"] = "2026-10-28"

        def duplicate(datasets):
            datasets["sector3"].append({**datasets["sector3"][-1], "yield_pct": 0})

        edits = (
            lambda d: d["funding"].append(row("E1701708")),
            unpublished,
            duplicate,
        )
        for edit in edits:
            with self.assertRaises(ValueError):
                nowcast.live_features(changed(edit))
        nowcast.live_features(changed(lambda d: d["funding"].append(row("E1704420"))))

    def test_probability_middle_is_never_negative(self):
        model = {"residual_quantiles": [-7.0, -6.0, 6.0, 7.0] * 50, "threshold_bp": 0.5}
        for wait in (0.0, -3.0, 3.0):
            p = nowcast.outcome_probabilities(model, wait)
            self.assertGreaterEqual(p["wait"], 0.0)
            self.assertAlmostEqual(sum(p.values()), 1.0)

    def test_parity_fixture_matches_the_python_snapshot(self):
        """The JS runtime test reads the same file; UPDATE_FIXTURE=1 rewrites it."""
        inputs = archived_inputs(self.sector, self.liquid, self.funding, days=12)
        columns = self.model["columns"]
        small = {
            "kind": self.model["kind"],
            "columns": columns,
            "catch_up": self.model["catch_up"],
            "wait_3": self.model["wait_3"],
            "residual_quantiles": self.model["residual_quantiles"],
            "threshold_bp": self.model["threshold_bp"],
            "wait_quotes": self.model["wait_quotes"],
        }
        manifest = {
            **self.manifest,
            "feature_version": nowcast.FEATURE_VERSION,
            "training_as_of": "2026-10-28",
            "retrain_after": "2026-12-31",
        }
        expected = {
            "manifest": manifest,
            "model": small,
            "inputs": inputs,
            "features": nowcast.live_features(inputs)[columns]
            .to_numpy(float)[0]
            .tolist(),
            "snapshot": nowcast.nowcast_snapshot(manifest, small, inputs),
        }
        path = (
            Path(__file__).parent.parent
            / "online/tests/fixtures/timing-nowcast-parity.json"
        )
        if os.environ.get("UPDATE_FIXTURE") == "1":
            path.write_text(json.dumps(expected, ensure_ascii=False, allow_nan=False))
        self.assert_close(
            json.loads(path.read_text()), json.loads(json.dumps(expected)), "fixture"
        )


if __name__ == "__main__":
    unittest.main()
