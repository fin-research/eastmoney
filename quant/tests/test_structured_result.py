import json
import tempfile
import unittest
from pathlib import Path

from structured_result import (
    build_financing_model_snapshot,
    write_financing_model_snapshot,
)


class StructuredResultTest(unittest.TestCase):
    def assessment(self):
        # Company metrics below are deliberately synthetic test values.
        return {
            "as_of_date": "2026-08-24",
            "market_data_date": "2026-08-21",
            "issue_size": 30.0,
            "tenor": 3.0,
            "rating": "AAA",
            "bond_type": "证券公司债",
            "pred_bp": 1.71,
            "peer_spread_median": 41.18,
            "percentile": 51.0,
            "recommend": "neutral",
            "label": "尚可",
            "window_zone": "中枢",
            "decision": "推荐发行",
            "company_metrics": {
                "date": "2026-08-21",
                "ef_lcr_pctile_60d": 0.25,
                "ef_nsfr_pctile_60d": 0.75,
                "ef_funding_gap": float("nan"),
                "readiness_label": "适中",
            },
            "market_drivers": [
                {
                    "feature": "weighted_cost",
                    "display_name": "一级加权成本",
                    "value": 1.491,
                    "shap": -0.3,
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
                "scenarios": [],
            },
            "forecast_window": [
                {"date": "2026-08-25", "pred_bp": 1.0},
                {"date": "2026-08-26", "pred_bp": -1.0},
                {"date": "2026-08-27", "pred_bp": 0.5},
                {"date": "2026-08-28", "pred_bp": 2.0},
            ],
            "validation_summary": {
                "tscv": {"rmse": 8.0, "ic": 0.22},
                "timing_value": {"cost_saving_bp": 2.1, "win_rate": 0.6},
            },
        }

    def test_builds_json_safe_snapshot_and_preferred_dates(self):
        snapshot = build_financing_model_snapshot(self.assessment())

        self.assertEqual(snapshot["schema_version"], 3)
        self.assertEqual(
            snapshot["product_recommendation"]["recommended_product"], "3Y 公募债"
        )
        self.assertEqual(snapshot["company_metrics"]["ef_funding_gap"], None)
        self.assertEqual(
            snapshot["base_conclusion"]["preferred_dates"],
            ["2026-08-25", "2026-08-26", "2026-08-27"],
        )
        json.dumps(snapshot, allow_nan=False)

    def test_writes_utf8_json(self):
        snapshot = build_financing_model_snapshot(self.assessment())
        with tempfile.TemporaryDirectory() as directory:
            path = write_financing_model_snapshot(
                snapshot, Path(directory) / "snapshot.json"
            )
            stored = json.loads(path.read_text(encoding="utf-8"))

        self.assertEqual(stored["prediction"]["decision"], "推荐发行")


if __name__ == "__main__":
    unittest.main()
