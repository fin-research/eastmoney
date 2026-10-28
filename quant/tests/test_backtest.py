import io
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import pandas as pd

from backtest import (
    _DailyBacktestScorer,
    _counterfactual_bond_result,
    _issuer_bonds,
)


class _PredictMarketFeature:
    def predict(self, values):
        return np.asarray(values)[:, 0]


class BacktestHelpersTest(unittest.TestCase):
    def test_issuer_bonds_filters_and_sorts(self):
        dataset = pd.DataFrame(
            {
                "issuer": ["目标", "其他", "目标"],
                "issue_date": pd.to_datetime(
                    ["2024-01-03", "2024-01-02", "2024-01-01"]
                ),
            }
        )

        result = _issuer_bonds(dataset, "目标", "2024-01-02")

        self.assertEqual(result["issue_date"].dt.day.tolist(), [3])

    @patch("backtest.compute_peer_stats", return_value={"median": 10.0})
    def test_daily_scorer_uses_previous_market_row(self, peer_stats):
        market = pd.DataFrame(
            {"market": [1.0, 2.0, 99.0]},
            index=pd.to_datetime(["2024-01-01", "2024-01-02", "2024-01-03"]),
        )
        fe = SimpleNamespace(
            all_market_features_=market,
            feature_names=["market"],
        )
        month_models = {
            pd.Timestamp("2024-01-01"): (
                _PredictMarketFeature(),
                pd.Series({"market": 0.0}),
                5.0,
                {},
            )
        }
        scorer = _DailyBacktestScorer(pd.DataFrame(), fe, month_models)

        score = scorer.score_date(pd.Timestamp("2024-01-03"), 3.0, "AAA", "证券公司债")

        self.assertEqual(score, (2.0, 10.0, 12.0, True))
        peer_stats.assert_called_once_with(
            scorer.dataset,
            pd.Timestamp("2024-01-03"),
            3.0,
            "AAA",
            "证券公司债",
        )

    def test_counterfactual_result_selects_lowest_spread(self):
        dates = pd.to_datetime(["2024-01-02", "2024-01-03"])

        def score_date(eval_date, *_args):
            if eval_date == dates[0]:
                return 3.0, 10.0, 13.0, True
            return 1.0, 10.0, 11.0, True

        scorer = SimpleNamespace(
            all_trading_days=dates,
            score_date=score_date,
        )
        bond = pd.Series(
            {
                "issue_date": dates[1],
                "tenor": 3.0,
                "rating": "AAA",
                "bond_type": "证券公司债",
                "spread_to_benchmark": 15.0,
                "issue_size": 30.0,
            }
        )

        with redirect_stdout(io.StringIO()):
            result = _counterfactual_bond_result(bond, scorer, 30)

        self.assertEqual(result["best_date"], dates[1].date())
        self.assertEqual(result["savings_bp"], 4.0)
        self.assertEqual(result["savings_万元/年"], 120.0)


if __name__ == "__main__":
    unittest.main()
