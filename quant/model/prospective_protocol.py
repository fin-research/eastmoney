"""Fixed rules for a new local prospective registry; never reinterprets old studies."""

from datetime import date, datetime
import hashlib
import json
import re
from zoneinfo import ZoneInfo

SHANGHAI = ZoneInfo("Asia/Shanghai")
CONTROL = {
    "kind": "lgb",
    "target": "industry_excess",
    "years": 5,
    "profile": 5,
    "feature_set": "combined",
    "lead_policy": "front30",
    "market_change": "none",
}
RULES = {
    "schema_version": 1,
    "kind": "local-prospective-registry",
    "timezone": "Asia/Shanghai",
    "h30": "pricing_date minus actual execution Shanghai date equals 30 natural days",
    "duplicate_rule": "first paired success by outcome commit sequence per event and origin day",
    "matching_rule": "confirmed bond code and original issue date only; otherwise unresolved",
    "scheme_change_rule": "retain versions; changed conditions require separate unresolved review",
    "retraining": "monthly first-day refit; validity ends at same calendar month end",
    "request_denominator": "all requests in independently registered batches, including failures",
    "time_anchor": "local_unanchored; never eligible as independent forward evidence",
    "minimum_pricing_months": 3,
    "minimum_h30_events": 30,
    "bootstrap_seed": 42,
    "bootstrap_repetitions": 2000,
    "expected_savings_supported": False,
    "control_method": CONTROL,
}


def encoded(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()


def checksum(value):
    return hashlib.sha256(value).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def identifier(value):
    require(
        isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value),
        "Invalid registry identifier",
    )
    return value


def sha(value):
    require(
        isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value),
        "Invalid SHA256",
    )
    return value


def iso_date(value):
    require(
        isinstance(value, str) and date.fromisoformat(value).isoformat() == value,
        "Canonical date required",
    )
    return value


def shanghai_date(value):
    timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(timestamp.tzinfo is not None, "Timestamp timezone required")
    return timestamp.astimezone(SHANGHAI).date().isoformat()


def method(value):
    require(
        isinstance(value, dict) and set(value) == set(CONTROL),
        "Explicit candidate method required",
    )
    encoded(value)
    return value


def protocol(study_id, candidate_method, sources, runtime):
    return {
        **RULES,
        "study_id": identifier(study_id),
        "candidate_method": method(candidate_method),
        "sources": sources,
        "runtime": runtime,
    }


def validate_protocol(value):
    require(
        set(value)
        == set(RULES) | {"study_id", "candidate_method", "sources", "runtime"},
        "Unexpected registry protocol",
    )
    require(
        all(value[key] == expected for key, expected in RULES.items()),
        "Frozen rule mismatch",
    )
    identifier(value["study_id"])
    method(value["candidate_method"])
    require(
        isinstance(value["sources"], dict) and value["sources"],
        "Source closure required",
    )
    for digest in value["sources"].values():
        sha(digest)
    require(
        isinstance(value["runtime"], dict) and value["runtime"],
        "Runtime identity required",
    )
    return value


def scheme(value):
    require(
        set(value)
        == {
            "scheme_id",
            "version",
            "parent_sha256",
            "issuer_id",
            "terms",
            "issue_size_yi",
            "bond_identity",
            "planned_pricing",
            "source_sha256",
        },
        "Unexpected scheme fields",
    )
    identifier(value["scheme_id"])
    identifier(value["issuer_id"])
    require(
        type(value["version"]) is int and value["version"] >= 1,
        "Invalid scheme version",
    )
    require(
        (value["version"] == 1) == (value["parent_sha256"] is None),
        "Scheme parent required",
    )
    if value["parent_sha256"] is not None:
        sha(value["parent_sha256"])
    sha(value["source_sha256"])
    terms = value["terms"]
    require(
        isinstance(terms, dict)
        and set(terms) == {"issuer", "rating", "tenor", "bond_type", "placement_type"},
        "All scheme conditions must be explicit",
    )
    for name in ("issuer", "rating", "bond_type", "placement_type"):
        require(
            isinstance(terms[name], str) and 0 < len(terms[name].strip()) <= 256,
            "Invalid scheme text",
        )
    require(
        terms["bond_type"] in ("证券公司债", "证券公司次级债"),
        "Unsupported scheme structure",
    )
    require(terms["placement_type"] in ("公募", "私募"), "Confirmed placement required")
    require(
        type(terms["tenor"]) in (int, float) and 1 <= terms["tenor"] <= 10,
        "Invalid tenor",
    )
    require(
        type(value["issue_size_yi"]) in (int, float) and value["issue_size_yi"] > 0,
        "Invalid issuance size",
    )
    identity = value["bond_identity"]
    if identity is not None:
        require(
            set(identity) == {"code", "original_issue_date"}
            and isinstance(identity["code"], str)
            and re.fullmatch(r"[A-Z0-9._-]{1,64}", identity["code"]),
            "Invalid confirmed bond identity",
        )
        iso_date(identity["original_issue_date"])
    interval = value["planned_pricing"]
    require(
        set(interval) == {"start", "end"}, "Explicit planned pricing interval required"
    )
    require(
        iso_date(interval["start"]) <= iso_date(interval["end"]),
        "Invalid planned pricing interval",
    )
    encoded(value)
    return value


def batch(value):
    require(
        set(value) == {"batch_id", "origin_date", "requests"},
        "Unexpected request batch",
    )
    identifier(value["batch_id"])
    iso_date(value["origin_date"])
    requests = value["requests"]
    require(
        isinstance(requests, list) and 0 < len(requests) <= 4096,
        "Finite expected request set required",
    )
    ids = []
    for row in requests:
        require(
            set(row)
            == {
                "request_id",
                "scheme_sha256",
                "control_manifest_sha256",
                "candidate_manifest_sha256",
                "calendar_sha256",
                "input_sha256",
                "window_days",
            },
            "Unexpected expected request",
        )
        ids.append(identifier(row["request_id"]))
        for name in (
            "scheme_sha256",
            "control_manifest_sha256",
            "candidate_manifest_sha256",
            "calendar_sha256",
            "input_sha256",
        ):
            sha(row[name])
        require(
            type(row["window_days"]) is int and row["window_days"] in (30, 60, 90),
            "Invalid window",
        )
    require(len(set(ids)) == len(ids), "Duplicate expected request identity")
    return value


def synthetic_label(value):
    require(
        set(value)
        == {"kind", "code", "original_issue_date", "pricing_date", "coupon_percent"}
        and value["kind"] == "synthetic-label",
        "Only explicit synthetic labels supported",
    )
    require(
        isinstance(value["code"], str)
        and re.fullmatch(r"[A-Z0-9._-]{1,64}", value["code"]),
        "Invalid label code",
    )
    require(
        iso_date(value["pricing_date"]) <= iso_date(value["original_issue_date"]),
        "Pricing after issuance",
    )
    require(
        type(value["coupon_percent"]) in (int, float)
        and 0 < value["coupon_percent"] < 100,
        "Invalid synthetic coupon",
    )
    return value
