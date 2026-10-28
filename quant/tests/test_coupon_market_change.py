import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest

import numpy as np
import pandas as pd

from data.issuance_training import IssuancePanel
from data.issuance_industry_tenor import AAA_CURVE_CODE
from model.issuance_market_change import MARKET_STATES, fit_market_change, market_change
from model.issuance_unified import CouponCandidate, CouponModel
from model.export import write_json


def market_panel():
    dates = pd.bdate_range("2022-01-01", "2026-01-01")
    t = np.arange(len(dates))
    curve = 2.5 - t * 0.0003 + 0.12 * np.sin(t / 11)
    frame = pd.DataFrame(index=dates)
    for name in MARKET_STATES:
        frame[name] = (
            np.cos(t / 11) if "change" in name or "chg" in name else np.sin(t / 11)
        )
    for name, value in (
        ("rate_gov_1y_level", 1.8),
        ("rate_gov_3y_level", 2.0),
        ("rate_gov_10y_level", 2.2),
    ):
        frame[name] = value
    nodes = pd.DataFrame(
        [
            {
                "curve_code": AAA_CURVE_CODE,
                "observation_date": day,
                "tenor_years": tenor,
                "yield_pct": value + tenor * 0.01,
            }
            for day, value in zip(dates, curve, strict=True)
            for tenor in (1.0, 3.0, 5.0, 7.0, 10.0)
        ]
    )
    events = []
    for i in range(100):
        position = 300 + i * 6
        events.append(
            {
                "bond_code": f"{i}.SH",
                "issuer": "发行人",
                "rating": "AAA",
                "bond_type": "证券公司债",
                "placement_type": "公募",
                "tenor": 3.0,
                "issue_size": 20.0,
                "pricing_date": dates[position],
                "label_available_date": dates[position] + pd.Timedelta(days=1),
                "coupon_bp": (curve[position - 1] + 0.03) * 100 + 10,
                "history_premium_bp": 30.0,
            }
        )
    return IssuancePanel(
        SimpleNamespace(market_features=frame),
        pd.DataFrame(events),
        {},
        industry_nodes=nodes,
    )


class MarketChangeTests(unittest.TestCase):
    def test_dense_training_purges_deadlines_and_ignores_appended_future(self):
        panel = market_panel()
        original = fit_market_change(panel, "2025-01-01", "centered")
        future = panel.rates.market_features.index >= "2025-01-01"
        panel.rates.market_features.loc[future, list(MARKET_STATES)] = 9999
        panel.industry_nodes.loc[
            panel.industry_nodes.observation_date >= "2025-01-01", "yield_pct"
        ] = 99
        rebuilt = fit_market_change(panel, "2025-01-01", "centered")
        self.assertEqual(original, rebuilt)
        for model in original["models"].values():
            self.assertLess(model["audit"]["latest_deadline"], "2025-01-01")
            self.assertLess(model["audit"]["label_end"], "2025-01-01")

    def test_same_origin_path_uses_market_and_coupon_components_once_with_js_parity(
        self,
    ):
        self.check_market_parity("lgb_centered")

    def test_balanced_and_shrunk_predictions_and_contributions_match_js(self):
        for mode in ("balanced", "balanced_half", "tenor", "tenor_shape"):
            with self.subTest(mode=mode):
                self.check_market_parity(mode)

    def check_market_parity(self, mode):
        panel = market_panel()
        rows = panel.requests((0, 7, 30))
        features = panel.features(
            rows,
            include_weighted_primary=True,
            include_industry_tenor=True,
            include_curve_dynamics=True,
        )
        candidate = CouponCandidate(
            "lgb", "pricing_excess", 5, 5, "combined", "front30", mode
        )
        model = CouponModel(candidate).fit(
            features, rows, "2025-10-01", market_panel=panel
        )
        sample = features.iloc[-3:].copy()
        sample.loc[sample.index[0], "lead_days"] = 0
        change = market_change(model.market_layer, sample)
        self.assertEqual(change[0], 0)
        self.assertTrue(np.any(np.abs(change[1:]) > 0.01))
        prediction = model.predict(sample)
        phi = model.contributions(sample)
        np.testing.assert_allclose(phi.sum(axis=1), prediction, atol=1e-8)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "vectors.json"
            write_json(
                path,
                {
                    "model": model.export(),
                    "vectors": model.encode(sample).to_numpy().tolist(),
                    "anchors": sample.known_treasury_bp.tolist(),
                },
            )
            runtime = Path(__file__).resolve().parents[1] / "online/coupon-model.mjs"
            code = f"import {{readFileSync}} from 'node:fs';import {{couponPrediction,couponExplanation}} from {json.dumps(runtime.as_uri())};const f=JSON.parse(readFileSync(process.argv[1]));console.log(JSON.stringify(f.vectors.map((v,i)=>[couponPrediction(f.model,v,f.anchors[i]),couponExplanation(f.model,v,f.anchors[i])])));"
            result = json.loads(
                subprocess.check_output(
                    ["node", "--input-type=module", "-e", code, str(path)], text=True
                )
            )
        np.testing.assert_allclose([r[0] for r in result], prediction, atol=1e-8)
        np.testing.assert_allclose(
            [r[1]["values"] + [r[1]["expected"]] for r in result], phi, atol=1e-8
        )

    def test_balanced_weights_only_use_mature_origins_and_shrink_entire_prediction(
        self,
    ):
        panel = market_panel()
        original = fit_market_change(panel, "2025-01-01", "balanced")
        half = fit_market_change(panel, "2025-01-01", "balanced_half")
        for horizon, fitted in original["models"].items():
            np.testing.assert_allclose(
                half["models"][horizon]["coefficients"],
                np.asarray(fitted["coefficients"]) * 0.5,
            )
            self.assertEqual(
                half["models"][horizon]["intercept"], fitted["intercept"] * 0.5
            )
            self.assertLess(fitted["audit"]["latest_deadline"], "2025-01-01")
        panel.industry_nodes.loc[
            panel.industry_nodes.observation_date >= "2025-01-01", "yield_pct"
        ] = 9999
        self.assertEqual(original, fit_market_change(panel, "2025-01-01", "balanced"))

    def test_origin_balancing_preserves_mass_caps_and_falls_back_for_sparse_regimes(
        self,
    ):
        from model.issuance_market_change import balanced_origin_weights

        changes = np.repeat([2.0, -2.0, 0.0], [30, 300, 30])
        origins = pd.date_range("2020-01-01", periods=len(changes))
        labels = pd.DataFrame(
            {"origin": origins.repeat(5), "change_bp": np.repeat(changes, 5)}
        )
        weights, audit = balanced_origin_weights(labels)
        origin_weights = pd.Series(weights).groupby(labels.origin).sum()
        self.assertAlmostEqual(weights.sum(), len(origins))
        self.assertAlmostEqual(origin_weights.iloc[0] / origin_weights.iloc[-1], 3.0)
        self.assertLess(audit["effective_origins"], len(origins))
        self.assertFalse(audit["uniform_fallback"])
        sparse = labels.loc[labels.origin.ne(origins[0])]
        uniform, fallback = balanced_origin_weights(sparse)
        np.testing.assert_allclose(uniform, 0.2)
        self.assertTrue(fallback["uniform_fallback"])
        with self.assertRaisesRegex(ValueError, "all five tenors"):
            balanced_origin_weights(labels.iloc[1:])


class MarketReleaseEvidenceTests(unittest.TestCase):
    def test_balanced_study_never_selects_the_original_ridge_control(self):
        from model.issuance_market_validation import save_market_development
        from model.issuance_study_protocol import MARKET_BALANCED_CANDIDATES

        results = {}
        actual = np.repeat([5.0, -5.0], 30)
        for candidate, error in zip(
            MARKET_BALANCED_CANDIDATES, [5, 5, 0, 0.3, 0.4], strict=True
        ):
            results[candidate.name] = pd.DataFrame(
                {
                    "origin": pd.date_range("2024-01-01", periods=60),
                    "lead_days": 30,
                    "coupon_bp": 200.0,
                    "predicted_bp": 200.0 + error,
                    "market_actual_change_bp": actual,
                    "market_predicted_change_bp": actual
                    if candidate.market_change != "zero"
                    else 0.0,
                }
            )
        with tempfile.TemporaryDirectory() as directory:
            selection = save_market_development(
                results, {}, Path(directory), "test", MARKET_BALANCED_CANDIDATES
            )
        self.assertTrue(selection["ranking"][2]["gates"]["passed"])
        self.assertEqual(selection["selected"]["market_change"], "balanced")

    def test_realized_reference_is_only_a_label_and_missing_origin_fails_closed(self):
        panel = market_panel()
        requests = panel.requests((7, 30)).iloc[-4:].copy()
        before = panel.features(requests, include_industry_tenor=True)
        requests["pricing_reference_bp"] = 99999
        requests["pricing_reference_covered"] = False
        pd.testing.assert_frame_equal(
            before, panel.features(requests, include_industry_tenor=True)
        )
        layer = fit_market_change(panel, "2025-01-01", "centered")
        before.loc[0, "industry_aaa_available"] = 0
        with self.assertRaisesRegex(ValueError, "same dated industry reference"):
            market_change(layer, before)

    def test_missing_month_rejected_even_when_surviving_receipts_are_valid(self):
        from dataclasses import asdict
        from model.issuance_market_validation import (
            evaluation_manifest,
            verified_market_stage,
        )
        from model.issuance_study_protocol import digest

        candidate = CouponCandidate(
            "lgb", "pricing_excess", 5, 5, "combined", "front30", "ridge"
        )
        rows = pd.DataFrame(
            {
                "bond_code": ["a.SH", "b.SH"],
                "origin": ["2024-01-10", "2024-02-10"],
                "lead_days": [30, 30],
                "coupon_bp": [180.0, 181.0],
                "predicted_bp": [180.0, 180.0],
                "label_available_date": ["2024-02-10", "2024-03-12"],
                "placement_type": ["公募", "公募"],
                "training_cutoff": ["2024-01-01", "2024-02-01"],
                "training_label_end": ["2023-12-20", "2024-01-20"],
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            months = directory / candidate.name / "months"
            months.mkdir(parents=True)
            write_json(
                directory / "protocol.json",
                {
                    "identity_sha256": "frozen",
                    "evaluation_manifest": evaluation_manifest(rows),
                },
            )
            for month, frame in rows.groupby(rows.origin.str.slice(0, 7)):
                path = months / f"{month}.csv"
                frame.to_csv(path, index=False)
                diagnostic = path.with_suffix(".diagnostics.json")
                write_json(diagnostic, {})
                timing = path.with_suffix(".timing.csv")
                timing.write_text("status\ncovered\n")
                write_json(
                    path.with_suffix(".receipt.json"),
                    {
                        "identity_sha256": "frozen",
                        "candidate": asdict(candidate),
                        "predictions_sha256": digest(path),
                        "diagnostics_sha256": digest(diagnostic),
                        "timing_sha256": digest(timing),
                    },
                )
            self.assertEqual(
                len(
                    verified_market_stage(
                        directory, (candidate,), "frozen", "2024-01-01", "2025-01-01"
                    )[candidate.name]
                ),
                2,
            )
            (months / "2024-02.csv").unlink()
            with self.assertRaisesRegex(
                ValueError, "incomplete market evaluation denominator"
            ):
                verified_market_stage(
                    directory, (candidate,), "frozen", "2024-01-01", "2025-01-01"
                )


class MarketProtocolAndCalendarTests(unittest.TestCase):
    def test_registry_versions_reject_mixed_candidates(self):
        from dataclasses import asdict
        from model.issuance_study_protocol import (
            MARKET_CANDIDATES,
            MARKET_TREE_CANDIDATES,
            MARKET_BALANCED_CANDIDATES,
            MARKET_TENOR_CANDIDATES,
            load_spec,
        )

        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "spec.json"
            for version, candidates in (
                (6, MARKET_CANDIDATES),
                (7, MARKET_TREE_CANDIDATES),
                (8, MARKET_BALANCED_CANDIDATES),
                (9, MARKET_TENOR_CANDIDATES),
            ):
                spec = {
                    "schema_version": version,
                    "stage": "development",
                    "as_of": "2026-10-03",
                    "development_start": "2023-01-01",
                    "development_end": "2025-09-01",
                    "candidates": [asdict(c) for c in candidates],
                    "issuance_scope": "public_only",
                    "release_policy": "validated_market_separation",
                    "input_sha256": "0" * 64,
                    "nodes_sha256": "1" * 64,
                    "nodes_path": "nodes.csv",
                }
                write_json(path, spec)
                self.assertEqual(load_spec(path)[0]["schema_version"], version)
                spec["candidates"] = [
                    asdict(c)
                    for c in (
                        MARKET_TREE_CANDIDATES if version == 6 else MARKET_CANDIDATES
                    )
                ]
                write_json(path, spec)
                with self.assertRaisesRegex(ValueError, "exactly the versioned"):
                    load_spec(path)

    def test_holiday_zero_clock_matches_js_without_shifting_later_horizons(self):
        from data.issuance_training import known_market_change_zero
        from data.issuance_calendar import CALENDAR_2026

        dates = pd.DatetimeIndex(["2026-09-29", "2026-09-30"])
        flags = known_market_change_zero(
            dates, np.array([1, 1]), pd.DatetimeIndex(["2026-10-08", "2026-10-09"])
        )
        np.testing.assert_array_equal(flags, [1.0, 0.0])
        runtime = Path(__file__).resolve().parents[1] / "online/coupon-features.mjs"
        code = f"import {{couponFeature}} from {json.dumps(runtime.as_uri())};const c={{features:[{{date:'2026-09-30',rate_gov_1y_level:1,rate_gov_3y_level:1.2,rate_gov_10y_level:1.6}}],events:[],secondary:new Map(),industryNodes:new Map(),calendarSpec:{json.dumps(CALENDAR_2026)}}};console.log(JSON.stringify([5,6].map(lead_days=>couponFeature(c,{{origin:'2026-10-03',lead_days,tenor:3,issuer:'测试',rating:'AAA',bond_type:'证券公司债',placement_type:'公募',issue_size:30}}).market_known_zero)));"
        actual = json.loads(
            subprocess.check_output(
                ["node", "--input-type=module", "-e", code], text=True
            )
        )
        self.assertEqual(actual, [1, 0])
