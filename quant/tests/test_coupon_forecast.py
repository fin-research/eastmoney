"""Protect the feature registry, the attribution identity and the refusal rules of the coupon forecast."""

import json
import os
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from model import coupon_forecast as cf

FIXTURE = Path(__file__).parent.parent / "online/tests/fixtures/coupon-columns.json"


class RegistryTests(unittest.TestCase):
    def test_columns_are_unique_and_every_code_style_feature_is_named(self):
        columns = cf.columns()
        self.assertEqual(len(columns), len(set(columns)))
        for name in columns:
            self.assertIn(cf.feature_group(name), cf.GROUPS)
            if "_" in name:
                self.assertNotEqual(cf.feature_label(name), name, name)

    def test_columns_match_the_js_runtime_fixture(self):
        if os.environ.get("UPDATE_FIXTURE") == "1":
            FIXTURE.write_text(json.dumps(cf.columns(), ensure_ascii=False))
        self.assertEqual(json.loads(FIXTURE.read_text()), cf.columns())


def toy_model(n=len(cf.columns())):
    rng = np.random.default_rng(3)
    return {"kind": "coupon_huber", "columns": cf.columns(), "alpha": cf.ALPHA, "mean": rng.normal(size=n).tolist(),
            "scale": (1 + rng.random(n)).tolist(), "coef": rng.normal(size=n).tolist(), "intercept": -1.0}


class PredictionTests(unittest.TestCase):
    def test_contributions_sum_to_the_residual(self):
        model = toy_model()
        row = {c: float(i % 5) for i, c in enumerate(model["columns"])}
        residual, contributions = cf.predict(model, row)
        self.assertAlmostEqual(residual, model["intercept"] + contributions.sum(), places=12)

    def test_a_missing_input_is_refused_not_filled(self):
        model = toy_model()
        row = {c: 1.0 for c in model["columns"]}
        row[model["columns"][7]] = float("nan")
        with self.assertRaises(cf.Refused):
            cf.predict(model, row)

    def test_invalid_models_are_rejected(self):
        for change in (lambda m: m["scale"].__setitem__(0, 0), lambda m: m["coef"].pop(), lambda m: m.update(kind="x"),
                       lambda m: m["columns"].__setitem__(1, m["columns"][0])):
            model = toy_model()
            change(model)
            with self.assertRaises(ValueError):
                cf.validate_model(model)


class IssuerTests(unittest.TestCase):
    def history(self):
        rows = []
        for i, (kind, dev) in enumerate([("证券公司债", 4.0), ("证券公司债", 8.0), ("证券公司债", 6.0), ("证券公司次级债", 20.0)]):
            day = pd.Timestamp("2026-06-01") + pd.Timedelta(days=10 * i)
            rows.append({"bond_code": f"{i}", "bond_type": kind, "tender": day, "label": day, "dev": dev, "amount": 10.0 + i, "rating": "AAA"})
        return pd.DataFrame(rows)

    def test_median_needs_two_public_prior_issues_and_waits_a_full_day(self):
        history = self.history()
        median, amount, rating, n = cf.issuer_terms(history, pd.Timestamp("2026-08-01"), "证券公司债")
        self.assertEqual((median, n, rating), (6.0, 3, 3.0))
        with self.assertRaises(cf.Refused):
            cf.issuer_terms(history, pd.Timestamp("2026-08-01"), "证券公司次级债")
        # the label of the 06-21 issue is public on 06-21; a decision on 06-22 may not use it yet
        median, _, _, n = cf.issuer_terms(history, pd.Timestamp("2026-06-22"), "证券公司债")
        self.assertEqual(n, 2)

    def test_nearest_node_has_a_tolerance_and_no_interpolation(self):
        self.assertEqual(cf.nearest_node([1.0, 2.0, 3.0], 2.99), 3.0)
        self.assertIsNone(cf.nearest_node([1.0, 2.0, 3.0], 2.5))


if __name__ == "__main__":
    unittest.main()
