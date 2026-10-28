import unittest
from unittest.mock import patch

from neon_upload import upload_financing_model_snapshot


class NeonUploadTest(unittest.TestCase):
    def test_retired_upload_never_opens_a_database(self):
        with patch("psycopg.connect") as connect:
            for url in (None, "postgresql://localhost/test"):
                with self.subTest(url=url):
                    with self.assertRaisesRegex(RuntimeError, "本地模型上传已退役"):
                        upload_financing_model_snapshot(financing_snapshot(), url)
            connect.assert_not_called()


def financing_snapshot():
    # Company metrics below are deliberately synthetic test values.
    return {
        "run_id": "78c6fba5-e7b0-4d0f-bc18-2c8968b8e447",
        "schema_version": 2,
        "model_name": "bond_financing_timing_lgbm",
        "generated_at": "2026-08-24T00:00:00+00:00",
        "as_of_date": "2026-08-24",
        "market_data_date": "2026-08-21",
        "issue_terms": {
            "issue_size_billion_yuan": 30.0,
            "tenor_years": 3.0,
            "rating": "AAA",
            "bond_type": "证券公司债",
        },
        "prediction": {
            "deviation_bp": 1.71,
            "peer_spread_median_bp": 41.18,
            "historical_percentile": 51.0,
            "recommendation": "neutral",
            "recommendation_label": "尚可",
            "window_zone": "中枢",
            "decision": "推荐发行",
        },
        "company_metrics": {
            "date": "2026-08-21",
            "ef_lcr": 1.25,
            "ef_nsfr": 1.15,
            "ef_lcr_pctile_60d": 0.25,
            "ef_nsfr_pctile_60d": 0.75,
            "ef_funding_gap": -100.0,
            "ef_margin_zscore_60d": 0.1,
            "ef_funding_pressure": 0.5,
            "ef_subject_spread_bp": 20.0,
            "ef_subject_spread_pctile": 0.5,
            "ef_subject_spread_date": "2026-08-21",
            "composite_score": 0.5,
            "readiness_label": "适中",
            "interpretation": "合成测试样例",
        },
        "market_drivers": [
            {
                "feature": "weighted_cost",
                "display_name": "一级加权成本",
                "shap": -0.3,
                "value": 1.491,
                "direction": "下降",
                "impact": "降低成本",
            }
        ],
        "driver_structure": [
            {
                "category": "funding",
                "display_name": "资金面",
                "support_score": 60.0,
                "support_bp": 0.3,
                "importance_weight": 1.0,
            }
        ],
        "product_recommendation": {
            "recommended_product": "3Y 公募债",
            "recommended_tenor_years": 3.0,
            "recommended_bond_type": "证券公司债",
            "scenarios": [
                {
                    "display_name": "3Y 公募债",
                    "tenor_years": 3.0,
                    "bond_type": "证券公司债",
                    "pred_bp": 1.71,
                    "peer_spread_median_bp": 41.18,
                    "historical_percentile": 51.0,
                    "recommendation": "neutral",
                    "recommendation_label": "择机发行",
                    "rank": 1,
                    "cost_vs_best_bp": 0.0,
                    "is_recommended": True,
                }
            ],
        },
        "forecast_window": [
            {
                "date": "2026-08-24",
                "weekday": "周一",
                "percentile": 51.0,
                "label": "尚可",
                "pred_bp": 1.71,
                "savings_bp_vs_window_median": -1.12,
                "savings_万元/年": -33.6,
            }
        ],
        "validation": {
            "tscv": {
                "folds": 10,
                "validation_samples": 100,
                "sample_count": 2023,
                "sample_start_date": "2022-01-01",
                "sample_end_date": "2026-06-30",
                "rmse": 8.4,
                "mae": 6.2,
                "ic": 0.22,
                "best_iter_median": 80,
                "best_iters": [80],
            },
            "timing_value": {
                "n_total": 100,
                "n_recommended": 25,
                "recommended_share": 0.25,
                "cost_saving_bp": 2.1,
                "recommended_mean_bp": -1.0,
                "baseline_mean_bp": 1.1,
                "win_rate": 0.6,
                "ic": 0.22,
                "group_means": [-1.0, 0.0, 1.0, 2.0],
                "monotonic": True,
            },
        },
        "base_conclusion": {
            "verdict": "推荐发行",
            "preferred_window": "8月24日",
            "narrative": "基础结论",
            "preferred_dates": ["2026-08-24"],
        },
        "source_freshness": {
            "market_data_date": "2026-08-21",
            "company_metrics_date": "2026-08-21",
            "subject_spread_date": "2026-08-21",
        },
    }


if __name__ == "__main__":
    unittest.main()
