"""Transport decoding preserves observations and rejects malformed grids."""

import copy
import unittest
from data.curve_grid import decode_curve_inputs


class CurveGridTests(unittest.TestCase):
    def fixture(self):
        return {
            "datasets": {
                "industry_nodes": {
                    "encoding": "curve-grid-v1",
                    "curve_code": "5781a1ff7651967e0176978d957b7346",
                    "curve_name": "中债证券公司债收益率曲线(AAA)",
                    "rows": [["2026-10-21", 0.1, None], ["2026-10-21", 3, 1.2]],
                }
            }
        }

    def test_preserves_rows_null_and_plain_input(self):
        inputs = self.fixture()
        original = copy.deepcopy(inputs)
        decoded = decode_curve_inputs(inputs)
        self.assertEqual(inputs, original)
        self.assertIs(decode_curve_inputs(decoded), decoded)
        rows = decoded["datasets"]["industry_nodes"]
        self.assertEqual([r["yield_pct"] for r in rows], [None, 1.2])
        self.assertEqual([r["tenor_years"] for r in rows], [0.1, 3])

    def test_rejects_bad_identity_encoding_and_rows(self):
        for field, value in (
            ("encoding", "other"),
            ("curve_code", "other"),
            ("curve_name", "other"),
            ("rows", []),
            ("rows", [["2026-02-30", 3, 1.2]]),
            ("rows", [["2026-10-21", True, 1.2]]),
            ("rows", [["2026-10-21", 3, True]]),
            ("rows", [["2026-10-21", 3, 1], ["2026-10-21", 3, 1]]),
        ):
            with self.subTest(field=field, value=value):
                inputs = self.fixture()
                inputs["datasets"]["industry_nodes"][field] = value
                with self.assertRaises(ValueError):
                    decode_curve_inputs(inputs)
