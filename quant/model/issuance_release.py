"""Frozen public-only selection and historical validation for authorized release."""

from dataclasses import asdict
import json
from pathlib import Path

import numpy as np
import pandas as pd

from .issuance_diagnostics import period_metrics

from .export import write_json
from .issuance_evaluation import _best_candidate, _metric_rows, frozen_sigmas
from .issuance_study_protocol import digest, PUBLIC_CANDIDATES


def _public_selection(path):
    path = Path(path).resolve()
    selection = json.loads(path.read_text())
    protocol_path = path.parent / "protocol.json"
    protocol = json.loads(protocol_path.read_text())
    if (
        protocol["spec"]["schema_version"] != 5
        or protocol["spec"]["issuance_scope"] != "public_only"
        or selection.get("status") != "user_authorized_best_public_mean"
        or selection.get("failures")
        or selection["identity_sha256"] != protocol["identity_sha256"]
        or len(selection["ranking"]) != len(PUBLIC_CANDIDATES)
    ):
        raise ValueError("incomplete or unauthorized public selection")
    eligible = [r for r in selection["ranking"] if r["estimand"] == "conditional_mean"]
    if selection["selected"] != _best_candidate(eligible)["candidate"]:
        raise ValueError("public selection differs from frozen best mean rule")
    root = Path(__file__).resolve().parents[1]
    for name, checksum in protocol["identity"]["code"].items():
        if digest(root / name) != checksum:
            raise ValueError("release code differs from frozen study")
    return path, selection, protocol_path


def _verified_months(directory, selection, candidate):
    frames = []
    for path in sorted(directory.glob("????-??.csv")):
        receipt = json.loads(path.with_suffix(".receipt.json").read_text())
        if receipt["identity_sha256"] != selection["identity_sha256"] or receipt[
            "candidate"
        ] != asdict(candidate):
            raise ValueError("monthly receipt differs from locked release")
        for key, artifact in (
            ("predictions_sha256", path),
            ("diagnostics_sha256", path.with_suffix(".diagnostics.json")),
            ("timing_sha256", path.with_suffix(".timing.csv")),
        ):
            if receipt[key] != digest(artifact):
                raise ValueError("monthly release artifact checksum mismatch")
        rows = pd.read_csv(path)
        if (
            not np.isfinite(rows.predicted_bp).all()
            or not (rows.training_label_end < rows.training_cutoff).all()
        ):
            raise ValueError("release validation contains immature training labels")
        frames.append(rows)
    rows = pd.concat(frames, ignore_index=True)
    if rows.duplicated(["bond_code", "origin", "lead_days"]).any():
        raise ValueError("duplicate release validation events")
    return rows


def build_public_release(selection_path, historical_directory, output_path):
    path, selection, protocol_path = _public_selection(selection_path)
    candidate = next(c for c in PUBLIC_CANDIDATES if asdict(c) == selection["selected"])
    historical = Path(historical_directory).resolve()
    report = json.loads((historical / "report.json").read_text())
    historical_protocol = json.loads((historical / "protocol.json").read_text())
    if (
        report.get("stage") != "historical-report"
        or historical_protocol["spec"]["stage"] != "historical-report"
        or report["failures"]
        or report["identity_sha256"] != selection["identity_sha256"]
        or historical_protocol["identity_sha256"] != selection["identity_sha256"]
    ):
        raise ValueError("historical validation does not match locked selection")
    rows = _verified_months(
        historical / candidate.name / "months", selection, candidate
    )
    development = _verified_months(
        path.parent / candidate.name / "months", selection, candidate
    )
    spec = historical_protocol["spec"]
    if not (
        rows.origin.ge(spec["development_end"])
        & rows.origin.lt(spec["as_of"])
        & rows.label_available_date.lt(spec["as_of"])
    ).all():
        raise ValueError("historical release rows outside frozen boundaries")
    actual = period_metrics(rows, split="historical-report")
    expected = report["metrics"][candidate.name]
    if len(actual) != len(expected) or any(
        left.keys() != right.keys()
        or any(
            not np.isclose(value, right[key], atol=1e-9, rtol=0)
            if isinstance(value, (int, float))
            else value != right[key]
            for key, value in left.items()
        )
        for left, right in zip(actual, expected, strict=True)
    ):
        raise ValueError("historical release metrics or denominator differ from report")
    if (
        not rows.placement_type.eq("公募").all()
        or not development.placement_type.eq("公募").all()
    ):
        raise ValueError("private or unknown events in public validation")
    value = {
        "candidate": selection["selected"],
        "issuance_scope": "public_only",
        "selection_path": str(path),
        "selection_sha256": digest(path),
        "protocol_sha256": digest(protocol_path),
        "historical_report_path": str(historical / "report.json"),
        "historical_report_sha256": digest(historical / "report.json"),
        "sample_count": rows.bond_code.nunique(),
        "prediction_start": str(pd.to_datetime(rows.origin).min().date()),
        "prediction_end": str(pd.to_datetime(rows.origin).max().date()),
        "metrics": _metric_rows(rows, frozen_sigmas(development)),
        "release_policy": "user_authorized_best_mean",
        "selected_passed_gates": selection["selected_passed_gates"],
        "status": "historical conditional public forecasts; no new independent forward evidence",
    }
    if output_path is not None:
        write_json(Path(output_path), value)
    return value


def load_public_release(path):
    value = json.loads(Path(path).read_text())
    if value.get("release_policy") == "user_selected_frozen_mlp":
        from .frozen_mlp import load_frozen_release

        return load_frozen_release(path)
    if value.get("release_policy") == "short_coupon_prediction":
        from .short_coupon import load_short_release

        return load_short_release(path)
    if value.get("release_policy") == "validated_market_separation":
        from .issuance_market_validation import load_market_release

        return load_market_release(value)
    if value.get("release_policy") == "user_authorized_best_public_point":
        from .issuance_point_release import load_point_release

        return load_point_release(value)
    _, selection, protocol = _public_selection(value["selection_path"])
    if (
        value.get("issuance_scope") != "public_only"
        or value["candidate"] != selection["selected"]
        or value["selection_sha256"] != digest(value["selection_path"])
        or value["protocol_sha256"] != digest(protocol)
        or value["historical_report_sha256"] != digest(value["historical_report_path"])
    ):
        raise ValueError("frozen release evidence mismatch")
    expected = build_public_release(
        value["selection_path"], Path(value["historical_report_path"]).parent, None
    )
    if value != expected:
        raise ValueError("release evaluation differs from verified monthly evidence")
    return value
