import unittest

import pandas as pd

from issue_report import build_score_today_report, driver_structure, market_drivers


class IssueReportTest(unittest.TestCase):
    def test_driver_direction_uses_original_cost_wording(self):
        rows = market_drivers(
            {
                "top_drivers": [
                    {"feature": "peer_spread_median", "shap": 1.0, "value": 40.0},
                    {
                        "feature": "credit_spread_pctile_60d",
                        "shap": -1.0,
                        "value": 0.2,
                    },
                ]
            },
            fe=None,
        )

        self.assertEqual(rows[0]["impact"], "推高成本")
        self.assertEqual(rows[1]["impact"], "降低成本")

    def test_driver_structure_groups_shap_and_inverts_to_issuance_support(self):
        class FeatureGroups:
            feature_group_columns_ = {
                "funding": ["credit_spread"],
                "equity": ["csi300_ret_5d"],
            }

        rows = driver_structure(
            {
                "top_drivers": [
                    {"feature": "credit_spread", "shap": 2.0, "value": 1.0},
                    {"feature": "csi300_ret_5d", "shap": -1.0, "value": 0.1},
                ]
            },
            FeatureGroups(),
        )

        self.assertEqual(
            [row["display_name"] for row in rows],
            [
                "宏观基本面",
                "资金面",
                "权益市场",
                "供给压力",
                "二级市场",
                "日历效应",
            ],
        )
        funding = next(row for row in rows if row["category"] == "funding")
        equity = next(row for row in rows if row["category"] == "equity")
        self.assertEqual(funding["support_bp"], -2.0)
        self.assertEqual(equity["support_bp"], 1.0)
        self.assertLess(funding["support_score"], 50)
        self.assertGreater(equity["support_score"], 50)
        self.assertAlmostEqual(sum(row["importance_weight"] for row in rows), 1.0)

    def test_report_preserves_original_summary_and_requested_company_wording(self):
        # Company metrics below are deliberately synthetic test values.
        forecast = pd.DataFrame(
            {
                "date": ["2024-01-10"],
                "weekday": ["周三"],
                "percentile": [50.0],
                "label": ["尚可"],
                "savings_bp_vs_window_median": [0.0],
                "savings_万元/年": [0.0],
            }
        )
        report = build_score_today_report(
            result={
                "market_data_date": "2024-01-09",
                "peer_spread_median": 38.89,
                "pred_bp": 0.23,
                "percentile": 63.0,
                "recommend": "wait",
                "decision": "不推荐发行",
                "tenor": 3.0,
                "rating": "AAA",
                "bond_type": "证券公司债",
                "issue_size": 30.0,
            },
            readiness={
                "date": "2024-01-09",
                "ef_lcr_pctile_60d": 0.75,
                "ef_nsfr_pctile_60d": 0.85,
                "ef_funding_gap": -120.0,
                "ef_subject_spread_bp": 18.0,
                "ef_subject_spread_pctile": 0.25,
                "ef_subject_spread_date": "2024-01-09",
                "readiness_label": "宽裕",
            },
            market_driver_rows=[],
            validation_summary={},
            forecast_df=forecast,
        )

        self.assertIn(
            "模型预测当日发行利差偏离可比债中位数 +0.23 bp，处于历史 P63",
            report,
        )
        self.assertNotIn("对应预计发行利差", report)
        self.assertNotIn("资金缺口", report)
        self.assertNotIn("资金缺口(1M)", report)
        self.assertIn(
            "近一年历史分位 P25，主体信用定价处于低位，对发行较友好",
            report,
        )
        self.assertNotIn("（主体信用定价处于低位，对发行较友好）", report)


if __name__ == "__main__":
    unittest.main()
