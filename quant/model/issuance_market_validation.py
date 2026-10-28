"""Fixed market-separation study gates and immutable release validation."""

from dataclasses import asdict
import json
import hashlib
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

from .export import write_json
from .issuance_diagnostics import error_metrics
from .issuance_evaluation import _best_candidate, _metric_rows, frozen_sigmas
from .issuance_study_protocol import MARKET_CANDIDATES, digest, registered_candidates


def evaluation_manifest(rows):
    frame = rows[["bond_code", "origin", "lead_days", "coupon_bp"]].copy()
    frame["origin"] = pd.to_datetime(frame.origin).dt.strftime("%Y-%m-%d")
    frame = frame.sort_values(["bond_code", "origin", "lead_days"])
    return {
        "rows": len(frame),
        "events": frame.bond_code.nunique(),
        "key_labels_sha256": hashlib.sha256(
            frame.to_csv(index=False, float_format="%.9f").encode()
        ).hexdigest(),
    }


def verified_market_stage(directory, candidates, identity, start, end):
    from .issuance_release import _verified_months

    protocol = json.loads((directory / "protocol.json").read_text())
    if protocol["identity_sha256"] != identity:
        raise ValueError("market stage identity mismatch")
    results = {}
    for candidate in candidates:
        rows = _verified_months(
            directory / candidate.name / "months",
            {"identity_sha256": identity},
            candidate,
        )
        valid = (
            rows.origin.ge(start)
            & rows.origin.lt(end)
            & rows.label_available_date.lt(end)
            & rows.placement_type.eq("公募")
        )
        if (
            evaluation_manifest(rows) != protocol["evaluation_manifest"]
            or not valid.all()
        ):
            raise ValueError("incomplete market evaluation denominator or boundaries")
        results[candidate.name] = rows
    return results


def verify_market_selection(results, selection, candidates):
    with tempfile.TemporaryDirectory() as temporary:
        expected = save_market_development(
            results, {}, Path(temporary), selection["identity_sha256"], candidates
        )
    if (
        expected["selected"] != selection["selected"]
        or expected["status"] != selection["status"]
        or len(expected["ranking"]) != len(selection["ranking"])
    ):
        raise ValueError("market selection differs from complete receipt evidence")
    keys = ("samples", "requested", "missing", "mae_bp", "rmse_bp", "bias_bp")
    for actual, wanted in zip(selection["ranking"], expected["ranking"], strict=True):
        if (
            actual["candidate"] != wanted["candidate"]
            or actual["gates"] != wanted["gates"]
            or any(
                not np.isclose(actual[k], wanted[k], atol=1e-9, rtol=0) for k in keys
            )
        ):
            raise ValueError("market ranking differs from receipt scores")


def verify_market_report(results, report):
    from .issuance_diagnostics import period_metrics

    for name, rows in results.items():
        actual = period_metrics(rows, split="historical-report")
        expected = report["metrics"][name]
        if len(actual) != len(expected):
            raise ValueError("historical market report denominator differs")
        for left, right in zip(actual, expected, strict=True):
            mismatch = left.keys() != right.keys() or any(
                not np.isclose(v, right[k], atol=1e-9, rtol=0)
                if isinstance(v, (int, float))
                else v != right[k]
                for k, v in left.items()
            )
            if mismatch:
                raise ValueError("historical market report differs from receipt rows")


def change_metrics(rows):
    actual = rows.market_actual_change_bp
    prediction = rows.market_predicted_change_bp
    moving = actual.abs().ge(1.0)
    regimes = {}
    for name, selected in (("rising", actual.ge(1)), ("falling", actual.le(-1))):
        regimes[name] = {
            **error_metrics(actual[selected], prediction[selected]),
            "flat_mae_bp": float(actual[selected].abs().mean())
            if selected.any()
            else None,
            "direction_accuracy": float(
                (np.sign(actual[selected]) == np.sign(prediction[selected])).mean()
            )
            if selected.any()
            else None,
        }
    return {
        **error_metrics(actual, prediction),
        "flat_mae_bp": float(actual.abs().mean()),
        "moving_samples": int(moving.sum()),
        "direction_accuracy": float(
            (np.sign(actual[moving]) == np.sign(prediction[moving])).mean()
        )
        if moving.any()
        else None,
        "rising_samples": int(actual.ge(1).sum()),
        "falling_samples": int(actual.le(-1).sum()),
        "always_down_accuracy": float(actual[moving].lt(0).mean())
        if moving.any()
        else None,
        "regimes": regimes,
        "training_constant": error_metrics(actual, rows.market_constant_change_bp)
        if "market_constant_change_bp" in rows
        else None,
    }


def save_market_development(
    results, failures, directory, token, candidates=MARKET_CANDIDATES
):
    incumbent, flat, *_ = candidates
    ranking = []
    for candidate in candidates:
        if candidate.name not in results:
            continue
        rows = results[candidate.name]
        h30 = rows.loc[rows.lead_days.eq(30)]
        score = error_metrics(h30.coupon_bp, h30.predicted_bp)
        gates = {"passed": False}
        if candidate.target == "pricing_excess":
            market = change_metrics(h30)
            old = results[incumbent.name].loc[lambda r: r.lead_days.eq(30)]
            zero = results[flat.name].loc[lambda r: r.lead_days.eq(30)]
            gates = {
                "coupon_protection": score["mae_bp"]
                <= error_metrics(old.coupon_bp, old.predicted_bp)["mae_bp"] + 0.2,
                "flat_coupon_protection": score["mae_bp"]
                <= error_metrics(zero.coupon_bp, zero.predicted_bp)["mae_bp"] + 0.2,
                "market_skill": market["mae_bp"] <= market["flat_mae_bp"] * 0.95,
                "both_regimes": market["rising_samples"] >= 30
                and market["falling_samples"] >= 30,
                "regime_protection": all(
                    r["samples"] and r["mae_bp"] <= r["flat_mae_bp"] * 1.05
                    for r in market["regimes"].values()
                ),
            }
            gates["passed"] = all(gates.values()) and candidate.market_change != "zero"
            write_json(
                directory / candidate.name / "market-diagnostics.json",
                {
                    "h30": market,
                    "yearly": {
                        str(year): change_metrics(part)
                        for year, part in h30.groupby(
                            pd.to_datetime(h30.origin).dt.year
                        )
                    },
                    "hit_rate_not_used_for_selection": True,
                    "monthly": {
                        str(month): change_metrics(part)
                        for month, part in h30.groupby(
                            pd.to_datetime(h30.origin).dt.to_period("M")
                        )
                    },
                },
            )
        ranking.append(
            {
                "name": candidate.name,
                "candidate": asdict(candidate),
                "estimand": candidate.estimand,
                "failure": None,
                **score,
                "gates": gates,
            }
        )
    balanced_study = any(c.market_change == "balanced" for c in candidates)
    upgrade_modes = (
        ["tenor", "tenor_shape"]
        if any(c.market_change == "tenor" for c in candidates)
        else ["balanced", "balanced_half"]
        if balanced_study
        else None
    )
    eligible = [
        r
        for r in ranking
        if r["gates"]["passed"]
        and (upgrade_modes is None or r["candidate"]["market_change"] in upgrade_modes)
    ]
    best = _best_candidate(eligible) if eligible and not failures else None
    value = {
        "identity_sha256": token,
        "ranking": ranking,
        "failures": failures,
        "selected": best["candidate"] if best else None,
        "final_period_touched": False,
        "status": "validated_market_separation" if best else "no_qualified_candidate",
        "selection_rule": "5% h30 market MAE skill, both regimes >=30, coupon no worse than incumbent/zero +0.2bp; h30 coupon MAE then RMSE",
        "release_policy": "validated_market_separation",
    }
    if upgrade_modes is not None:
        value["upgrade_modes"] = upgrade_modes
    write_json(directory / "selection.json", value)
    return value


def build_market_release(development, historical, output=None):
    development, historical = Path(development).resolve(), Path(historical).resolve()
    selection = json.loads((development / "selection.json").read_text())
    report = json.loads((historical / "report.json").read_text())
    protocol = json.loads((historical / "protocol.json").read_text())
    if (
        selection["status"] != "validated_market_separation"
        or selection["failures"]
        or report["failures"]
        or report["identity_sha256"] != selection["identity_sha256"]
    ):
        raise ValueError("no complete validated market release")
    root = Path(__file__).resolve().parents[1]
    for name, checksum in protocol["identity"]["code"].items():
        if digest(root / name) != checksum:
            raise ValueError("market release code differs from study")
    candidates = registered_candidates(protocol["spec"])
    candidate = next(c for c in candidates if asdict(c) == selection["selected"])
    spec = protocol["spec"]
    identity = selection["identity_sha256"]
    development_rows = verified_market_stage(
        development,
        candidates,
        identity,
        spec["development_start"],
        spec["development_end"],
    )
    verify_market_selection(development_rows, selection, candidates)
    history_rows = verified_market_stage(
        historical,
        (candidates[0], candidates[1], candidate),
        identity,
        spec["development_end"],
        spec["as_of"],
    )
    verify_market_report(history_rows, report)
    rows, tune = history_rows[candidate.name], development_rows[candidate.name]
    value = {
        "candidate": asdict(candidate),
        "issuance_scope": "public_only",
        "estimand": "huber_center",
        "expected_savings_supported": False,
        "sample_count": rows.bond_code.nunique(),
        "prediction_start": str(pd.to_datetime(rows.origin).min().date()),
        "prediction_end": str(pd.to_datetime(rows.origin).max().date()),
        "metrics": _metric_rows(rows, frozen_sigmas(tune)),
        "release_policy": "validated_market_separation",
        "selected_passed_gates": True,
        "status": "historical conditional forecasts; no independent forward evidence",
        "market_separation": {
            "development": str(development),
            "historical": str(historical),
            "selection_sha256": digest(development / "selection.json"),
            "report_sha256": digest(historical / "report.json"),
            "development_protocol_sha256": digest(development / "protocol.json"),
            "historical_protocol_sha256": digest(historical / "protocol.json"),
        },
    }
    if output:
        write_json(Path(output), value)
    return value


def load_market_release(value):
    record = value["market_separation"]
    if record["selection_sha256"] != digest(
        Path(record["development"]) / "selection.json"
    ) or record["report_sha256"] != digest(Path(record["historical"]) / "report.json"):
        raise ValueError("market release checksum mismatch")
    if value != build_market_release(record["development"], record["historical"]):
        raise ValueError("market evaluation differs from evidence")
    return value
