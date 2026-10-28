"""Causal calibration must retain all events and isolate immature outcomes."""

import unittest
from unittest.mock import patch
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import pandas as pd

from model.issuance_calibration import MODES, RULES, calibrate_oof, weighted_median
from model.issuance_calibration_study import FIXED_PROTOCOL, run_study


def event(code, pricing, residual, leads=(7, 30), label=None):
    pricing = pd.Timestamp(pricing)
    result = []
    for lead in leads:
        origin = pricing - pd.Timedelta(days=lead)
        cutoff = origin.to_period("M").start_time
        result.append(
            {
                "bond_code": code,
                "issuer": "issuer",
                "rating": "AAA",
                "bond_type": "普通",
                "placement_type": "公募",
                "tenor": 3.0,
                "coupon_bp": 250.0,
                "predicted_bp": 250.0 - residual,
                "pricing_date": pricing,
                "label_available_date": pd.Timestamp(label or pricing),
                "origin": origin,
                "lead_days": lead,
                "training_cutoff": cutoff,
                "training_label_end": cutoff - pd.Timedelta(days=1),
            }
        )
    return result


def history():
    return pd.DataFrame(
        [r for i in range(30) for r in event(f"h{i}", "2023-02-15", 10.0)]
        + event("target", "2023-04-10", -100.0)
    )


class CalibrationTests(unittest.TestCase):
    def test_median_mass_ties_and_permutation(self):
        # 15 events have five leads, 15 have one: both sides total mass15.
        values = np.array([-10.0] * 75 + [20.0] * 15)
        weights = np.array([0.2] * 75 + [1.0] * 15)
        for seed in range(3):
            order = np.random.default_rng(seed).permutation(len(values))
            self.assertEqual(weighted_median(values[order], weights[order]), 5.0)

    def test_cold_start_and_correct_sign_keep_all_rows(self):
        raw = history()
        for mode in MODES:
            corrected, audit = calibrate_oof(raw, mode)
            self.assertEqual(len(raw), len(corrected))
            target = corrected.loc[corrected.bond_code.eq("target")]
            self.assertTrue(target.predicted_bp.eq(360.0).all())
            cold = corrected.loc[~corrected.bond_code.eq("target")]
            self.assertTrue(cold.predicted_bp.eq(cold.raw_predicted_bp).all())
            self.assertTrue(cold.calibration_active.eq(False).all())
            self.assertTrue(all(r["total_weight"] == r["bonds"] for r in audit))
            pd.testing.assert_frame_equal(raw, history())

    def test_events_not_rows_control_minimum_and_weights(self):
        raw = history().loc[lambda r: ~r.bond_code.eq("h29")]
        corrected, _ = calibrate_oof(raw, MODES[0])
        self.assertTrue(corrected.calibration_offset_bp.eq(0).all())
        records = [
            r
            for i in range(30)
            for r in event(
                f"h{i}",
                "2023-02-15",
                -10.0 if i < 15 else 20.0,
                leads=(7, 14, 30, 60, 90) if i < 15 else (30,),
            )
        ] + event("target", "2023-04-10", 0.0)
        corrected, _ = calibrate_oof(pd.DataFrame(records), MODES[0])
        self.assertTrue(
            corrected.loc[corrected.bond_code.eq("target"), "calibration_offset_bp"]
            .eq(5.0)
            .all()
        )

    def test_same_month_outcomes_wait_until_next_month(self):
        records = [r for i in range(30) for r in event(f"h{i}", "2023-03-02", 10.0)]
        records += event("march", "2023-03-30", 0.0, leads=(7,))
        records += event("april", "2023-04-10", 0.0, leads=(7,))
        corrected, _ = calibrate_oof(pd.DataFrame(records), MODES[0])
        self.assertEqual(
            corrected.loc[
                corrected.bond_code.eq("march"), "calibration_offset_bp"
            ].item(),
            0.0,
        )
        self.assertEqual(
            corrected.loc[
                corrected.bond_code.eq("april"), "calibration_offset_bp"
            ].item(),
            10.0,
        )

    def test_strict_maturity_window_and_no_feedback(self):
        records = [r for i in range(30) for r in event(f"old{i}", "2022-02-01", -500.0)]
        records += [r for i in range(30) for r in event(f"h{i}", "2023-02-15", 10.0)]
        records += event("boundary", "2023-03-01", -1000.0)
        records += event("march", "2023-03-31", 0.0, leads=(30,))
        corrected, audit = calibrate_oof(pd.DataFrame(records), MODES[0])
        row = next(r for r in audit if r["cutoff"] == "2023-03-01")
        self.assertEqual(row["bonds"], 30)
        self.assertEqual(row["offset_bp"], 10.0)
        # March was itself corrected; April must still use March's raw residual.
        more = pd.DataFrame(
            [r for i in range(30) for r in event(f"feb{i}", "2023-02-15", 10.0)]
            + [r for i in range(30) for r in event(f"mar{i}", "2023-03-25", 20.0)]
            + event("later", "2023-04-10", 0.0, leads=(7,))
        )
        out, _ = calibrate_oof(more, MODES[0])
        self.assertTrue(
            out.loc[out.bond_code.eq("later"), "calibration_offset_bp"].eq(15.0).all()
        )

    def test_future_append_modify_delete_and_order_do_not_change_past(self):
        raw = history()
        for mode in MODES:
            base, _ = calibrate_oof(raw, mode)
            future = pd.DataFrame(event("future", "2024-04-10", 10000.0))
            for tail in (future, future.assign(predicted_bp=-99999.0), future.iloc[:0]):
                augmented = pd.concat([raw, tail], ignore_index=True).sample(
                    frac=1.0, random_state=9
                )
                out, _ = calibrate_oof(augmented, mode)
                actual = out.loc[out.bond_code.ne("future")].sort_values(
                    ["bond_code", "lead_days"]
                )
                expected = base.sort_values(["bond_code", "lead_days"])
                np.testing.assert_array_equal(
                    actual.predicted_bp, expected.predicted_bp
                )

    def test_horizon_pool_remains_separate(self):
        raw = history()
        raw.loc[raw.lead_days.eq(7) & raw.bond_code.ne("target"), "predicted_bp"] = (
            270.0
        )
        out, _ = calibrate_oof(raw, MODES[1])
        target = out.loc[out.bond_code.eq("target")].set_index("lead_days")
        self.assertEqual(target.loc[7, "calibration_offset_bp"], -20.0)
        self.assertEqual(target.loc[30, "calibration_offset_bp"], 10.0)

    def test_invalid_clocks_duplicate_and_ambiguous_labels_rejected(self):
        raw = history()
        broken = [
            pd.concat([raw, raw.iloc[:1]]),
            raw.assign(training_label_end=raw.training_cutoff),
            raw.assign(label_available_date=raw.origin),
            raw.assign(predicted_bp=np.nan),
        ]
        inconsistent = raw.copy()
        inconsistent.loc[0, "coupon_bp"] = 999.0
        broken.append(inconsistent)
        for rows in broken:
            with self.assertRaises(ValueError):
                calibrate_oof(rows, MODES[0])

    def test_changed_source_rejected_before_scoring(self):
        with TemporaryDirectory() as temp:
            p = Path(temp)
            spec = {
                **FIXED_PROTOCOL,
                "source_directory": temp,
                "rules": RULES,
                "modes": list(MODES),
                "production_eligible": False,
                "transform_code": {},
                "runtime": {},
                "source_inventory": {"old": "hash"},
            }
            (p / "protocol.json").write_text(json.dumps(spec))
            with (
                patch(
                    "model.issuance_calibration_study.source_hashes", return_value={}
                ),
                patch(
                    "model.issuance_calibration_study.runtime_identity", return_value={}
                ),
                patch(
                    "model.issuance_calibration_study.source_inventory", return_value={}
                ),
                patch("model.issuance_calibration_study._source_predictions") as reader,
            ):
                with self.assertRaisesRegex(ValueError, "drift"):
                    run_study(p)
                reader.assert_not_called()

    def test_source_identity_and_fixed_rules_cannot_be_relabeled(self):
        with TemporaryDirectory() as temp:
            p = Path(temp)
            spec = {
                **FIXED_PROTOCOL,
                "source_directory": temp,
                "source_root": temp,
                "original_identity": "expected",
                "transform_code": {},
                "runtime": {},
                "source_inventory": {},
            }
            variants = [dict(spec, original_identity="wrong")]
            variants += [dict(spec, **{key: "tampered"}) for key in FIXED_PROTOCOL]
            with (
                patch(
                    "model.issuance_calibration_study.source_hashes", return_value={}
                ),
                patch(
                    "model.issuance_calibration_study.runtime_identity", return_value={}
                ),
                patch(
                    "model.issuance_calibration_study.source_inventory", return_value={}
                ),
                patch(
                    "model.issuance_calibration_study._source_predictions",
                    return_value=(history(), {"identity_sha256": "expected"}),
                ),
                patch("model.issuance_calibration_study.calibrate_oof") as calibrate,
            ):
                for variant in variants:
                    (p / "protocol.json").write_text(json.dumps(variant))
                    with self.assertRaises(ValueError):
                        run_study(p)
                calibrate.assert_not_called()

    def test_recalibrated_inputs_are_rejected(self):
        out, _ = calibrate_oof(history(), MODES[0])
        with self.assertRaisesRegex(ValueError, "uncalibrated"):
            calibrate_oof(out, MODES[1])


if __name__ == "__main__":
    unittest.main()
