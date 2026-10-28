import tempfile
import unittest
from pathlib import Path

import pandas as pd

from data.online_macro import real_gdp_on_dates


class RealGdpTests(unittest.TestCase):
    def test_gdp_is_unavailable_before_release_and_old_period_does_not_regress(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "gdp_real_yoy.csv").write_text(
                "observation_date,published_date,value\n"
                "2025-12-31,2026-01-19,5.0\n"
                "2026-03-31,2026-04-16,4.8\n"
                "2025-12-31,2026-04-20,5.1\n"
            )
            dates = pd.to_datetime(
                ["2026-01-18", "2026-01-19", "2026-04-15", "2026-04-20"]
            )
            result = real_gdp_on_dates(path / "data.xlsx", dates)
            self.assertTrue(pd.isna(result.iloc[0]))
            self.assertEqual(result.iloc[1:].tolist(), [5.0, 5.0, 4.8])
