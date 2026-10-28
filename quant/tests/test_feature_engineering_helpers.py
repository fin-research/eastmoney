import unittest
from unittest.mock import patch
from pathlib import Path

import numpy as np
import pandas as pd

from data import (
    BOND_MARKET_FEATURE_GROUPS,
    FEATURE_GROUP_REGISTRY,
    MARGIN_BASE_SOURCE_GROUPS,
    MARGIN_MARKET_FEATURE_GROUPS,
    FeatureBuildContext,
    build_feature_bundle,
)
from data.feature_engineering import (
    build_macro_features,
    primary_features_from_frame,
    build_secondary_bond_features,
)
from data.data import (
    _add_cross_asset_features,
    _add_issue_market_interactions,
    _last_value_empirical_percentile,
    _merge_market_features_asof,
)


class FeatureEngineeringHelpersTest(unittest.TestCase):
    @patch("data.feature_engineering.pd.read_excel")
    def test_secondary_undefined_ratio_and_missing_component_are_not_signals(
        self, read_excel
    ):
        read_excel.return_value = pd.DataFrame(
            {
                "VOL": [100.0, 100.0, 100.0],
                "RATE_VOL": [90.0, 90.0, 90.0],
                "FIN_VOL": [0.0, np.nan, 4.0],
                "CORP_VOL": [0.0, 6.0, 6.0],
            },
            index=pd.date_range("2025-01-01", periods=3),
        )
        result = build_secondary_bond_features("unused.xlsx")
        self.assertTrue(pd.isna(result.iloc[0].rate_credit_volume_ratio))
        self.assertEqual(result.iloc[0].credit_bond_volume_ratio, 0.0)
        self.assertTrue(pd.isna(result.iloc[1].credit_bond_volume_ratio))
        self.assertEqual(result.iloc[2].rate_credit_volume_ratio, 9.0)

    def test_primary_no_issue_day_keeps_repayments_and_calendar_windows(self):
        dates = pd.date_range("2026-01-01", periods=21)
        frame = pd.DataFrame(
            {
                "issue_size": 0.0,
                "issue_count": 0.0,
                "weighted_cost": np.nan,
                "net_financing": 0.0,
                "maturity_amount": 0.0,
                "redemption_amount": 0.0,
            },
            index=dates,
        )
        frame.loc[dates[0], ["issue_size", "issue_count", "weighted_cost"]] = [10, 1, 2]
        frame.loc[dates[5], ["maturity_amount", "net_financing"]] = [7, -7]
        result = primary_features_from_frame(frame)
        self.assertEqual(result.loc[dates[4], "supply_5d"], 10)
        self.assertEqual(result.loc[dates[5], "supply_5d"], 0)
        self.assertEqual(result.loc[dates[-1], "maturity_wall_20d"], 7)
        self.assertEqual(result.loc[dates[-1], "net_financing_20d"], -7)
        self.assertTrue(pd.isna(result.loc[dates[5], "weighted_cost"]))
        # Unknown reporting day is not an observed zero, even if no coupon exists.
        missing = primary_features_from_frame(frame.drop(index=dates[5]))
        self.assertTrue(pd.isna(missing.loc[dates[-1], "maturity_wall_20d"]))
        self.assertTrue(pd.isna(missing.loc[dates[-1], "net_financing_20d"]))

    @patch("data.feature_engineering.pd.read_excel")
    def test_macro_placeholders_do_not_become_model_observations(self, read_excel):
        read_excel.return_value = pd.DataFrame(
            {
                "中国:GDP:不变价:当季同比": [0.0, 5.0, 0.0, 6.0],
                "中国:PMI": [0.0, 49.0, 0.0, 51.0],
                "中国:社会融资规模存量:同比": [0.0, 7.4, 0.0, 8.0],
                "中国:M2:同比": [0.0, 7.7, 0.0, 8.5],
                "中国:CPI:同比": [0.0, 0.2, 0.0, 1.0],
                "中国:PPI": [0.0, -1.0, 0.0, -0.5],
            },
            index=pd.to_datetime(
                ["2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31"]
            ),
        )
        index = pd.to_datetime(["2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01"])
        result = build_macro_features("unused.xlsx", index)
        # No backfill from future observations, and no fabricated leading zero.
        for column in ["GDP", "PMI", "SOCIAL_FINANCE", "M2", "pmi_above_50"]:
            self.assertTrue(pd.isna(result.loc["2026-05-01", column]))
        self.assertTrue(
            result.loc["2026-04-01"]
            .drop("PMI_staleness")
            .drop("M2_staleness")
            .isna()
            .all()
        )
        # May 31 is a Sunday: its observation must survive the trading-day join.
        self.assertEqual(result.loc["2026-06-01", "SOCIAL_FINANCE"], 7.4)
        self.assertEqual(result.loc["2026-07-01", "SOCIAL_FINANCE"], 7.4)
        self.assertEqual(result.loc["2026-07-01", "M2"], 7.7)
        self.assertEqual(result.loc["2026-07-01", "PMI"], 49.0)
        self.assertEqual(result.loc["2026-07-01", "CPI"], 0.0)
        self.assertEqual(result.loc["2026-07-01", "PPI"], 0.0)
        # A short forecast range still receives the last earlier valid month.
        short = build_macro_features(
            "unused.xlsx", pd.bdate_range("2026-07-01", periods=2)
        )
        self.assertEqual(short["SOCIAL_FINANCE"].tolist(), [7.4, 7.4])

    def test_registered_feature_groups_have_explicit_reuse_scopes(self):
        self.assertEqual(
            set(BOND_MARKET_FEATURE_GROUPS),
            {
                "funding",
                "equity",
                "secondary_bond",
                "primary_bond",
                "macro",
                "calendar",
            },
        )
        self.assertEqual(
            set(MARGIN_MARKET_FEATURE_GROUPS),
            {"funding", "equity", "margin_equity", "macro", "calendar"},
        )
        self.assertEqual(
            MARGIN_BASE_SOURCE_GROUPS,
            ("funding", "equity", "calendar"),
        )
        margin_scopes = {
            FEATURE_GROUP_REGISTRY[name].scope for name in MARGIN_MARKET_FEATURE_GROUPS
        }
        self.assertEqual(margin_scopes, {"market", "calendar"})
        self.assertNotIn("secondary_bond", MARGIN_MARKET_FEATURE_GROUPS)
        self.assertNotIn("primary_bond", MARGIN_MARKET_FEATURE_GROUPS)
        self.assertNotIn("proprietary", MARGIN_MARKET_FEATURE_GROUPS)

    def test_feature_bundle_validates_names_and_builds_calendar_contract(self):
        index = pd.bdate_range("2026-01-01", periods=5)
        context = FeatureBuildContext(
            data_path=Path("unused.xlsx"),
            date_index=index,
        )

        bundle = build_feature_bundle(("calendar",), context)

        self.assertEqual(tuple(bundle.frames), ("calendar",))
        self.assertEqual(bundle["calendar"].index.tolist(), index.tolist())
        self.assertEqual(bundle.combined.index.name, "feature_date")
        self.assertEqual(bundle.feature_names, tuple(bundle.combined.columns))
        with self.assertRaisesRegex(ValueError, "未知特征组"):
            build_feature_bundle(("unknown",), context)
        with self.assertRaisesRegex(ValueError, "不得重复"):
            build_feature_bundle(("calendar", "calendar"), context)

    def test_market_features_align_to_latest_t_minus_one_row(self):
        bonds = pd.DataFrame(
            {
                "issue_date": pd.to_datetime(["2024-01-03"]),
                "issuer": ["发行人"],
            }
        )
        market = pd.DataFrame(
            {"value": [1.0, 2.0]},
            index=pd.to_datetime(["2024-01-01", "2024-01-02"]),
        )
        market.index.name = "feature_date"

        result = _merge_market_features_asof(bonds, market)

        self.assertEqual(result.loc[0, "value"], 2.0)
        self.assertEqual(result.loc[0, "feature_date"], pd.Timestamp("2024-01-02"))

    def test_issue_interactions_and_frequency_use_prior_30_days(self):
        result = pd.DataFrame(
            {
                "issuer": ["A", "A", "A"],
                "issue_date": pd.to_datetime(
                    ["2024-01-01", "2024-01-20", "2024-03-01"]
                ),
                "tenor_feat": [3.0, 3.0, 3.0],
                "credit_spread": [2.0, 3.0, 4.0],
                "dr007_pctile_60d": [0.4, 0.5, 0.6],
            }
        )

        names = _add_issue_market_interactions(result)

        self.assertEqual(
            names,
            [
                "tenor_x_credit_spread",
                "tenor_x_dr007_pctile",
                "issuer_frequency_30d",
            ],
        )
        self.assertEqual(result["issuer_frequency_30d"].tolist(), [0.0, 1.0, 0.0])
        self.assertEqual(result["tenor_x_credit_spread"].tolist(), [6.0, 9.0, 12.0])

    def test_cross_asset_features_preserve_missing_contribution_rules(self):
        frame = pd.DataFrame(
            {
                "dr007_pctile_60d": [0.75, np.nan],
                "credit_spread_pctile_60d": [0.60, 0.40],
                "supply_20d_zscore": [1.0, 2.0],
            }
        )

        result = _add_cross_asset_features(frame)

        self.assertAlmostEqual(result.loc[0, "funding_credit_stress"], 0.35)
        self.assertAlmostEqual(result.loc[0, "supply_funding_pressure"], 0.75)
        self.assertAlmostEqual(result.loc[1, "supply_funding_pressure"], 1.0)

    def test_empirical_percentile_uses_rank_not_min_max_position(self):
        values = pd.Series([1.0, 4.0, 2.0, 3.0])

        result = _last_value_empirical_percentile(values)

        self.assertEqual(result, 0.75)


if __name__ == "__main__":
    unittest.main()
