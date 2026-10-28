import json
from dataclasses import asdict
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

from data.coupon_quotes import QUOTE_COLUMNS
from model.coupon_update_study import (
    RAW,
    _updated_predictions,
    summarize_updates,
    validate_control_identity,
    frame_sha,
)
from model.issuance_evaluation import _fingerprint
from model.issuance_unified import CouponModel
from model.issuance_diagnostics import training_diagnostics
from model.short_coupon import CONTROL, short_candidates, SELECTION
from research_sources import runtime_identity


def fixture():
    rng = np.random.default_rng(42)
    dates = [
        pd.Timestamp("2023-01-05"),
        *pd.date_range("2025-02-01", periods=45),
        pd.Timestamp("2026-01-10"),
        pd.Timestamp("2026-01-20"),
        pd.Timestamp("2026-01-21"),
        pd.Timestamp("2026-01-21"),
    ]
    n = len(dates)
    price = rng.normal(200, 15, n)
    features = pd.DataFrame(
        {column: price + rng.normal(0, 1, n) for column in QUOTE_COLUMNS}
    )
    features = features.assign(
        tenor=3.0,
        issue_size=20.0,
        known_treasury_bp=180.0,
        lead_days=1,
        issuer="A",
        rating="AAA",
        bond_type="证券公司债",
        placement_type="公募",
        peer_premium_mean_bp=0.0,
    )
    requests = features[
        [
            "issuer",
            "rating",
            "bond_type",
            "placement_type",
            "tenor",
            "issue_size",
            "lead_days",
        ]
    ].copy()
    requests["bond_code"] = [str(i) for i in range(n)]
    requests["pricing_date"] = dates
    requests["label_available_date"] = dates
    requests["origin"] = requests.pricing_date - pd.Timedelta(days=1)
    requests["coupon_bp"] = price + 5
    requests["pricing_reference_bp"] = price
    requests["pricing_reference_covered"] = True
    requests.loc[n - 4, "coupon_bp"] = 300
    eligible = pd.Series(False, index=requests.index)
    eligible.iloc[-2:] = True
    panel = SimpleNamespace(audit={"issuance_scope": "public_only"})
    return panel, features, requests, eligible


class CouponUpdateTests(unittest.TestCase):
    def test_control_identity_binds_unscored_training_rows_and_huber_inputs(self):
        panel, f, r, _ = fixture()
        panel.events = r.copy()
        panel.secondary = f[["issuer_quote_lag_0_bp"]].copy()
        panel.industry_nodes = f[["sector_quote_lag_0_bp"]].copy()
        panel.rates = SimpleNamespace(market_features=f[["known_treasury_bp"]].copy())
        date = "2026-01-22"
        identity = {
            "as_of": date,
            "events_sha256": frame_sha(r),
            "features_sha256": frame_sha(f),
            "runtime": runtime_identity(),
            "candidates": [asdict(c) for c in short_candidates()],
            "controls": [asdict(CONTROL)],
            "horizons": [1, 14, 30],
            "development_start": "2023-01-01",
            "development_end": "2026-01-01",
            "historical_end": date,
            "selection": SELECTION,
            "control_training_leads": "original 0..90 daily expansion; score 1/14/30 only",
            "panel": _fingerprint(
                panel, (*short_candidates(), CONTROL), pd.Timestamp(date)
            ),
        }
        validate_control_identity(identity, panel, date, r, f)
        for frame, column in (
            (r, "coupon_bp"),
            (f, "issuer_quote_lag_0_bp"),
            (panel.secondary, "issuer_quote_lag_0_bp"),
            (panel.industry_nodes, "sector_quote_lag_0_bp"),
            (panel.rates.market_features, "known_treasury_bp"),
        ):
            old = frame.loc[0, column]
            frame.loc[0, column] = old + 1
            try:
                with self.subTest(column=column), self.assertRaises(ValueError):
                    validate_control_identity(identity, panel, date, r, f)
            finally:
                frame.loc[0, column] = old
        with self.assertRaisesRegex(ValueError, "as_of"):
            validate_control_identity(identity, panel, "2026-01-23", r, f)
        product = {
            **identity,
            "representation": "product_quote",
            "candidates": [asdict(c) for c in short_candidates("product_quote")],
            "selection": {
                **SELECTION,
                "eligibility": "product_quote candidate only; static/raw-history/Huber are controls",
            },
            "panel": _fingerprint(
                panel,
                (*short_candidates("product_quote"), CONTROL),
                pd.Timestamp(date),
            ),
        }
        validate_control_identity(product, panel, date, r, f)
        product["selection"] = SELECTION
        with self.assertRaisesRegex(ValueError, "selection"):
            validate_control_identity(product, panel, date, r, f)

    def test_window_retains_old_edge_and_adds_only_earlier_mature_labels(self):
        _, _, r, _ = fixture()
        model = CouponModel(RAW)
        cutoff = pd.Timestamp("2026-01-20")
        monthly = model.training_mask(r, "2026-01-01")
        updated = model.training_mask(r, cutoff, window_start="2023-01-01")
        self.assertTrue(updated.iloc[0])
        self.assertFalse(model.training_mask(r, cutoff).iloc[0])
        self.assertEqual(int((updated & ~monthly).sum()), 1)
        self.assertFalse(updated.iloc[-3:].any())
        self.assertTrue((r.loc[updated].label_available_date < cutoff).all())

    def test_fit_and_diagnostics_use_the_same_training_window(self):
        _, f, r, _ = fixture()
        model = CouponModel(RAW).fit(f, r, "2026-01-20", window_start="2023-01-01")
        diagnostic = training_diagnostics(
            model, f, r, "2026-01-20", window_start="2023-01-01"
        )
        self.assertEqual(model.audit["training_window_start"], "2023-01-01")
        self.assertEqual(model.audit["training_label_end"], "2026-01-10")
        self.assertEqual(model.audit["events"], 47)
        self.assertEqual(diagnostic["metrics"][0]["samples"], 47)

    def test_unchanged_cohort_equals_monthly_and_future_targets_are_isolated(self):
        _, f, r, _ = fixture()
        r.loc[r.label_available_date.eq("2026-01-10"), "label_available_date"] = (
            pd.Timestamp("2026-01-20")
        )
        monthly = CouponModel(RAW).fit(f, r, "2026-01-01")
        self.assertNotIn("training_window_start", monthly.audit)
        updated = CouponModel(RAW).fit(f, r, "2026-01-20", window_start="2023-01-01")
        np.testing.assert_allclose(
            updated.predict(f), monthly.predict(f), atol=1e-12, rtol=0
        )
        r.loc[r.label_available_date.ge("2026-01-20"), "coupon_bp"] = 9999
        changed = CouponModel(RAW).fit(f, r, "2026-01-20", window_start="2023-01-01")
        np.testing.assert_allclose(
            changed.predict(f), updated.predict(f), atol=1e-12, rtol=0
        )

    def test_same_origin_uses_one_fit_and_resume_rejects_tampering(self):
        panel, f, r, eligible = fixture()
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / "origin"
            r.loc[eligible].to_csv(Path(tmp) / "expected-events.csv", index=False)
            fit = CouponModel.fit
            with patch.object(
                CouponModel, "fit", autospec=True, side_effect=fit
            ) as spy:
                first = _updated_predictions(panel, f, r, eligible, directory, "token")
                self.assertEqual(spy.call_count, 1)
            with patch.object(
                CouponModel, "fit", side_effect=AssertionError("must resume")
            ):
                second = _updated_predictions(panel, f, r, eligible, directory, "token")
                np.testing.assert_allclose(first.predicted_bp, second.predicted_bp)
            for suffix in (".csv", ".state.json", ".diagnostics.json", ".window.json"):
                path = (directory / "2026-01-20.csv").with_suffix(suffix)
                old = path.read_bytes()
                path.write_bytes(
                    old + b" "
                    if suffix == ".csv"
                    else old.replace(b"2026", b"2027", 1)
                    if b"2026" in old
                    else old + b" "
                )
                if suffix == ".window.json":
                    value = json.loads(old)
                    value["frequency"] = "monthly"
                    path.write_text(json.dumps(value))
                try:
                    with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                        _updated_predictions(panel, f, r, eligible, directory, "token")
                finally:
                    path.write_bytes(old)
            window = directory / "2026-01-20.window.json"
            window.unlink()
            with (
                patch.object(
                    CouponModel, "fit", side_effect=AssertionError("must reject resume")
                ),
                self.assertRaisesRegex(ValueError, "window receipt"),
            ):
                _updated_predictions(panel, f, r, eligible, directory, "token")
            self.assertFalse(window.exists())

    def test_failed_fit_preserves_expected_requests_and_fails(self):
        panel, f, r, eligible = fixture()
        f, r = f.iloc[-3:].reset_index(drop=True), r.iloc[-3:].reset_index(drop=True)
        eligible = pd.Series([False, True, True])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            r.loc[eligible].to_csv(root / "expected-events.csv", index=False)
            before = (root / "expected-events.csv").read_bytes()
            with self.assertRaisesRegex(ValueError, "40 mature"):
                _updated_predictions(panel, f, r, eligible, root / "origin", "token")
            self.assertEqual((root / "expected-events.csv").read_bytes(), before)
            self.assertEqual(
                json.loads((root / "failure.json").read_text())["requested_rows"], 2
            )

    def test_full_horizon_gates_and_missing_denominator_cannot_be_hidden(self):
        expected = pd.DataFrame(
            [
                dict(
                    bond_code=f"{year}-{h}",
                    origin=f"{year}-01-02",
                    lead_days=h,
                    coupon_bp=200.0,
                    valuation_bp=204.0,
                    label_available_date=f"{year}-02-01",
                )
                for year in (2024, 2026)
                for h in (1, 14, 30)
            ]
        )
        controls = {
            c.name: expected.assign(predicted_bp=202.0 if c == RAW else 203.0)
            for c in (*short_candidates(), CONTROL)
        }
        candidate = expected.assign(predicted_bp=201.0)
        result = summarize_updates(candidate, expected, controls)
        self.assertEqual(result["status"], "passed_historical_conditions")
        self.assertIsNone(result["candidate"])
        candidate.loc[candidate.lead_days.eq(30), "predicted_bp"] = 203.0
        self.assertEqual(
            summarize_updates(candidate, expected, controls)["status"],
            "no_update_increment",
        )
        with self.assertRaisesRegex(ValueError, "denominator"):
            summarize_updates(candidate.iloc[:-1], expected, controls)
        missing = expected.lead_days.ne(30)
        with self.assertRaisesRegex(ValueError, "three complete horizons"):
            summarize_updates(
                candidate.loc[missing],
                expected.loc[missing],
                {name: rows.loc[missing] for name, rows in controls.items()},
            )


if __name__ == "__main__":
    unittest.main()
