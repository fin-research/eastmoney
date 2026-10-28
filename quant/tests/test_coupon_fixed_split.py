"""Completeness and label isolation in the fixed pre-2026 coupon protocol."""

from dataclasses import replace
import unittest

import numpy as np
import pandas as pd

from data.issuance_event_ledger import issuance_event_ledger
from model.issuance_unified import CouponCandidate, CouponModel
from model.short_coupon import fixed_folds
from tests.test_unified_coupon import sample_panel


class FixedCouponSplitTests(unittest.TestCase):
    def test_option_unknown_true_false_have_identical_eligibility(self):
        base = dict(
            short_name="new",
            issuer_name="A",
            bond_type="证券公司债",
            placement_type="公募",
            interest_rate_type="固息",
            original_tenor_years=3,
            tender_date="2025-05-20",
            issue_date="2025-05-22",
            final_coupon_pct=2.5,
        )
        rows = [
            {**base, "bond_code": f"{i}.SZ", "has_option": value}
            for i, value in enumerate((True, False, None))
        ]
        ledger = issuance_event_ledger(
            {"as_of_date": "2026-01-01", "datasets": {"bond_issuance": rows}}
        )
        self.assertTrue(ledger.training_eligible.all())

    def test_expanding_mask_retains_old_history_and_purges_immature_labels(self):
        panel = sample_panel()
        requests = panel.requests((1, 14, 30))
        model = CouponModel(CouponCandidate("ridge", "coupon", 0))
        mask = model.training_mask(requests, "2026-01-01")
        self.assertIn(
            requests.pricing_date.min(), requests.loc[mask].pricing_date.tolist()
        )
        self.assertTrue(requests.loc[mask].label_available_date.lt("2026-01-01").all())
        for fold in fixed_folds(requests, "2026-09-22"):
            train = set(requests.loc[fold["train"]].bond_code)
            validation = set(requests.loc[fold["selected"]].bond_code)
            self.assertFalse(train & validation)
            self.assertTrue(
                requests.loc[fold["train"]]
                .label_available_date.lt(fold["cutoff"])
                .all()
            )

    def test_2026_label_changes_do_not_change_features_parameters_or_predictions(self):
        panel = sample_panel()
        future = panel.events.tail(5).copy()
        future["bond_code"] = "future-" + future.bond_code
        future["pricing_date"] = pd.Timestamp("2026-02-01") + pd.to_timedelta(
            np.arange(5), unit="D"
        )
        future["label_available_date"] = future.pricing_date + pd.Timedelta(days=1)
        panel.events = (
            pd.concat([panel.events, future], ignore_index=True)
            .sort_values("label_available_date")
            .reset_index(drop=True)
        )
        requests = panel.requests((1, 14, 30))
        changed = panel.events.copy()
        changed.loc[
            changed.label_available_date.ge("2026-01-01"),
            ["coupon_bp", "history_premium_bp"],
        ] = 12345.0
        altered = replace(panel, events=changed)
        market = panel.rates.market_features.copy()
        market["weighted_cost"] = 2.0
        market["weighted_cost_chg_5d"] = 0.0
        panel.rates = type(panel.rates)(market_features=market)
        altered.rates = type(panel.rates)(market_features=market.copy())
        other_requests = altered.requests((1, 14, 30))
        for c in (
            CouponCandidate("ridge", "coupon", 0),
            CouponCandidate("lgb", "coupon", 0, 5, "weighted_primary"),
        ):
            features = [
                p.with_label_cutoff("2026-01-01").features(
                    r, include_weighted_primary=c.uses_weighted_primary
                )
                for p, r in ((panel, requests), (altered, other_requests))
            ]
            pd.testing.assert_frame_equal(*features)
            self.assertIn("weighted_cost", features[0])
            models = [
                CouponModel(c).fit(f, r, "2026-01-01")
                for f, r in zip(features, (requests, other_requests), strict=True)
            ]
            self.assertEqual(models[0].export(), models[1].export())
            np.testing.assert_array_equal(
                models[0].predict(features[0]), models[1].predict(features[1])
            )

    def test_fixed_evaluation_resumes_complete_folds_without_refit(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from data.issuance_industry_tenor import prepare_industry_nodes, AAA_CURVE_CODE
        from model.short_coupon import evaluate_short_coupons, load_short_release

        panel = sample_panel()
        panel.audit["issuance_scope"] = "public_only"
        future = panel.events.tail(4).copy()
        future["bond_code"] = "2026-" + future.bond_code
        future["pricing_date"] = pd.Timestamp("2026-06-01")
        future["label_available_date"] = pd.Timestamp("2026-06-02")
        panel.events = pd.concat([panel.events, future], ignore_index=True)
        panel.industry_nodes = prepare_industry_nodes(
            [
                dict(
                    curve_code=AAA_CURVE_CODE,
                    observation_date=day.date().isoformat(),
                    tenor_years=term,
                    yield_pct=2.3 + term * 0.1,
                )
                for day in panel.rates.market_features.index
                for term in (1.0, 3.0, 5.0)
            ]
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            actual_fit = CouponModel.fit
            with patch(
                "model.issuance_evaluation.CouponModel.fit",
                autospec=True,
                wraps=actual_fit,
            ) as fit:
                # Execute real fitting with a counted wrapper.
                fit.side_effect = actual_fit
                result = evaluate_short_coupons(panel, "2026-09-22", root)
                self.assertEqual(
                    sum(
                        call.args[3] == pd.Timestamp("2026-01-01")
                        for call in fit.call_args_list
                    ),
                    3,
                )
            self.assertTrue(
                any(
                    f["status"] != "ready" and f["requested"] > 0
                    for f in result["folds"]
                )
            )
            with patch.object(
                CouponModel,
                "fit",
                side_effect=AssertionError("must reuse frozen evidence"),
            ):
                self.assertEqual(
                    evaluate_short_coupons(panel, "2026-09-22", root), result
                )
            if result["candidate"] is None:
                with self.assertRaisesRegex(ValueError, "qualified evidence"):
                    load_short_release(root / "release-evaluation.json")
            else:
                self.assertEqual(
                    load_short_release(root / "release-evaluation.json"), result
                )

    def test_coupon_clock_retains_government_dates_with_missing_industry(self):
        from pathlib import Path
        from data.rate_data import build_rate_dataset
        from tests.test_rate_research import source_frame

        frame = source_frame()
        frame.loc[frame.index[:200], "AAA_3Y"] = np.nan
        frame.loc[frame.index[400], "AAA_3Y"] = np.nan
        credit = build_rate_dataset(Path("synthetic"), funding_frame=frame)
        coupon = build_rate_dataset(
            Path("synthetic"), funding_frame=frame, require_credit_quote=False
        )
        self.assertEqual(coupon.market_features.index[0], frame.index[0])
        self.assertEqual(len(coupon.market_features), len(frame))
        self.assertEqual(credit.market_features.index[0], frame.index[200])
        self.assertTrue(
            pd.isna(coupon.market_features.loc[frame.index[400], "rate_aaa_3y_level"])
        )
        self.assertTrue(
            pd.isna(
                coupon.market_features.loc[frame.index[401], "rate_aaa_3y_change_1"]
            )
        )

    def test_all_history_huber_keeps_early_events_without_industry_nodes(self):
        panel = sample_panel()
        requests = panel.requests((1, 14, 30))
        features = panel.features(
            requests, include_industry_tenor=True, include_weighted_primary=True
        )
        candidate = CouponCandidate(
            "lgb", "industry_excess", 0, 5, "combined", "front30"
        )
        model = CouponModel(candidate).fit(features, requests, "2026-01-01")
        self.assertEqual(model.audit["events"], panel.events.bond_code.nunique())
        self.assertTrue(np.isfinite(model.predict(features)).all())
