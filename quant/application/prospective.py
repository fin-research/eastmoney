"""Offline request-first registry and coverage audit, with no trusted time anchor."""

import calendar
from contextlib import contextmanager
from datetime import date
import fcntl
import json
import os
from pathlib import Path
import subprocess

from data.prospective_ledger import now
from model import prospective_protocol as contract
from research_sources import ROOT, runtime_identity, source_hashes


def _one(events, kind, digest=None):
    rows = [
        row
        for row in events
        if row["kind"] == kind and (digest is None or row["payload_sha256"] == digest)
    ]
    contract.require(len(rows) == 1, "Unique registered " + kind + " required")
    return rows[0]


def _protocol(ledger):
    value = contract.validate_protocol(_one(ledger.events(), "protocol")["payload"])
    contract.require(
        value["sources"] == source_hashes() and value["runtime"] == runtime_identity(),
        "Registry source or runtime changed; register a new study",
    )
    return value


def initialize(ledger, study_id, candidate):
    value = contract.protocol(study_id, candidate, source_hashes(), runtime_identity())
    return ledger.append("protocol", "protocol", value)


def register_scheme(ledger, value, source_bytes):
    _protocol(ledger)
    contract.scheme(value)
    contract.require(
        contract.checksum(source_bytes) == value["source_sha256"],
        "Scheme source byte mismatch",
    )

    def validate(events):
        previous = [
            row
            for row in events
            if row["kind"] == "scheme"
            and row["payload"]["scheme_id"] == value["scheme_id"]
        ]
        latest = previous[-1] if previous else None
        contract.require(
            value["version"] == (latest["payload"]["version"] + 1 if latest else 1)
            and value["parent_sha256"]
            == (latest["payload_sha256"] if latest else None),
            "Scheme revision must extend the current registered parent",
        )

    return ledger.append(
        "scheme",
        f"scheme:{value['scheme_id']}:{value['version']}",
        value,
        [source_bytes],
        validate,
    )


def register_batch(ledger, value):
    _protocol(ledger)
    contract.batch(value)

    def validate(events):
        for request in value["requests"]:
            _one(events, "scheme", request["scheme_sha256"])
        seen = {
            request["request_id"]
            for row in events
            if row["kind"] == "batch"
            for request in row["payload"]["requests"]
        }
        contract.require(
            not seen.intersection(row["request_id"] for row in value["requests"]),
            "Request identities cannot be reused across batches",
        )

    return ledger.append(
        "batch", "batch:" + value["batch_id"], value, validate=validate
    )


@contextmanager
def _execution_lock(ledger, request_id):
    key = contract.checksum(request_id.encode())
    fd = os.open(
        ledger.directory / (".execution-" + key),
        os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW,
        0o600,
    )
    with os.fdopen(fd, "a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def _bundle(directory, expected, expected_method, origin, expected_calendar, artifacts):
    directory = Path(directory)
    manifest_bytes = (directory / "manifest.json").read_bytes()
    artifacts.append(manifest_bytes)
    contract.require(
        contract.checksum(manifest_bytes) == expected, "Manifest byte identity mismatch"
    )
    manifest = json.loads(manifest_bytes)
    contract.require(
        contract.checksum(contract.encoded(manifest["calendar"])) == expected_calendar,
        "Registered shared calendar mismatch",
    )
    contract.require(
        set(manifest["models"]) == {"main"}, "Single coupon model required"
    )
    entry = manifest["models"]["main"]
    contract.require(
        Path(entry["file"]).name == entry["file"] and entry["file"] not in (".", ".."),
        "Model filename outside bundle",
    )
    model_bytes = (directory / entry["file"]).read_bytes()
    artifacts.append(model_bytes)
    contract.require(
        contract.checksum(model_bytes) == entry["sha256"], "Model checksum mismatch"
    )
    model = json.loads(model_bytes)
    contract.require(model["candidate"] == expected_method, "Frozen method mismatch")
    first = origin[:7] + "-01"
    last = (
        origin[:7] + f"-{calendar.monthrange(int(origin[:4]), int(origin[5:7]))[1]:02d}"
    )
    contract.require(
        manifest["training_as_of"] == first and manifest["retrain_after"] == last,
        "Monthly training or validity rule mismatch",
    )
    return manifest, model


def _infer(manifest, model, inputs, scheme, window, input_sha256):
    request = {
        "terms": scheme["terms"],
        "window_days": window,
        "issue_size_yi": scheme["issue_size_yi"],
    }
    transport = contract.encoded(
        {"manifest": manifest, "model": model, "inputs": inputs, "request": request}
    )
    process = subprocess.run(
        ["node", str(ROOT / "online/prospective-infer.mjs")],
        input=transport,
        capture_output=True,
        timeout=120,
        cwd=ROOT,
    )
    contract.require(
        process.returncode == 0, "Inference rejected: " + process.stderr.decode()[:1024]
    )
    result = json.loads(process.stdout)
    contract.require(
        result["terms"] == scheme["terms"]
        and result["window_days"] == window
        and result["issue_size_yi"] == scheme["issue_size_yi"]
        and result["as_of_date"] == inputs["as_of_date"]
        and result["online_run"]["model_version"] == manifest["model_version"],
        "Prediction binding mismatch",
    )
    result["online_run"]["input_sha256"] = input_sha256
    return contract.encoded(result), result


def predict(
    ledger, batch_id, request_id, control_directory, candidate_directory, input_file
):
    protocol = _protocol(ledger)
    contract.identifier(batch_id)
    contract.identifier(request_id)
    with _execution_lock(ledger, request_id):
        events = ledger.events()
        batch = next((row for row in events if row["key"] == "batch:" + batch_id), None)
        contract.require(
            batch is not None, "Expected request batch must be registered first"
        )
        rows = [
            row
            for row in batch["payload"]["requests"]
            if row["request_id"] == request_id
        ]
        contract.require(len(rows) == 1, "Request not in registered denominator")
        expected = rows[0]
        existing = next(
            (row for row in events if row["key"] == "outcome:" + request_id), None
        )
        if existing:
            return existing
        interrupted = next(
            (row for row in events if row["key"] == "attempt:" + request_id), None
        )
        if interrupted:
            return ledger.append(
                "outcome",
                "outcome:" + request_id,
                {
                    "request_id": request_id,
                    "batch_sha256": batch["payload_sha256"],
                    "scheme_sha256": expected["scheme_sha256"],
                    "status": "interrupted_unknown",
                    "roles": {},
                    "forward_eligible": False,
                    "time_anchor": "local_unanchored",
                    "attempt_sha256": interrupted["event_sha256"],
                },
            )
        scheme_event = _one(events, "scheme", expected["scheme_sha256"])
        scheme = scheme_event["payload"]
        ledger.append(
            "attempt",
            "attempt:" + request_id,
            {"batch_sha256": batch["payload_sha256"], "request": expected},
        )
        started = now()
        payload = {
            "request_id": request_id,
            "batch_sha256": batch["payload_sha256"],
            "scheme_sha256": expected["scheme_sha256"],
            "origin_date": batch["payload"]["origin_date"],
            "execution_started_at": started,
            "roles": {},
            "forward_eligible": False,
            "time_anchor": "local_unanchored",
        }
        attachments = []
        try:
            input_bytes = Path(input_file).read_bytes()
            attachments.append(input_bytes)
            payload["attempted_input_sha256"] = contract.checksum(input_bytes)
            contract.require(
                contract.checksum(input_bytes) == expected["input_sha256"],
                "Input byte identity mismatch",
            )
            inputs = json.loads(input_bytes)
            contract.require(
                inputs["as_of_date"] == payload["origin_date"], "Input origin mismatch"
            )
            for role, directory in (
                ("control", control_directory),
                ("candidate", candidate_directory),
            ):
                try:
                    manifest, model = _bundle(
                        directory,
                        expected[role + "_manifest_sha256"],
                        protocol[role + "_method"],
                        payload["origin_date"],
                        expected["calendar_sha256"],
                        attachments,
                    )
                    result_bytes, result = _infer(
                        manifest,
                        model,
                        inputs,
                        scheme,
                        expected["window_days"],
                        expected["input_sha256"],
                    )
                    attachments.extend(
                        [contract.encoded(manifest["calendar"]), result_bytes]
                    )
                    payload["roles"][role] = {
                        "status": "success",
                        "result_sha256": contract.checksum(result_bytes),
                        "calendar_sha256": contract.checksum(
                            contract.encoded(manifest["calendar"])
                        ),
                        "model_version": result["online_run"]["model_version"],
                    }
                except (
                    ValueError,
                    KeyError,
                    OSError,
                    subprocess.SubprocessError,
                ) as error:
                    payload["roles"][role] = {
                        "status": "failed",
                        "reason": str(error)[:2048],
                    }
        except (ValueError, KeyError, OSError) as error:
            payload["roles"] = {
                role: {"status": "failed", "reason": str(error)[:2048]}
                for role in ("control", "candidate")
            }
        finished = now()
        payload["execution_finished_at"] = finished
        payload["origin_status"] = (
            "current_day"
            if all(
                contract.shanghai_date(value) == payload["origin_date"]
                for value in (
                    started,
                    finished,
                )
            )
            and batch["committed_at"] <= started
            and scheme_event["committed_at"] <= started
            else "replay_or_late"
        )
        payload["status"] = (
            "paired_success"
            if all(row["status"] == "success" for row in payload["roles"].values())
            else "failed"
        )
        payload["input_sha256"] = expected["input_sha256"]
        return ledger.append("outcome", "outcome:" + request_id, payload, attachments)


def register_synthetic_label(ledger, value):
    _protocol(ledger)
    contract.synthetic_label(value)
    return ledger.append(
        "synthetic-label",
        "synthetic-label:" + contract.checksum(contract.encoded(value)),
        value,
    )


def cancel_scheme(ledger, digest):
    _protocol(ledger)
    _one(ledger.events(), "scheme", digest)
    return ledger.append("cancel", "cancel:" + digest, {"scheme_sha256": digest})


def audit_registry(ledger):
    integrity = ledger.audit()
    _protocol(ledger)
    events = ledger.events()
    outcomes = {
        row["payload"]["request_id"]: row for row in events if row["kind"] == "outcome"
    }
    labels = [
        {**row["payload"], "registration_sequence": row["sequence"]}
        for row in events
        if row["kind"] == "synthetic-label"
    ]
    cancelled = {
        row["payload"]["scheme_sha256"] for row in events if row["kind"] == "cancel"
    }
    parents = {
        row["payload"]["parent_sha256"] for row in events if row["kind"] == "scheme"
    }
    attempts = {
        row["payload"]["request"]["request_id"]
        for row in events
        if row["kind"] == "attempt"
    }
    rows, selected = [], set()
    for batch in (row for row in events if row["kind"] == "batch"):
        for request in batch["payload"]["requests"]:
            scheme = _one(events, "scheme", request["scheme_sha256"])["payload"]
            outcome = outcomes.get(request["request_id"])
            row = {
                "request_id": request["request_id"],
                "batch_id": batch["payload"]["batch_id"],
                "scheme_sha256": request["scheme_sha256"],
                "status": (
                    "interrupted_unknown"
                    if request["request_id"] in attempts
                    else "not_executed"
                )
                if outcome is None
                else outcome["payload"]["status"],
                "forward_eligible": False,
                "synthetic_h30_point_available": False,
                "outcome_sequence": outcome["sequence"] if outcome else None,
            }
            row["origin_date"] = batch["payload"]["origin_date"]
            identity = scheme["bond_identity"]
            row["registered_event"] = (
                contract.encoded(identity).decode() if identity else None
            )
            row["_match"] = (scheme, request, outcome)
            rows.append(row)
    # Fixed selection uses submission order, never prediction errors or batch file order.
    for row in sorted(rows, key=lambda item: item["outcome_sequence"] or float("inf")):
        if row["status"] == "paired_success":
            key = (row["registered_event"], row["origin_date"])
            if row["registered_event"] is None:
                row["status"] = "unresolved_identity"
                continue
            if key in selected:
                row["status"] = "duplicate_event_origin"
            else:
                selected.add(key)
                scheme, request, outcome = row["_match"]
                _audit_match(
                    ledger, row, scheme, request, outcome, labels, cancelled, parents
                )
    for row in rows:
        del row["_match"]
    return {
        "kind": "local-prospective-coverage-audit",
        "integrity": integrity,
        "expected_requests": len(rows),
        "executed_requests": len(attempts),
        "paired_successes": sum(
            row["payload"]["status"] == "paired_success" for row in outcomes.values()
        ),
        "synthetic_h30_events": sum(
            row["synthetic_h30_point_available"] for row in rows
        ),
        "eligible_forward_events": 0,
        "expected_universe": "registered batches only; independent business dispatch completeness unverified",
        "time_anchor": "local_unanchored",
        "rows": rows,
    }


def _audit_match(ledger, row, scheme, request, outcome, labels, cancelled, parents):
    state = _scheme_state(request["scheme_sha256"], cancelled, parents)
    if state:
        row["status"] = state
        return
    identity = scheme["bond_identity"]
    if identity is None:
        row["status"] = "unresolved_identity"
        return
    matched = [
        label
        for label in labels
        if label["code"] == identity["code"]
        and label["original_issue_date"] == identity["original_issue_date"]
    ]
    if not matched:
        row["status"] = "synthetic_label_pending"
        return
    if len(matched) != 1:
        row["status"] = "synthetic_label_ambiguous"
        return
    label, payload = matched[0], outcome["payload"]
    if label["registration_sequence"] <= outcome["sequence"]:
        row["status"] = "known_synthetic_label_replay"
        return
    origin = contract.shanghai_date(payload["execution_started_at"])
    row["origin_date"] = origin
    row["synthetic_event"] = identity["code"] + ":" + identity["original_issue_date"]
    if (
        payload["origin_status"] != "current_day"
        or contract.shanghai_date(outcome["committed_at"]) != origin
    ):
        row["status"] = "replay_or_late"
        return
    if (
        date.fromisoformat(label["pricing_date"]) - date.fromisoformat(origin)
    ).days != 30:
        row["status"] = "outside_h30"
        return
    if (
        not scheme["planned_pricing"]["start"]
        <= label["pricing_date"]
        <= scheme["planned_pricing"]["end"]
    ):
        row["status"] = "outside_plan"
        return
    if not _exact_points(ledger, payload, label["pricing_date"]):
        row["status"] = "exact_pricing_point_unavailable"
        return
    row["status"] = "synthetic_h30_local_unanchored"
    row["synthetic_h30_point_available"] = True


def _scheme_state(digest, cancelled, parents):
    if digest in cancelled:
        return "cancelled"
    return "conditions_changed" if digest in parents else None


def _exact_points(ledger, payload, pricing_date):
    return all(
        sum(
            point["date"] == pricing_date
            for point in json.loads(ledger.object(role["result_sha256"]))["forecast"]
        )
        == 1
        for role in payload["roles"].values()
    )
