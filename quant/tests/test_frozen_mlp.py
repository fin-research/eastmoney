"""Frozen neural predictions and exact ReLU path attribution, without fitting."""

import unittest
from unittest.mock import patch

import numpy as np

from model.frozen_mlp import FrozenMLP
from model.issuance_output import fit_selected
from model.issuance_unified import CouponCandidate, CouponModel


def synthetic_state():
    return {
        "settings": {"activation": "relu"},
        "preprocessing": {
            "fill": [2, -1],
            "center": [2, -1],
            "scale": [2, 1],
            "feature_names": ["x", "y"],
        },
        "coefs": [
            [[1, -1, 2, -2, 0, 1, 1, 0], [1, 1, -1, -1, 0, -1, 1, 0]],
            [[1], [-2], [0.5], [1], [2], [-1], [3], [0]],
        ],
        "intercepts": [[-1, 1, 0, 2, 0, -2, 1, 4], [0.25]],
        "target_mean_bp": 200,
        "target_scale_bp": 3,
    }


class FrozenMLPTests(unittest.TestCase):
    def test_missing_values_and_independent_forward(self):
        model = FrozenMLP(synthetic_state())
        x = np.array([[np.nan, np.nan], [4, 1], [-2, -5], [2, -1]])
        z = np.array([[0, 0], [1, 2], [-2, -4], [0, 0]])
        hidden = np.maximum(0, z @ model.w0 + model.b0)
        expected = 200 + 3 * (hidden @ model.w1 + 0.25).ravel()
        np.testing.assert_allclose(model.predict(x), expected, rtol=0, atol=1e-12)

    def test_path_integrals_crossing_kinks_and_zero_increment(self):
        model = FrozenMLP(synthetic_state())
        x = np.array([[6, 1], [-2, -5], [2, -1], [2 + 2e-12, -1]])
        z = model.transformed(x)
        phi = model.contributions(x)
        np.testing.assert_allclose(
            phi.sum(axis=1), model.predict(x), rtol=0, atol=1e-11
        )
        np.testing.assert_array_equal(phi[2, :-1], [0, 0])
        # Independent midpoint quadrature of input gradients; includes units
        # whose activations cross zero and units with zero path increment.
        t = (np.arange(100000) + 0.5) / 100000
        for i in range(2):
            active = (t[:, None] * (z[i] @ model.w0) + model.b0) > 0
            gradient = (active * model.w1.ravel()) @ model.w0.T
            expected = model.target_scale * z[i] * gradient.mean(axis=0)
            np.testing.assert_allclose(phi[i, :-1], expected, rtol=0, atol=0.0005)

    def test_invalid_state_rejected(self):
        for key in ("scale", "fill"):
            state = synthetic_state()
            state["preprocessing"][key][0] = 0 if key == "scale" else float("inf")
            with self.assertRaisesRegex(ValueError, "invalid frozen MLP"):
                FrozenMLP(state)
        state = synthetic_state()
        state["coefs"][0].pop()
        with self.assertRaises(ValueError):
            FrozenMLP(state)

    def test_selected_release_restores_even_with_old_gate_false(self):
        evaluation = {"release_policy": "user_selected_frozen_mlp", "qualified": False}
        sentinel = object()
        with patch(
            "model.frozen_mlp.restore_frozen_model", return_value=sentinel
        ) as restore:
            self.assertIs(fit_selected(None, evaluation, "2026-10-26"), sentinel)
            restore.assert_called_once_with(evaluation)

    def test_mlp_cannot_be_accidentally_refit(self):
        candidate = CouponCandidate("mlp", "coupon", 0, feature_set="quote_history")
        with self.assertRaisesRegex(ValueError, "without refitting"):
            CouponModel(candidate).fit(None, None, "2026-01-01")


if __name__ == "__main__":
    unittest.main()
