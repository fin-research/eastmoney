import json
from pathlib import Path
import subprocess
import unittest

import numpy as np
import pandas as pd

from data.issuance_curve_dynamics import curve_features, DYNAMICS, CURVE_COLUMNS
from data.feature_engineering import rate_dynamics_from_frame


class CurveDynamicsTests(unittest.TestCase):
    def test_missing_curve_group_fails_instead_of_imputing_a_disabled_builder(self):
        from test_coupon_market_change import market_panel
        from model.issuance_unified import CouponCandidate, CouponModel

        panel = market_panel()
        rows = panel.requests((7, 30))
        features = panel.features(
            rows, include_industry_tenor=True, include_weighted_primary=True
        )
        model = CouponModel(
            CouponCandidate(
                "lgb", "pricing_excess", 5, 5, "combined", "front30", "tenor"
            )
        )
        with self.assertRaisesRegex(ValueError, "curve feature columns missing"):
            model.fit(features, rows, "2025-10-01", market_panel=panel)

    def test_original_feature_path_does_not_build_or_expose_curve_dynamics(self):
        from unittest.mock import patch
        from test_coupon_market_change import market_panel

        panel = market_panel()
        requests = panel.requests((7, 30))
        with patch(
            "data.issuance_curve_dynamics.curve_features",
            side_effect=AssertionError("legacy must not build curve dynamics"),
        ):
            features = panel.features(requests, include_industry_tenor=True)
        self.assertTrue(set(CURVE_COLUMNS).isdisjoint(features))

    def test_tenor_market_fit_ignores_future_nodes_and_states(self):
        from test_coupon_market_change import market_panel
        from model.issuance_market_change import fit_market_change, MARKET_STATES

        panel = market_panel()
        original = fit_market_change(panel, "2025-01-01", "tenor_shape")
        panel.industry_nodes.loc[
            panel.industry_nodes.observation_date.ge("2025-01-01"), "yield_pct"
        ] = 999
        panel.rates.market_features.loc["2025-01-01":, list(MARKET_STATES)] = -999
        self.assertEqual(
            original, fit_market_change(panel, "2025-01-01", "tenor_shape")
        )

    def setUp(self):
        self.dates = pd.bdate_range("2024-01-01", periods=100)
        self.nodes = pd.DataFrame(
            [
                {
                    "observation_date": day,
                    "tenor_years": t,
                    "yield_pct": 2 + t * 0.05 + i * 0.001 + t * np.sin(i / 9) * 0.002,
                }
                for i, day in enumerate(self.dates)
                for t in (1, 3, 5, 7, 10)
            ]
        )
        self.requests = pd.DataFrame(
            {"origin": [self.dates[80]] * 4, "tenor": [1.0, 3.0, 4.0, 10.0]}
        )

    def test_three_year_equivalence_and_nonparallel_information(self):
        output = curve_features(self.requests, self.dates, self.nodes)
        raw = self.nodes.pivot(
            index="observation_date", columns="tenor_years", values="yield_pct"
        )
        raw = raw.rename(columns={1: "GOV_1Y", 3: "AAA_3Y", 10: "GOV_10Y"})
        raw["GOV_3Y"] = raw.AAA_3Y - 0.3
        original = rate_dynamics_from_frame(raw).iloc[79]
        for name in DYNAMICS:
            self.assertAlmostEqual(
                output.loc[1, f"sector_tenor_{name}"],
                original[f"rate_aaa_3y_{name}"],
                places=10,
            )
        self.assertNotAlmostEqual(
            output.loc[0, "sector_tenor_change_5"],
            output.loc[3, "sector_tenor_change_5"],
        )
        y = (
            self.nodes.loc[self.nodes.observation_date.eq(self.dates[79])]
            .set_index("tenor_years")
            .yield_pct
            * 100
        )
        self.assertAlmostEqual(
            output.loc[1, "sector_curvature_3"], y[3] - (7 * y[1] + 2 * y[10]) / 9
        )

    def test_future_nodes_and_nonquote_dates_never_change_features(self):
        before = curve_features(self.requests, self.dates, self.nodes)
        altered = self.nodes.copy()
        altered.loc[altered.observation_date.ge(self.dates[80]), "yield_pct"] = 999
        weekend = pd.DataFrame(
            [
                {
                    "observation_date": pd.Timestamp("2024-04-20"),
                    "tenor_years": 3.0,
                    "yield_pct": 888.0,
                }
            ]
        )
        pd.testing.assert_frame_equal(
            before,
            curve_features(self.requests, self.dates, pd.concat([altered, weekend])),
        )
        pd.testing.assert_frame_equal(
            before,
            curve_features(
                self.requests,
                self.dates,
                self.nodes.loc[self.nodes.observation_date.lt(self.dates[80])],
            ),
        )

    def test_missing_window_retains_rows_without_carrying_or_extrapolation(self):
        nodes = self.nodes.loc[
            ~(
                self.nodes.observation_date.eq(self.dates[75])
                & self.nodes.tenor_years.eq(3)
            )
        ]
        output = curve_features(self.requests, self.dates, nodes)
        self.assertEqual(len(output), 4)
        self.assertTrue(np.isnan(output.loc[1, "sector_tenor_deviation_20"]))
        self.assertTrue(np.isfinite(output.loc[0, "sector_tenor_deviation_20"]))
        outside = self.requests.assign(tenor=11)
        self.assertTrue(
            curve_features(outside, self.dates, nodes)
            .sector_tenor_change_5.isna()
            .all()
        )

    def test_python_js_curve_features_match_with_gaps(self):
        nodes = self.nodes.loc[
            ~(
                self.nodes.observation_date.eq(self.dates[75])
                & self.nodes.tenor_years.eq(3)
            )
        ]
        expected = curve_features(self.requests, self.dates, nodes)
        runtime = (
            Path(__file__).resolve().parents[1] / "online/curve-dynamics.mjs"
        ).as_uri()
        records = [
            {
                "date": str(r.observation_date.date()),
                "tenor": r.tenor_years,
                "yield": r.yield_pct,
            }
            for r in nodes.itertuples()
        ]
        payload = {
            "dates": [str(d.date()) for d in self.dates],
            "nodes": records,
            "date": str(self.dates[79].date()),
            "tenors": self.requests.tenor.tolist(),
        }
        code = f"import {{curveDynamics,curveFeature}} from {json.dumps(runtime)};const f=JSON.parse(process.argv[1]);const nodes=new Map();for(const r of f.nodes){{const a=nodes.get(r.date)??[];a.push(r);nodes.set(r.date,a);}}const states=curveDynamics(f.dates.map(date=>({{date}})),nodes);console.log(JSON.stringify(f.tenors.map(t=>curveFeature(states.get(f.date),t))));"
        actual = pd.DataFrame(
            json.loads(
                subprocess.check_output(
                    ["node", "--input-type=module", "-e", code, json.dumps(payload)],
                    text=True,
                )
            )
        )
        np.testing.assert_allclose(
            actual[list(CURVE_COLUMNS)].to_numpy(dtype=float),
            expected[list(CURVE_COLUMNS)],
            atol=1e-10,
            equal_nan=True,
        )

    def test_new_curve_columns_cannot_enter_control_or_premium_tree(self):
        from test_coupon_market_change import market_panel
        from model.issuance_unified import CouponCandidate, CouponModel

        panel = market_panel()
        rows = panel.requests((7, 30))
        features = panel.features(
            rows,
            include_weighted_primary=True,
            include_industry_tenor=True,
            include_curve_dynamics=True,
        )
        for mode in ("ridge", "tenor", "tenor_shape"):
            model = CouponModel(
                CouponCandidate(
                    "lgb", "pricing_excess", 5, 5, "combined", "front30", mode
                )
            ).fit(features, rows, "2025-10-01", market_panel=panel)
            if mode == "ridge":
                self.assertTrue(set(CURVE_COLUMNS).isdisjoint(model.numeric))
            else:
                split = model.estimator.booster_.feature_importance("split")
                self.assertTrue(
                    all(split[model.feature_names.index(c)] == 0 for c in CURVE_COLUMNS)
                )
