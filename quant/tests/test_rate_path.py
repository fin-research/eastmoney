"""A quote path retains native gaps and remains strictly before a decision."""

from pathlib import Path
import unittest

import numpy as np
import pandas as pd

from data.rate_data import build_rate_dataset
from data.rate_path import rate_path_features
from tests.test_rate_research import source_frame


class RatePathTest(unittest.TestCase):
    def test_missing_quote_does_not_get_filled_or_advance_the_clock(self):
        dates = pd.bdate_range("2025-01-01", periods=25)
        raw = pd.DataFrame({"GOV_3Y": np.arange(25) * 0.01 + 2}, index=dates)
        raw.loc[dates[5], "GOV_3Y"] = np.nan
        path = rate_path_features(raw, dates)
        self.assertTrue(np.isnan(path.loc[dates[6], "path_gov_3y_lag_1_bp"]))
        self.assertAlmostEqual(path.loc[dates[7], "path_gov_3y_lag_1_bp"], -1)
        self.assertTrue(path.filter(like="cdb_3y").isna().all().all())

    def test_same_day_and_future_quotes_cannot_change_opening_paths(self):
        raw = source_frame()
        cutoff = pd.Timestamp("2022-01-03")
        before = build_rate_dataset(
            Path("synthetic"), funding_frame=raw, extra_groups=("rate_path",)
        )
        altered = raw.copy()
        altered.loc[cutoff:] += 3
        after = build_rate_dataset(
            Path("synthetic"), funding_frame=altered, extra_groups=("rate_path",)
        )
        pd.testing.assert_frame_equal(
            before.features.loc[:cutoff], after.features.loc[:cutoff]
        )
        self.assertLess(before.source_dates.loc[cutoff], cutoff)
        default = build_rate_dataset(Path("synthetic"), funding_frame=raw)
        self.assertFalse(any(name.startswith("path_") for name in default.features))


if __name__ == "__main__":
    unittest.main()
