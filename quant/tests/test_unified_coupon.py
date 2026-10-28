import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import numpy as np
import pandas as pd

from data.issuance_training import IssuancePanel
from model.export import write_json
from model.issuance_evaluation import coupon_metrics, frozen_sigmas
from model.issuance_output import low_rate_dates
from model.issuance_unified import CouponCandidate, CouponModel, coupon_candidates


def sample_panel():
    dates = pd.date_range("2022-01-01", "2026-09-22", freq="B")
    frame = pd.DataFrame(
        {"rate_gov_1y_level": 2.0, "rate_gov_3y_level": 2.3, "rate_gov_10y_level": 2.7},
        index=dates,
    )
    events = pd.DataFrame(
        [
            {
                "bond_code": f"{i}.SH",
                "issuer": f"issuer{i % 4}",
                "rating": "AAA" if i % 2 else "AA+",
                "bond_type": "证券公司债" if i % 3 else "证券公司次级债",
                "placement_type": "公募" if i % 2 else "私募",
                "tenor": float(1 + i % 5),
                "issue_size": 20.0,
                "pricing_date": pd.Timestamp("2023-01-01") + pd.Timedelta(days=i * 10),
                "label_available_date": pd.Timestamp("2023-01-02")
                + pd.Timedelta(days=i * 10),
                "coupon_bp": 260.0 + i % 13,
                "history_premium_bp": 30.0 + i % 13,
            }
            for i in range(110)
        ]
    )
    return IssuancePanel(SimpleNamespace(market_features=frame), events, {})


class UnifiedCouponTests(unittest.TestCase):
    def test_real_events_and_future_invariance(self):
        panel = sample_panel()
        requests = panel.requests((0, 7, 30))
        original = panel.features(requests)
        old = requests.origin < "2024-01-01"
        panel.events = panel.events.loc[
            panel.events.label_available_date < "2024-01-01"
        ]
        pd.testing.assert_frame_equal(
            original.loc[old].reset_index(drop=True), panel.features(requests.loc[old])
        )
        self.assertTrue(requests.groupby("bond_code").coupon_bp.nunique().eq(1).all())

    def test_lower_quartile_includes_ties_and_keeps_calendar_adjacency(self):
        rows = [
            {"date": day, "coupon_percent": value}
            for day, value in zip(
                ("2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23"),
                (2.0, 2.0, 3.0, 4.0),
                strict=True,
            )
        ]
        actual = low_rate_dates(rows)
        self.assertEqual(actual["dates"], ["2026-09-18", "2026-09-21"])
        self.assertEqual(
            actual["windows"], [{"start": "2026-09-18", "end": "2026-09-21"}]
        )
        self.assertEqual(actual["action"], "尽快发行")
        self.assertEqual(low_rate_dates([])["action"], "暂无预测")

    def test_hit_rate_is_symmetric_fixed_accuracy_without_sigma(self):
        rows = pd.DataFrame(
            {"coupon_bp": [100.0, 100.0, 100.0], "predicted_bp": [150.0, 96.0, 90.0]}
        )
        metrics = coupon_metrics(rows, 5.0)
        self.assertIsNone(metrics["win_rate"])
        self.assertEqual(metrics["hit_rate_5bp"], 1 / 3)
        self.assertEqual(coupon_metrics(rows, 1000)["hit_rate_5bp"], 1 / 3)
        self.assertAlmostEqual(metrics["mae_bp"], 64 / 3)
        self.assertEqual(frozen_sigmas(rows.assign(lead_days=30)), {30: None})

    def test_global_models_unseen_categories_purge_and_runtime_parity(self):
        panel = sample_panel()
        requests = panel.requests((0, 7, 30))
        features = panel.features(requests)
        root = Path(__file__).resolve().parents[1]
        for kind in ("ridge", "lgb"):
            with self.subTest(kind=kind):
                model = CouponModel(CouponCandidate(kind, "excess", 3)).fit(
                    features, requests, "2025-09-01"
                )
                self.assertLess(model.audit["training_label_end"], "2025-09-01")
                sample = features.iloc[-4:].copy()
                sample.loc[sample.index[-1], "issuer"] = "unseen issuer"
                predicted = model.predict(sample)
                contributions = model.contributions(sample)
                np.testing.assert_allclose(
                    contributions.sum(axis=1), predicted, atol=1e-8
                )
                with tempfile.TemporaryDirectory() as tmp:
                    path = Path(tmp) / "case.json"
                    write_json(
                        path,
                        {
                            "model": model.export(),
                            "vectors": model.encode(sample).to_numpy().tolist(),
                            "anchors": sample.known_treasury_bp.to_numpy().tolist(),
                        },
                    )
                    script = """import fs from 'node:fs';
import {couponPrediction,couponExplanation} from './online/coupon-model.mjs';
const x=JSON.parse(fs.readFileSync(process.argv[1]));
console.log(JSON.stringify(x.vectors.map((v,i)=>({prediction:couponPrediction(x.model,v,x.anchors[i]),shap:couponExplanation(x.model,v,x.anchors[i])}))));"""
                    values = json.loads(
                        subprocess.check_output(
                            ["node", "--input-type=module", "-e", script, str(path)],
                            cwd=root,
                            text=True,
                        )
                    )
                np.testing.assert_allclose(
                    [r["prediction"] for r in values], predicted, atol=1e-8
                )
                np.testing.assert_allclose(
                    [r["shap"]["values"] + [r["shap"]["expected"]] for r in values],
                    contributions,
                    atol=1e-8,
                )

    def test_fixed_search_budget(self):
        self.assertEqual(len(coupon_candidates()), 24)
        self.assertEqual(len({c.name for c in coupon_candidates()}), 24)

    def test_monthly_restart_keeps_arguments_and_snapshot(self):
        from model import research_resources as resources

        with (
            patch.object(resources, "_completed_fits", 0),
            patch.dict(
                "os.environ",
                {
                    "QUANT_CHECKPOINT_RESTART": "1",
                    "QUANT_FROZEN_INPUT_PATH": "/frozen/inputs.json",
                },
            ),
            patch.object(resources.os, "execve") as replace_process,
        ):
            for _ in range(3):
                resources.checkpoint_training_process()
            replace_process.assert_not_called()
            resources.checkpoint_training_process()
            executable, arguments, environment = replace_process.call_args.args
            self.assertEqual(arguments, [executable, *resources.sys.argv])
            self.assertEqual(
                environment["QUANT_FROZEN_INPUT_PATH"], "/frozen/inputs.json"
            )

    def test_normal_api_call_does_not_reuse_cli_snapshot(self):
        from pipeline import _coupon_inputs

        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.dict(
                "os.environ",
                {
                    "QUANT_CHECKPOINT_RESTART": "0",
                    "QUANT_FROZEN_INPUT_PATH": "/does-not-exist.json",
                },
            ),
            patch(
                "data.online_inputs.fetch_inputs",
                return_value={"as_of_date": "2026-09-23"},
            ) as fetch,
        ):
            self.assertEqual(
                _coupon_inputs(Path(tmp), "2026-09-23", None)["as_of_date"],
                "2026-09-23",
            )
            fetch.assert_called_once()


if __name__ == "__main__":
    unittest.main()
