"""Explicit point-forecast release, derived from an immutable completed public study."""

from dataclasses import asdict
import json
from pathlib import Path

import numpy as np
import pandas as pd

from data.issuance_training import IssuancePanel
from research_sources import source_hashes, runtime_identity
from .export import write_json
from .issuance_evaluation import (
    _best_candidate,
    _fingerprint,
    _metric_rows,
    frozen_sigmas,
)
from .issuance_study import run_candidates
from .issuance_study_protocol import (
    PUBLIC_CANDIDATES,
    digest,
    immutable_json,
    load_spec,
    load_study_inputs,
    stage_mask,
)
from .issuance_timing_audit import timing_summary
from .issuance_diagnostics import error_metrics
from .issuance_release import _verified_months
from .research_resources import bounded_window_research, release_training_memory

# Only publication adapters may differ from the original training/replay study.
# Every old/new checksum is pinned in the new release protocol.
RELEASE_ADAPTERS = {
    "main.py",
    "pipeline.py",
    "online_pipeline.py",
    "model/issuance_release.py",
}


def _verify_development_ranking(development, selection):
    expected_names = {c.name for c in PUBLIC_CANDIDATES}
    if {r["name"] for r in selection["ranking"]} != expected_names:
        raise ValueError("public point candidates are not unique and complete")
    reference = None
    for rank in selection["ranking"]:
        candidate = next(c for c in PUBLIC_CANDIDATES if asdict(c) == rank["candidate"])
        if rank["name"] != candidate.name or rank["estimand"] != candidate.estimand:
            raise ValueError("public candidate identity differs")
        rows = _verified_months(
            development / candidate.name / "months", selection, candidate
        )
        keys = rows.set_index(
            ["bond_code", "origin", "lead_days"]
        ).coupon_bp.sort_index()
        if reference is None:
            reference = keys
        if not keys.equals(reference):
            raise ValueError("public point common denominator or labels differ")
        h30 = rows.loc[rows.lead_days.eq(30)]
        metric = error_metrics(h30.coupon_bp, h30.predicted_bp)
        if not rows.placement_type.eq("公募").all() or any(
            not np.isclose(metric[key], rank[key], atol=1e-9, rtol=0)
            for key in (
                "samples",
                "requested",
                "missing",
                "mae_bp",
                "rmse_bp",
                "bias_bp",
            )
        ):
            raise ValueError("public point selection evidence mismatch")


def _derived_selection(development):
    selection = json.loads((development / "selection.json").read_text())
    original = json.loads((development / "protocol.json").read_text())
    if (
        original["spec"]["schema_version"] != 5
        or original["spec"]["issuance_scope"] != "public_only"
        or selection["identity_sha256"] != original["identity_sha256"]
        or selection["failures"]
        or len(selection["ranking"]) != len(PUBLIC_CANDIDATES)
    ):
        raise ValueError("incomplete public study for point release")
    root = Path(__file__).resolve().parents[1]
    changes = {}
    for name, checksum in original["identity"]["code"].items():
        actual = digest(root / name)
        if actual != checksum:
            if name not in RELEASE_ADAPTERS:
                raise ValueError(
                    "point release training code differs from original study: " + name
                )
            changes[name] = {"study_sha256": checksum, "release_sha256": actual}
    _verify_development_ranking(development, selection)
    best = _best_candidate(selection["ranking"])
    candidate = next(c for c in PUBLIC_CANDIDATES if asdict(c) == best["candidate"])
    if candidate.estimand != "huber_center":
        raise ValueError(
            "authorized Huber release is not registered best point candidate"
        )
    return selection, original, best, candidate, changes


@bounded_window_research
def run_point_release(development, snapshot, directory):
    development, directory = Path(development).resolve(), Path(directory).resolve()
    selection, original, best, candidate, changes = _derived_selection(development)
    spec, nodes = load_spec(development.parent / "development.json")
    if spec != original["spec"]:
        raise ValueError(
            "point release request differs from frozen development protocol"
        )
    spec = {**spec, "stage": "historical-report"}
    inputs = load_study_inputs(snapshot, nodes, spec)
    panel = IssuancePanel.from_inputs(inputs)
    del inputs
    release_training_memory()
    candidates = (PUBLIC_CANDIDATES[0], PUBLIC_CANDIDATES[1], candidate)
    identity = _fingerprint(panel, candidates, pd.Timestamp(spec["as_of"]))
    policy = {
        "stage": "historical-report",
        "development_selection": str(development / "selection.json"),
        "development_selection_sha256": digest(development / "selection.json"),
        "development_protocol_sha256": digest(development / "protocol.json"),
        "selected": asdict(candidate),
        "estimand": candidate.estimand,
        "expected_savings_supported": False,
        "release_policy": "user_authorized_best_public_point",
        "selection_rule": "all 19 completed public candidates; h30 MAE; 0.2bp RMSE then simplicity",
        "user_choice": "Huber point accuracy; expected savings fields null",
        "selected_passed_gates": best["gates"]["passed"],
        "release_adapter_changes": changes,
        "source_identity_version": 2,
        "release_code": source_hashes(),
        "runtime": runtime_identity(),
        "identity": identity,
        "spec": spec,
    }
    import hashlib

    token = hashlib.sha256(json.dumps(policy, sort_keys=True).encode()).hexdigest()
    immutable_json(directory / "protocol.json", {**policy, "identity_sha256": token})
    requests = panel.requests(range(91))
    features = panel.features(
        requests, include_weighted_primary=True, include_industry_tenor=True
    )
    results, failures = run_candidates(
        panel,
        features,
        requests,
        stage_mask(requests, spec),
        candidates,
        directory,
        token,
        timing=True,
    )
    if failures:
        raise ValueError("point historical matrix incomplete")
    development_rows = _verified_months(
        development / candidate.name / "months", selection, candidate
    )
    # Publish metrics from the persisted receipt-bound CSV, exactly as the loader recomputes.
    historical = _verified_months(
        directory / candidate.name / "months", {"identity_sha256": token}, candidate
    )
    validation = {
        "candidate": asdict(candidate),
        "issuance_scope": "public_only",
        "estimand": "huber_center",
        "expected_savings_supported": False,
        "sample_count": historical.bond_code.nunique(),
        "prediction_start": str(pd.to_datetime(historical.origin).min().date()),
        "prediction_end": str(pd.to_datetime(historical.origin).max().date()),
        "metrics": _metric_rows(historical, frozen_sigmas(development_rows)),
        "release_policy": policy["release_policy"],
        "selected_passed_gates": best["gates"]["passed"],
        "status": "historical conditional public Huber point forecasts; no new independent forward evidence",
    }
    write_json(directory / "validation.json", validation)
    timings = {
        c.name: timing_summary(
            pd.concat(
                [
                    pd.read_csv(p)
                    for p in sorted(
                        (directory / c.name / "months").glob("*.timing.csv")
                    )
                ],
                ignore_index=True,
            )
        )
        for c in candidates
    }
    write_json(directory / "timing-report.json", timings)
    release = {
        **validation,
        "point_directory": str(directory),
        "point_protocol_sha256": digest(directory / "protocol.json"),
        "point_validation_sha256": digest(directory / "validation.json"),
    }
    write_json(directory / "release-evaluation.json", release)
    print(
        json.dumps(
            {
                "candidate": asdict(candidate),
                "historical_events": validation["sample_count"],
                "release": str(directory / "release-evaluation.json"),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    return release


def load_point_release(value):
    directory = Path(value["point_directory"])
    protocol_path = directory / "protocol.json"
    validation_path = directory / "validation.json"
    if (
        digest(protocol_path) != value["point_protocol_sha256"]
        or digest(validation_path) != value["point_validation_sha256"]
    ):
        raise ValueError("point release artifact checksum mismatch")
    policy = json.loads(protocol_path.read_text())
    root = Path(__file__).resolve().parents[1]
    if policy.get("source_identity_version") == 2 and (
        source_hashes() != policy["release_code"]
        or runtime_identity() != policy["runtime"]
    ):
        raise ValueError("point source closure or runtime changed after validation")
    for name, checksum in policy["release_code"].items():
        if digest(root / name) != checksum:
            raise ValueError("point publication adapter changed after validation")
    development = Path(policy["development_selection"]).parent
    selection, _, best, candidate, changes = _derived_selection(development)
    if (
        digest(development / "selection.json") != policy["development_selection_sha256"]
        or digest(development / "protocol.json")
        != policy["development_protocol_sha256"]
        or policy["release_adapter_changes"] != changes
        or policy["selected"] != asdict(candidate)
    ):
        raise ValueError("point release selection provenance mismatch")
    historical = _verified_months(
        directory / candidate.name / "months",
        {"identity_sha256": policy["identity_sha256"]},
        candidate,
    )
    spec = policy["spec"]
    if not (
        historical.origin.ge(spec["development_end"])
        & historical.origin.lt(spec["as_of"])
        & historical.label_available_date.lt(spec["as_of"])
        & historical.placement_type.eq("公募")
    ).all():
        raise ValueError("point release historical boundaries differ")
    development_rows = _verified_months(
        development / candidate.name / "months", selection, candidate
    )
    expected = {
        **json.loads(validation_path.read_text()),
        "metrics": _metric_rows(historical, frozen_sigmas(development_rows)),
        "sample_count": historical.bond_code.nunique(),
        "prediction_start": str(pd.to_datetime(historical.origin).min().date()),
        "prediction_end": str(pd.to_datetime(historical.origin).max().date()),
        "point_directory": str(directory),
        "point_protocol_sha256": digest(protocol_path),
        "point_validation_sha256": digest(validation_path),
    }
    if (
        value != expected
        or value["candidate"] != asdict(candidate)
        or value["estimand"] != "huber_center"
        or value["expected_savings_supported"] is not False
        or value["release_policy"] != "user_authorized_best_public_point"
        or value["selected_passed_gates"] != best["gates"]["passed"]
    ):
        raise ValueError("point release evaluation differs from verified evidence")
    return value
