"""Receipt-backed calibration study, reusing the existing coupon evaluator."""

import hashlib
import json
from pathlib import Path
import subprocess

import numpy as np
import pandas as pd

from research_sources import runtime_identity, source_hashes
from .issuance_calibration import MODES, RULES, calibrate_oof, validate_oof
from .issuance_diagnostics import error_metrics
from .issuance_market_validation import verified_market_stage, verify_market_selection
from .issuance_study_protocol import digest, immutable_json, registered_candidates
from .issuance_study_report import candidate_report, paired_rows

FIXED_PROTOCOL = {
    "schema_version": 1,
    "rules": RULES,
    "modes": list(MODES),
    "gate_policy": "existing_coupon_development_gates_against_raw_huber",
    "selection_policy": "passed_gates_then_mae_rmse_name",
    "production_eligible": False,
    "new_training_fits": 0,
}


def source_inventory(directory):
    files = [directory / "protocol.json", directory / "selection.json"]
    for candidate in registered_candidates(json.loads(files[0].read_text())["spec"]):
        files.extend((directory / candidate.name / "months").glob("*"))
    return {
        str(p.relative_to(directory)): digest(p) for p in sorted(files) if p.is_file()
    }


def _source_predictions(directory, root):
    protocol = json.loads((directory / "protocol.json").read_text())
    spec = protocol["spec"]
    token = hashlib.sha256(
        json.dumps(protocol["identity"], sort_keys=True).encode()
    ).hexdigest()
    if (
        spec["schema_version"] != 9
        or spec["stage"] != "development"
        or source_hashes(root) != protocol["identity"]["code"]
        or token != protocol["identity_sha256"]
    ):
        raise ValueError("calibration requires unchanged schema9 development source")
    candidates = registered_candidates(spec)
    rows = verified_market_stage(
        directory, candidates, token, spec["development_start"], spec["development_end"]
    )
    selection = json.loads((directory / "selection.json").read_text())
    verify_market_selection(rows, selection, candidates)
    return validate_oof(rows[candidates[0].name]), protocol


def register_study(source, source_root, output):
    """Freeze both old prediction provenance and new transform before any scoring."""
    root = Path(__file__).resolve().parents[1]
    revision = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()
    repository = Path(
        subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"], cwd=root, text=True
        ).strip()
    )
    prefix = root.relative_to(repository)
    code = source_hashes()
    for name, checksum in code.items():
        content = subprocess.check_output(
            [
                "git",
                "show",
                f"{revision}:{(repository / prefix / name).resolve().relative_to(repository).as_posix()}",
            ],
            cwd=repository,
        )
        if hashlib.sha256(content).hexdigest() != checksum:
            raise ValueError("commit scientific sources before registration")
    source, source_root, output = map(
        lambda p: Path(p).resolve(), (source, source_root, output)
    )
    _, old = _source_predictions(source, source_root)
    value = {
        **FIXED_PROTOCOL,
        "source_directory": str(source),
        "source_root": str(source_root),
        "source_inventory": source_inventory(source),
        "original_identity": old["identity_sha256"],
        "transform_revision": revision,
        "transform_code": code,
        "runtime": runtime_identity(),
    }
    output.mkdir(parents=True, exist_ok=True)
    immutable_json(output / "protocol.json", value)
    return value


def _issuer_interval(frame, control):
    pairs = paired_rows(frame, control)
    delta = (pairs.coupon_bp - pairs.predicted_bp).abs() - (
        pairs.coupon_bp - pairs.predicted_bp_b0
    ).abs()
    blocks = (
        pd.DataFrame({"issuer": pairs.issuer, "delta": delta})
        .groupby("issuer")
        .delta.agg(["sum", "count"])
    )
    indices = np.random.default_rng(42).integers(0, len(blocks), (2000, len(blocks)))
    values = blocks["sum"].to_numpy()[indices].sum(axis=1) / blocks["count"].to_numpy()[
        indices
    ].sum(axis=1)
    return {
        "samples": len(pairs),
        "clusters": len(blocks),
        "seed": 42,
        "repeats": 2000,
        "mae_delta_bp": float(delta.mean()),
        "interval": np.quantile(values, [0.025, 0.975]).tolist(),
    }


def _coverage(rows, audit):
    return {
        str(lead): {
            "requested": len(group),
            "active": int(group.calibration_active.sum()),
            "fallback": int((~group.calibration_active).sum()),
            "first_active_month": min(
                (r["cutoff"] for r in audit if r["lead_days"] == lead and r["active"]),
                default=None,
            ),
        }
        for lead, group in rows.groupby("lead_days")
    }


def run_study(directory):
    directory = Path(directory).resolve()
    spec = json.loads((directory / "protocol.json").read_text())
    source = Path(spec["source_directory"])
    if (
        any(spec.get(k) != value for k, value in FIXED_PROTOCOL.items())
        or spec["transform_code"] != source_hashes()
        or spec["runtime"] != runtime_identity()
        or spec["source_inventory"] != source_inventory(source)
    ):
        raise ValueError("calibration protocol/source/runtime drift")
    raw, old = _source_predictions(source, Path(spec["source_root"]))
    if spec["original_identity"] != old["identity_sha256"]:
        raise ValueError("original prediction identity differs from registration")
    h30 = raw.loc[raw.lead_days.eq(30)]
    results = []
    for mode in MODES:
        rows, audit = calibrate_oof(raw, mode)
        report = candidate_report(rows, raw, business_tenors=True)
        path = directory / f"{mode}.csv"
        content = rows.to_csv(index=False, float_format="%.15g")
        if path.exists() and path.read_text() != content:
            raise ValueError("calibration prediction output differs")
        path.write_text(content)
        immutable_json(directory / f"{mode}.audit.json", audit)
        results.append(
            {
                "name": mode,
                **report,
                "coverage": _coverage(rows, audit),
                "issuer_interval": _issuer_interval(
                    rows.loc[rows.lead_days.eq(30)], h30
                ),
                "predictions_sha256": digest(path),
                "audit_sha256": digest(directory / f"{mode}.audit.json"),
            }
        )
    eligible = [r for r in results if r["gates"]["passed"]]
    selected = (
        min(
            eligible,
            key=lambda r: (
                r["gates"]["h30"]["candidate"]["mae_bp"],
                r["gates"]["h30"]["candidate"]["rmse_bp"],
                r["name"],
            ),
        )
        if eligible
        else None
    )
    result = {
        "protocol_sha256": digest(directory / "protocol.json"),
        "original_identity": old["identity_sha256"],
        "rows": len(raw),
        "events": raw.bond_code.nunique(),
        "h30": error_metrics(h30.coupon_bp, h30.predicted_bp),
        "selected": selected["name"] if selected else None,
        "status": "historical_candidate_only" if selected else "no_qualified_candidate",
        "production_eligible": False,
        "candidates": results,
    }
    immutable_json(directory / "results.json", result)
    return result
