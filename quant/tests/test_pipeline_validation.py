import unittest

import pandas as pd

from pipeline import _model_sample_metadata


class ModelSampleMetadataTest(unittest.TestCase):
    def test_uses_complete_effective_training_history(self):
        dataset = pd.DataFrame(
            {
                "issue_date": pd.to_datetime(
                    ["2019-01-03", "2026-01-15", "2026-08-28", "2026-08-29"]
                ),
                "y_regression": [1.0, 2.0, 3.0, None],
            }
        )

        self.assertEqual(
            _model_sample_metadata(dataset),
            {
                "sample_count": 3,
                "sample_start_date": "2019-01-03",
                "sample_end_date": "2026-08-28",
            },
        )


if __name__ == "__main__":
    unittest.main()
