"""Backcast values retain their dates without entering pre-launch requests."""

import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import numpy as np
import pandas as pd

from artifacts import write_json
from data.coupon_quotes import coupon_quote_features
from data.industry_source import FIRST_PUBLICATION, PROFILE
from data.issuance_curve_dynamics import curve_features
from data.issuance_industry_tenor import industry_tenor_features, prepare_industry_nodes
from data.online_inputs import SOURCES, build_issuance_market


def case():
    dates = pd.bdate_range("2020-09-01", "2021-02-01")
    funding = [
        {"field": field, "observation_date": str(day.date()), "value": 2 + j / 10}
        for day in dates
        for j, field in enumerate(SOURCES["funding"])
    ]
    nodes = [
        {
            "curve_code": PROFILE["curveCode"],
            "observation_date": str(day.date()),
            "tenor_years": tenor,
            "yield_pct": 2 + tenor / 10 + i / 1000,
        }
        for i, day in enumerate(dates)
        for tenor in (1, 3, 5, 7, 10)
    ]
    inputs = {
        "industry_source_profile": PROFILE,
        "as_of_date": "2021-02-02",
        "datasets": {
            "funding": funding,
            "industry_nodes": nodes,
            "industry_curve": [
                {
                    "observation_date": row["observation_date"],
                    "yield_pct": row["yield_pct"],
                }
                for row in nodes
                if row["tenor_years"] == 3
            ],
        },
    }
    requests = pd.DataFrame(
        [
            {
                "origin": pd.Timestamp(origin),
                "tenor": tenor,
                "issuer": "A",
                "rating": "AAA",
                "bond_type": "证券公司债",
                "placement_type": "公募",
                "issue_size": 30.0,
                "lead_days": 1,
            }
            for origin in ("2020-12-24", "2020-12-28", "2020-12-29", "2021-01-04")
            for tenor in (3.0, 4.0)
        ]
    )
    return inputs, requests


def features(inputs, requests):
    rates = build_issuance_market(inputs)
    nodes = prepare_industry_nodes(inputs["datasets"]["industry_nodes"])
    dates = rates.market_features.index
    positions = dates.searchsorted(requests.origin, side="left") - 1
    result = pd.concat(
        [
            coupon_quote_features(requests, dates, nodes, None),
            industry_tenor_features(
                requests,
                dates[positions],
                250.0 + (requests.tenor.to_numpy() - 3) * 10 / 7,
                nodes,
            ),
            curve_features(requests, dates, nodes),
        ],
        axis=1,
    )
    return rates, result


class IndustrySourceTests(unittest.TestCase):
    def test_missing_or_different_profile_is_not_silently_adopted(self):
        inputs, _ = case()
        for profile in (None, {**PROFILE, "firstPublicationDate": "2019-01-01"}):
            with self.subTest(profile=profile):
                altered = {**inputs, "industry_source_profile": profile}
                with self.assertRaisesRegex(ValueError, "source profile"):
                    build_issuance_market(altered)
                script = """import fs from 'node:fs';
import {issuanceFeatures} from './online/issuance-features.mjs';
const x=JSON.parse(fs.readFileSync(process.argv[1]));
try {issuanceFeatures(x);process.exit(2);} catch(error){if(!error.message.includes('source profile'))throw error;}"""
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "case.json"
                    write_json(path, altered)
                    subprocess.run(
                        ["node", "--input-type=module", "-e", script, str(path)],
                        check=True,
                        cwd=Path(__file__).resolve().parents[1],
                        capture_output=True,
                        text=True,
                    )

    def test_event_basis_uses_actual_pricing_date_across_launch_quote_gap(self):
        inputs, _ = case()
        inputs["datasets"]["funding"] = [
            r
            for r in inputs["datasets"]["funding"]
            if r["observation_date"] not in ("2020-12-25", "2020-12-28")
        ]
        inputs["datasets"]["issue"] = []
        inputs["datasets"]["bond_issuance"] = [
            {
                "bond_code": f"{i}.SH",
                "issuer_name": "A",
                "interest_rate_type": "固息",
                "bond_type": "证券公司债",
                "placement_type": "公募",
                "original_tenor_years": 3,
                "tender_date": day,
                "issue_date": "2020-12-30",
                "final_coupon_pct": 3.0,
            }
            for i, day in enumerate(("2020-12-28", "2020-12-29"))
        ]
        script = """import fs from 'node:fs';
import {couponContext} from './online/coupon-features.mjs';
const x=JSON.parse(fs.readFileSync(process.argv[1]));
console.log(JSON.stringify(couponContext(x).events));"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "case.json"
            write_json(path, inputs)
            events = json.loads(
                subprocess.check_output(
                    ["node", "--input-type=module", "-e", script, str(path)],
                    text=True,
                    cwd=Path(__file__).resolve().parents[1],
                )
            )
        self.assertEqual([e["pricing_quote_date"] for e in events], ["2020-12-24"] * 2)
        requests = pd.DataFrame(
            {"origin": pd.to_datetime(["2020-12-28", "2020-12-29"]), "tenor": 3}
        )
        nodes = prepare_industry_nodes(inputs["datasets"]["industry_nodes"])
        reference = industry_tenor_features(
            requests, pd.to_datetime(["2020-12-24"] * 2), [250, 250], nodes
        )
        self.assertIsNone(events[0]["industry_basis_bp"])
        self.assertAlmostEqual(
            events[1]["industry_basis_bp"],
            300 - reference.industry_aaa_tenor_bp.iloc[1],
        )

    def test_backcast_perturbation_preserves_prelaunch_features_and_clock(self):
        inputs, requests = case()
        rates, before = features(inputs, requests)
        altered = copy.deepcopy(inputs)
        for name in ("industry_nodes", "industry_curve"):
            for row in altered["datasets"][name]:
                if row["observation_date"] < PROFILE["firstPublicationDate"]:
                    row["yield_pct"] += 1.0
        changed_rates, after = features(altered, requests)
        prelaunch = requests.origin.le(FIRST_PUBLICATION)
        pd.testing.assert_frame_equal(before.loc[prelaunch], after.loc[prelaunch])
        pd.testing.assert_frame_equal(
            rates.market_features, changed_rates.market_features
        )
        self.assertTrue(before.loc[prelaunch, "industry_aaa_available"].eq(0).all())
        self.assertTrue(
            before.loc[prelaunch]
            .drop(columns="industry_aaa_available")
            .isna()
            .all()
            .all()
        )
        # The first post-launch request can read the backcast lag in its original
        # government-clock slot; no compression to twenty observed curve values.
        row = 4
        dates = rates.market_features.index
        lag_day = dates[dates.searchsorted(requests.origin.iloc[row], side="left") - 20]
        observed = next(
            r["yield_pct"]
            for r in inputs["datasets"]["industry_nodes"]
            if r["observation_date"] == str(lag_day.date()) and r["tenor_years"] == 3
        )
        self.assertAlmostEqual(before.sector_quote_lag_19_bp.iloc[row], observed * 100)
        self.assertAlmostEqual(
            after.sector_quote_lag_19_bp.iloc[row]
            - before.sector_quote_lag_19_bp.iloc[row],
            100,
        )
        self.assertFalse(PROFILE["historicalVintageVerified"])

    def test_python_js_share_launch_boundary_backcast_lags_and_3y_features(self):
        inputs, requests = case()
        rates, expected = features(inputs, requests)
        script = """import fs from 'node:fs';
import {issuanceFeatures} from './online/issuance-features.mjs';
import {couponFeature} from './online/coupon-features.mjs';
import {curveDynamics} from './online/curve-dynamics.mjs';
const x=JSON.parse(fs.readFileSync(process.argv[1])),market=issuanceFeatures(x.inputs),nodes=new Map();
for(const r of x.inputs.datasets.industry_nodes){const group=nodes.get(r.observation_date)??[];group.push({tenor:r.tenor_years,yield:r.yield_pct});nodes.set(r.observation_date,group);}
const context={...market,events:[],secondary:new Map(),industryNodes:nodes,includeQuoteHistory:true,includeCurveDynamics:true,curveDynamics:curveDynamics(market.features,nodes)};
console.log(JSON.stringify({market:market.features,requests:x.requests.map(r=>couponFeature(context,r))}));"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "case.json"
            write_json(
                path, {"inputs": inputs, "requests": requests.to_dict(orient="records")}
            )
            result = json.loads(
                subprocess.check_output(
                    ["node", "--input-type=module", "-e", script, str(path)],
                    cwd=Path(__file__).resolve().parents[1],
                    text=True,
                )
            )
        actual = (
            pd.DataFrame(result["requests"])
            .reindex(columns=expected.columns)
            .astype(float)
        )
        np.testing.assert_allclose(actual, expected, equal_nan=True, rtol=0, atol=1e-10)
        market = pd.DataFrame(result["market"]).set_index("date")
        for name in ("rate_aaa_3y_level", "rate_aaa_3y_change_20", "credit_spread"):
            np.testing.assert_allclose(
                market[name].astype(float),
                rates.market_features[name],
                equal_nan=True,
                rtol=0,
                atol=1e-10,
            )
