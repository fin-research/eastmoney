import unittest
from unittest.mock import patch

import pandas as pd

from issue_timing import (
    _IssueTerms,
    _build_product_recommendation,
    _finalize_window_df,
    _issue_label,
    _recommendation_for_percentile,
)


class FinalizeWindowTest(unittest.TestCase):
    def test_default_issue_type_is_securities_company_bond(self):
        self.assertEqual(_IssueTerms().bond_type, "证券公司债")

    def test_uses_predicted_deviation_for_rank_and_savings(self):
        frame = pd.DataFrame(
            {
                "pred_bp": [-2.0, 1.0, 4.0],
                "expected_spread_bp": [100.0, 50.0, 10.0],
            }
        )

        result = _finalize_window_df(frame, issue_size=30.0)

        self.assertEqual(
            result["savings_bp_vs_window_median"].tolist(), [-3.0, 0.0, 3.0]
        )
        self.assertEqual(result["savings_万元/年"].tolist(), [-90.0, 0.0, 90.0])

    def test_issue_labels_match_dashboard_decision_language(self):
        self.assertEqual(_issue_label("strong_buy"), "建议发行")
        self.assertEqual(_issue_label("neutral"), "建议等待")
        self.assertEqual(_issue_label("wait"), "暂缓发行")

    def test_recommendation_tercile_boundaries(self):
        for percentile, expected in [
            (0, "strong_buy"), (100 / 3, "strong_buy"),
            (33.34, "neutral"), (52, "neutral"),
            (200 / 3, "neutral"), (66.67, "wait"), (100, "wait"),
        ]:
            with self.subTest(percentile=percentile):
                self.assertEqual(_recommendation_for_percentile(percentile), expected)

    @patch("issue_timing._score_issue")
    def test_product_recommendation_scores_all_four_standard_combinations(self, score):
        predictions = {
            (3.0, "证券公司债"): 1.2,
            (5.0, "证券公司债"): 2.4,
            (3.0, "证券公司次级债"): -0.8,
            (5.0, "证券公司次级债"): 0.5,
        }
        peer_medians = {
            (3.0, "证券公司债"): 20.0,
            (5.0, "证券公司债"): 30.0,
            (3.0, "证券公司次级债"): 100.0,
            (5.0, "证券公司次级债"): 110.0,
        }

        def score_terms(*args, terms, **kwargs):
            prediction = predictions[(terms.tenor, terms.bond_type)]
            return {
                "pred_bp": prediction,
                "peer_spread_median": peer_medians[(terms.tenor, terms.bond_type)],
                "percentile": 25.0,
                "recommend": "strong_buy",
                "label": "建议发行",
            }

        score.side_effect = score_terms
        result = _build_product_recommendation(
            issue_model={},
            dataset=pd.DataFrame(),
            feature_engineer=object(),
            target_date=pd.Timestamp("2026-08-31"),
            market_features=pd.Series(dtype=float),
            market_data_date=pd.Timestamp("2026-08-28"),
        )

        self.assertEqual(score.call_count, 4)
        # 即使次级债自身中位数显著更高，也只按相对各自同类债中位数的偏离排序。
        self.assertEqual(result["recommended_product"], "3Y 次级债")
        self.assertEqual(
            [(row["display_name"], row["rank"]) for row in result["scenarios"]],
            [("3Y 公募债", 3), ("5Y 公募债", 4), ("3Y 次级债", 1), ("5Y 次级债", 2)],
        )


if __name__ == "__main__":
    unittest.main()
