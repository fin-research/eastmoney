import unittest

from model.features import CALENDAR_FEATURES, split_feature_names


class SplitFeatureNamesTest(unittest.TestCase):
    def test_preserves_input_order_in_each_group(self):
        features = [
            "credit_spread",
            "month",
            "dr007",
            "days_to_month_end",
            "peer_count",
        ]

        market, calendar = split_feature_names(features)

        self.assertEqual(market, ["credit_spread", "dr007", "peer_count"])
        self.assertEqual(calendar, ["month", "days_to_month_end"])

    def test_calendar_feature_contract_matches_existing_model(self):
        self.assertEqual(
            CALENDAR_FEATURES,
            {
                "day_of_week",
                "month",
                "is_month_end",
                "is_quarter_end",
                "is_year_end",
                "days_to_month_end",
                "days_to_quarter_end",
            },
        )


if __name__ == "__main__":
    unittest.main()
