import unittest
from pathlib import Path

import pandas as pd

from data.feature_engineering import FeatureBuildContext, build_feature_bundle
from data.macro_releases import macro_release_features


class MacroReleaseFeaturesTest(unittest.TestCase):
    def test_exact_month_change_release_calendar_and_late_revision(self):
        rows = pd.DataFrame(
            [
                ["PMI", "2025-01-01", "2025-02-02", 48.0],
                ["PMI", "2025-02-01", "2025-03-01", 49.0],
                ["PMI", "2025-03-01", "2025-04-01", 51.0],
                ["PMI", "2025-04-01", "2025-05-01", 52.0],
                ["PMI", "2025-02-01", "2025-05-05", 50.0],
            ],
            columns=["field", "observation_date", "published_date", "value"],
        )
        dates = pd.to_datetime(
            ["2025-02-01", "2025-02-03", "2025-04-30", "2025-05-04", "2025-05-06"]
        )
        result = build_feature_bundle(
            ("macro_releases",),
            FeatureBuildContext(
                data_path=Path("unused"),
                date_index=dates,
                source_frames={"macro_releases": rows},
            ),
        ).combined
        self.assertTrue(pd.isna(result.iloc[0].macro_PMI_level))
        self.assertEqual(result.iloc[1].macro_PMI_level, 48.0)
        self.assertEqual(result.iloc[1].macro_PMI_release_age_days, 1)
        self.assertEqual(result.iloc[2].macro_PMI_level, 51.0)
        self.assertEqual(result.iloc[3].macro_PMI_change_1m, 1.0)
        self.assertEqual(result.iloc[3].macro_PMI_change_3m, 4.0)
        self.assertEqual(result.iloc[4].macro_PMI_level, 52.0)
        self.assertEqual(result.iloc[4].macro_PMI_release_age_days, 5)
        earlier = macro_release_features(rows.iloc[:4], dates[:4])
        pd.testing.assert_frame_equal(
            result.iloc[:4].reset_index(drop=True), earlier.reset_index(drop=True)
        )

    def test_missing_month_is_not_a_zero_or_previous_release_change(self):
        rows = pd.DataFrame(
            [
                ["M2", "2025-01-01", "2025-02-15", 7.0],
                ["M2", "2025-03-01", "2025-04-15", 8.0],
            ],
            columns=["field", "observation_date", "published_date", "value"],
        )
        result = macro_release_features(rows, pd.date_range("2025-04-15", periods=2))
        self.assertTrue(result.macro_M2_change_1m.isna().all())
        self.assertTrue(result.macro_M2_change_3m.isna().all())
        self.assertEqual(result.macro_M2_level.tolist(), [8.0, 8.0])
        rows.loc[0, "published_date"] = None
        with self.assertRaisesRegex(ValueError, "publication"):
            macro_release_features(rows, result.index)
