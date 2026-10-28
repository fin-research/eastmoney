"""Compact raw-input schema keeps the existing model input contract."""

import unittest

from data.online_inputs import decode_exchange_bond_code


class QuantDatabaseInputsTest(unittest.TestCase):
    def test_exchange_code_round_trip_representation(self):
        self.assertEqual(decode_exchange_bond_code(12_654_321), "654321X2.SH")
        self.assertEqual(decode_exchange_bond_code(20_000_001), "000001.SZ")
        with self.assertRaises(ValueError):
            decode_exchange_bond_code(9_999_999)


if __name__ == "__main__":
    unittest.main()
