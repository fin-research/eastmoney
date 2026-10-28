"""Registered study orchestration using the existing coupon panel and evaluator."""

from dataclasses import asdict
import hashlib
import json
from pathlib import Path

import pandas as pd

from data.issuance_training import IssuancePanel
from .export import write_json
from .issuance_evaluation import (
    _atomic_csv,
    _best_candidate,
    _fingerprint,
    _monthly_predictions,
)
from .issuance_diagnostics import period_metrics
from .issuance_study_protocol import (
    STUDY_CANDIDATES,
    digest,
    immutable_json,
    load_spec,
    load_study_inputs,
    stage_mask,
    validate_rows,
    registered_candidates,
)
from .issuance_study_report import (
    benchmark_report,
    candidate_report,
    pricing_decomposition,
    structural_report,
)
from .research_resources import bounded_window_research, release_training_memory


def study_identity(panel, spec):
    identity = _fingerprint(
        panel, registered_candidates(spec), pd.Timestamp(spec["as_of"])
    )
    identity["study"] = {
        key: spec[key]
        for key in (
            "schema_version",
            "input_sha256",
            "nodes_sha256",
            "development_start",
            "development_end",
        )
    }
    identity["study"]["issuance_scope"] = spec.get("issuance_scope", "all")
    identity["study"]["release_policy"] = spec.get(
        "release_policy", "development_gates"
    )
    if "reproduction" in spec:
        identity["study"]["reproduction"] = spec["reproduction"]
    return identity


def freeze_protocol(directory, spec, identity, requests=None):
    token = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    value = {
        "identity": identity,
        "identity_sha256": token,
        "spec": spec,
        "evidence_status": "historical conditional forecasts; not forward evidence",
        "resource_limits": {"processes": 1, "threads": 1, "rss_bytes": 2 * 1024**3},
    }
    if requests is not None:
        from .issuance_market_validation import evaluation_manifest

        value["evaluation_manifest"] = evaluation_manifest(requests)
    immutable_json(directory / "protocol.json", value)
    return token


def historical_candidate(spec, spec_path, identity):
    directory = (
        Path(spec_path).resolve().parent / spec["development_directory"]
    ).resolve()
    protocol = json.loads((directory / "protocol.json").read_text())
    selection_path = directory / "selection.json"
    if digest(selection_path) != spec["selection_sha256"]:
        raise ValueError("historical report requires frozen selection SHA256")
    selection = json.loads(selection_path.read_text())
    authorized = spec["schema_version"] in (5, 6, 7, 8, 9)
    required_status = (
        "validated_market_separation"
        if spec["schema_version"] in (6, 7, 8, 9)
        else "user_authorized_best_public_mean"
        if authorized
        else "qualified_for_historical_report"
    )
    if (
        protocol["identity"] != identity
        or protocol["spec"]["stage"] != "development"
        or selection["identity_sha256"] != protocol["identity_sha256"]
        or selection["final_period_touched"]
        or selection["selected"] is None
        or selection.get("status") != required_status
        or selection.get("failures")
    ):
        raise ValueError("no matching qualified frozen development selection")
    matching = [
        r
        for r in selection.get("ranking", [])
        if r["candidate"] == selection["selected"]
        and (authorized or r["gates"]["passed"])
    ]
    if len(matching) != 1 or (
        spec["schema_version"] == 5 and matching[0]["estimand"] != "conditional_mean"
    ):
        raise ValueError("selected candidate did not pass registered selection")
    candidates = registered_candidates(spec)
    chosen = next(c for c in candidates if asdict(c) == selection["selected"])
    control = candidates[1] if spec["schema_version"] >= 2 else candidates[0]
    return tuple(dict.fromkeys((candidates[0], control, chosen)))


def checkpoint_guard(path, created, token, candidate, *, state_required=False):
    receipt = path.with_suffix(".receipt.json")
    value = {
        "identity_sha256": token,
        "candidate": asdict(candidate),
        "predictions_sha256": digest(path),
        "diagnostics_sha256": digest(path.with_suffix(".diagnostics.json")),
    }
    timing = path.with_suffix(".timing.csv")
    if timing.exists():
        value["timing_sha256"] = digest(timing)
    if state_required:
        state = path.with_suffix(".state.json")
        if not state.exists():
            raise ValueError("study checkpoint lacks retained model state")
        value["state_sha256"] = digest(state)
    if not created and not receipt.exists():
        raise ValueError("study checkpoint lacks identity receipt")
    immutable_json(receipt, value)


def run_candidates(
    panel, features, requests, selected, candidates, directory, token, *, timing=False
):
    from functools import partial
    from .issuance_timing_audit import coupon_timing_audit

    results, failures = {}, {}
    for candidate in candidates:
        try:
            rows = _monthly_predictions(
                panel,
                features,
                requests,
                selected,
                candidate,
                directory / candidate.name / "months",
                checkpoint_guard=partial(
                    checkpoint_guard, token=token, candidate=candidate
                ),
                timing_audit=partial(coupon_timing_audit, panel) if timing else None,
            )
            results[candidate.name] = validate_rows(rows, requests.loc[selected])
        except Exception as error:
            failures[candidate.name] = str(error)
            write_json(directory / "failures.json", failures)
            if isinstance(error, MemoryError):
                raise
        write_json(directory / "failures.json", failures)
    return results, failures


def save_development(panel, results, failures, directory, token, spec=None):
    if spec and spec["schema_version"] in (6, 7, 8, 9):
        from .issuance_market_validation import save_market_development

        return save_market_development(
            results, failures, directory, token, registered_candidates(spec)
        )
    candidates = registered_candidates(spec) if spec else STUDY_CANDIDATES
    structural = spec is not None and spec["schema_version"] >= 2
    reference = candidates[1] if structural else candidates[0]
    control = results.get(reference.name)
    rankings = []
    for candidate in candidates:
        rows = results.get(candidate.name)
        if rows is None or control is None:
            continue
        report = (
            structural_report(rows, control, results[candidates[0].name])
            if structural and candidates[0].name in results
            else candidate_report(rows, control)
        )
        report["candidate"] = asdict(candidate)
        report["estimand"] = candidate.estimand
        report["control"] = reference.name
        report["benchmarks"] = benchmark_report(rows)
        write_json(directory / candidate.name / "development-report.json", report)
        _atomic_csv(
            directory / candidate.name / "pricing-diagnostics.csv",
            pricing_decomposition(panel, rows),
        )
        rankings.append(
            {
                "name": candidate.name,
                "candidate": asdict(candidate),
                **report["gates"]["h30"]["candidate"],
                "failure": None,
                "estimand": candidate.estimand,
                "gates": report["gates"],
            }
        )
    controls = {c.name for c in candidates[:2]} if structural else {candidates[0].name}
    eligible = [
        r for r in rankings if r["gates"]["passed"] and r["name"] not in controls
    ]
    authorized = spec is not None and spec["schema_version"] == 5
    if authorized:
        eligible = [r for r in rankings if r["estimand"] == "conditional_mean"]
    best = _best_candidate(eligible) if eligible and not failures else None
    selection = {
        "identity_sha256": token,
        "selected": best["candidate"] if best else None,
        "ranking": rankings,
        "failures": failures,
        "final_period_touched": False,
        "status": "qualified_for_historical_report"
        if best
        else "no_qualified_candidate",
        "selection_rule": "development gates, h30 MAE; within 0.2bp RMSE then simplicity",
        "control": reference.name,
    }
    if authorized:
        selection.update(
            status="user_authorized_best_public_mean"
            if best
            else "incomplete_public_study",
            issuance_scope="public_only",
            release_policy=spec["release_policy"],
            selected_passed_gates=best["gates"]["passed"] if best else False,
            selection_rule="all complete conditional-mean candidates including controls; h30 MAE; within 0.2bp RMSE then simplicity",
        )
    write_json(directory / "selection.json", selection)
    return selection


@bounded_window_research
def run_study(spec_path, snapshot, directory, as_of=None):
    spec, nodes = load_spec(spec_path, as_of)
    inputs = load_study_inputs(snapshot, nodes, spec)
    panel = IssuancePanel.from_inputs(inputs)
    del inputs
    release_training_memory()
    directory = Path(directory)
    identity = study_identity(panel, spec)
    candidates = (
        historical_candidate(spec, spec_path, identity)
        if spec["stage"] == "historical-report"
        else registered_candidates(spec)
    )
    requests = panel.requests(range(91))
    features = panel.features(
        requests,
        include_industry_tenor=True,
        include_curve_dynamics=any(c.uses_curve_dynamics for c in candidates),
        include_weighted_primary=True,
        include_industry_basis=any(c.uses_industry_basis for c in candidates),
    )
    selected = stage_mask(requests, spec)
    if spec["schema_version"] in (6, 7, 8, 9):
        common = (
            requests.pricing_reference_covered & features.industry_aaa_available.eq(1)
        )
        write_json(
            directory / "reference-coverage.json",
            {
                "requested_rows": int(selected.sum()),
                "covered_rows": int((selected & common).sum()),
                "missing_rows": int((selected & ~common).sum()),
                "policy": "common dual-end sector reference for every candidate; omitted rows explicitly audited",
            },
        )
        selected &= common
    token = freeze_protocol(
        directory,
        spec,
        identity,
        requests.loc[selected] if spec["schema_version"] in (6, 7, 8, 9) else None,
    )
    results, failures = run_candidates(
        panel,
        features,
        requests,
        selected,
        candidates,
        directory,
        token,
        timing=spec["schema_version"] >= 2,
    )
    del features
    release_training_memory()
    if spec["schema_version"] >= 2:
        from .issuance_timing_audit import timing_summary

        timing = {
            candidate.name: timing_summary(
                pd.concat(
                    [
                        pd.read_csv(path)
                        for path in sorted(
                            (directory / candidate.name / "months").glob("*.timing.csv")
                        )
                    ],
                    ignore_index=True,
                )
            )
            for candidate in candidates
            if candidate.name in results
        }
        write_json(directory / "timing-report.json", timing)
    if spec["stage"] == "development":
        report = save_development(panel, results, failures, directory, token, spec)
    else:
        report = {
            "stage": spec["stage"],
            "identity_sha256": token,
            "failures": failures,
            "metrics": {
                name: period_metrics(rows, split=spec["stage"])
                for name, rows in results.items()
            },
            "selection_performed": False,
            "production_eligible": False,
        }
        write_json(directory / "report.json", report)
    print(
        json.dumps(
            {
                "stage": spec["stage"],
                "status": report.get("status"),
                "failures": failures,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    if failures:
        raise ValueError("study incomplete; inspect failures.json")
    return report
