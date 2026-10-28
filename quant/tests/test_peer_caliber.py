import unittest

import pandas as pd

from data.data import BondDataBuilder, FeatureEngineer, compute_peer_stats
from model.train import _recompute_horizon_peer_features


def _sample_bonds() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "issue_date": pd.to_datetime(
                [
                    "2024-01-01",
                    "2024-01-02",
                    "2024-01-03",
                    "2024-01-04",
                    "2024-01-05",
                    "2024-01-06",
                    "2024-01-10",
                ]
            ),
            "rating": ["AAA"] * 7,
            "tenor": [3.0] * 7,
            "bond_type": [
                "证券公司债",
                "证券公司债",
                "证券公司债",
                "证券公司次级债",
                "证券公司次级债",
                "证券公司次级债",
                "证券公司债",
            ],
            "spread_to_benchmark": [10.0, 20.0, 30.0, 100.0, 110.0, 120.0, 25.0],
        }
    )


class PeerCaliberTest(unittest.TestCase):
    def test_compute_peer_stats_requires_same_bond_type(self):
        primary = compute_peer_stats(
            _sample_bonds(),
            pd.Timestamp("2024-01-10"),
            3.0,
            "AAA",
        )
        subordinated = compute_peer_stats(
            _sample_bonds(),
            pd.Timestamp("2024-01-10"),
            3.0,
            "AAA",
            "证券公司次级债",
        )

        self.assertEqual(primary, {"median": 20.0, "std": 10.0, "count": 3})
        self.assertEqual(subordinated, {"median": 110.0, "std": 10.0, "count": 3})

    def test_label_uses_same_bond_type_peers(self):
        result = BondDataBuilder().build_label(_sample_bonds())
        target = result[result["issue_date"] == pd.Timestamp("2024-01-10")].iloc[0]

        self.assertEqual(target["y_regression"], 5.0)
        self.assertEqual(target["y_classification"], 0)

    def test_peer_features_use_same_bond_type_peers(self):
        bonds = _sample_bonds()
        result = FeatureEngineer.build_peer_features(bonds)
        target_index = bonds.index[bonds["issue_date"] == pd.Timestamp("2024-01-10")][0]

        self.assertEqual(result.loc[target_index, "peer_spread_median"], 20.0)
        self.assertEqual(result.loc[target_index, "peer_count"], 3.0)

    def test_horizon_peer_features_use_same_bond_type_peers(self):
        bonds = _sample_bonds()
        target_index = bonds.index[bonds["issue_date"] == pd.Timestamp("2024-01-10")][0]
        frame = bonds.loc[[target_index]].copy()
        frame[["peer_spread_median", "peer_spread_std", "peer_count"]] = float("nan")
        origin_dates = pd.Series(
            {target_index: pd.Timestamp("2024-01-09")},
            dtype="datetime64[ns]",
        )

        result = _recompute_horizon_peer_features(frame, bonds, origin_dates)

        self.assertEqual(result.loc[target_index, "peer_spread_median"], 20.0)
        self.assertEqual(result.loc[target_index, "peer_count"], 3.0)


if __name__ == "__main__":
    unittest.main()
