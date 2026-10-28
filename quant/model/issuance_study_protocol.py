"""Explicit offline study inputs; immutable protocol and data identities."""

from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import re

import pandas as pd

from data.issuance_industry_tenor import AAA_CURVE_CODE
from .export import write_json
from .issuance_unified import CouponCandidate

STUDY_CANDIDATES = (
    CouponCandidate("lgb", "excess", 5, 0),
    CouponCandidate("lgb", "excess", 5, 2, "combined", "front30"),
    CouponCandidate("lgb", "excess", 5, 2, "weighted_primary", "front30"),
)
STRUCTURAL_CANDIDATES = (
    STUDY_CANDIDATES[0],
    STUDY_CANDIDATES[2],
    CouponCandidate("lgb", "industry_excess", 5, 2, "combined", "front30"),
    CouponCandidate("lgb", "industry_excess", 3, 2, "combined", "front30"),
    CouponCandidate("ridge", "industry_excess", 5, 0, "combined", "front30"),
    CouponCandidate("ridge", "industry_excess", 5, 1, "combined", "front30"),
    CouponCandidate("ridge", "industry_excess", 3, 1, "combined", "front30"),
    CouponCandidate("lgb", "primary_residual", 5, 2, "weighted_primary", "front30"),
    CouponCandidate("ridge", "primary_residual", 5, 1, "weighted_primary", "front30"),
)
ROBUST_CANDIDATES = (
    STUDY_CANDIDATES[0],
    STUDY_CANDIDATES[2],
    *(
        CouponCandidate(
            "ridge", "industry_excess", years, profile, "combined", "front30"
        )
        for years in (3, 5)
        for profile in (2, 3)
    ),
    *(
        CouponCandidate("lgb", "industry_excess", years, profile, "combined", "front30")
        for years in (3, 5)
        for profile in (4, 5)
    ),
)
BASIS_CANDIDATES = (
    STUDY_CANDIDATES[0],
    STUDY_CANDIDATES[2],
    CouponCandidate(
        "lgb", "industry_basis_residual", 5, 2, "industry_basis", "front30"
    ),
    CouponCandidate(
        "ridge", "industry_basis_residual", 5, 1, "industry_basis", "front30"
    ),
)
PUBLIC_CANDIDATES = tuple(
    dict.fromkeys((*STRUCTURAL_CANDIDATES, *ROBUST_CANDIDATES, *BASIS_CANDIDATES))
)
MARKET_CANDIDATES = (
    CouponCandidate("lgb", "industry_excess", 5, 5, "combined", "front30"),
    *(
        CouponCandidate("lgb", "pricing_excess", 5, 5, "combined", "front30", mode)
        for mode in ("zero", "ridge", "centered")
    ),
)
MARKET_TREE_CANDIDATES = (
    *MARKET_CANDIDATES[:2],
    *(
        CouponCandidate("lgb", "pricing_excess", 5, 5, "combined", "front30", mode)
        for mode in ("lgb", "lgb_centered")
    ),
)
MARKET_BALANCED_CANDIDATES = (
    *MARKET_CANDIDATES[:3],
    *(
        CouponCandidate("lgb", "pricing_excess", 5, 5, "combined", "front30", mode)
        for mode in ("balanced", "balanced_half")
    ),
)
MARKET_TENOR_CANDIDATES = (
    *MARKET_CANDIDATES[:3],
    *(
        CouponCandidate("lgb", "pricing_excess", 5, 5, "combined", "front30", mode)
        for mode in ("tenor", "tenor_shape")
    ),
)
KEYS = ["bond_code", "origin", "lead_days"]


def registered_candidates(spec):
    return {
        1: STUDY_CANDIDATES,
        2: STRUCTURAL_CANDIDATES,
        3: ROBUST_CANDIDATES,
        4: BASIS_CANDIDATES,
        5: PUBLIC_CANDIDATES,
        6: MARKET_CANDIDATES,
        7: MARKET_TREE_CANDIDATES,
        8: MARKET_BALANCED_CANDIDATES,
        9: MARKET_TENOR_CANDIDATES,
    }[spec["schema_version"]]


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def immutable_json(path, value):
    """Never relabel an old run with new code, inputs, or configuration."""
    if path.exists():
        if json.loads(path.read_text()) != value:
            raise ValueError(
                "study fingerprint mismatch; use a new experiment directory"
            )
        return
    write_json(path, value)


def _verify_reproduction(path, spec):
    reproduction = spec["reproduction"]
    checksums = (
        "original_spec_sha256",
        "original_protocol_sha256",
        "original_selection_sha256",
        "inventory_sha256",
    )
    if (
        not isinstance(reproduction, dict)
        or reproduction.get("purpose") != "reproduction-under-current-code"
        or not re.fullmatch(r"[0-9a-f]{40}", reproduction.get("source_revision", ""))
        or any(
            not re.fullmatch(r"[0-9a-f]{64}", reproduction.get(key, ""))
            for key in checksums
        )
    ):
        raise ValueError("reproduction requires explicit immutable source provenance")
    from research_sources import runtime_identity, source_hashes

    inventory_path = path.parent / "migration-inventory.json"
    if digest(inventory_path) != reproduction["inventory_sha256"]:
        raise ValueError("reproduction inventory checksum mismatch")
    inventory = json.loads(inventory_path.read_text())
    if (
        inventory["source_revision"] != reproduction["source_revision"]
        or inventory["current_sources"] != source_hashes()
        or inventory["runtime"] != runtime_identity()
        or any(
            digest(record["path"]) != record["sha256"]
            for record in inventory["original_evidence"].values()
        )
    ):
        raise ValueError("reproduction source, runtime or original evidence changed")
    evidence = inventory["original_evidence"]
    for role in ("spec", "protocol", "selection"):
        if evidence[role]["sha256"] != reproduction[f"original_{role}_sha256"]:
            raise ValueError("reproduction original hash linkage mismatch")
    original = json.loads(Path(evidence["spec"]["path"]).read_text())
    protocol = json.loads(Path(evidence["protocol"]["path"]).read_text())
    selection = json.loads(Path(evidence["selection"]["path"]).read_text())
    if (
        original != protocol["spec"]
        or selection["identity_sha256"] != protocol["identity_sha256"]
    ):
        raise ValueError("reproduction original protocol and selection differ")
    # The registered serialization added only the explicit no-market-change default.
    normalized = {**original, "stage": spec["stage"], "nodes_path": spec["nodes_path"]}
    normalized["candidates"] = [
        {**candidate, "market_change": candidate.get("market_change", "none")}
        for candidate in original["candidates"]
    ]
    if {
        key: value for key, value in spec.items() if key != "reproduction"
    } != normalized:
        raise ValueError("reproduction study design differs from original protocol")
    if digest((path.parent / spec["nodes_path"]).resolve()) != original["nodes_sha256"]:
        raise ValueError("reproduction relocated node contents differ")


def load_spec(path, as_of=None):
    path = Path(path).resolve()
    spec = json.loads(path.read_text())
    if "reproduction" in spec:
        _verify_reproduction(path, spec)
    if spec.get("schema_version") not in (1, 2, 3, 4, 5, 6, 7, 8, 9) or spec.get(
        "stage"
    ) not in (
        "smoke",
        "development",
        "historical-report",
    ):
        raise ValueError("unsupported study schema or stage")
    if spec.get("candidates") != [asdict(c) for c in registered_candidates(spec)]:
        raise ValueError("study must register exactly the versioned PLAN candidates")
    if spec["schema_version"] == 5 and (
        spec.get("issuance_scope") != "public_only"
        or spec.get("release_policy") != "user_authorized_best_mean"
    ):
        raise ValueError(
            "public study requires explicit scope and authorized release policy"
        )
    if spec["schema_version"] in (6, 7, 8, 9) and (
        spec.get("issuance_scope") != "public_only"
        or spec.get("release_policy") != "validated_market_separation"
    ):
        raise ValueError("market separation requires public-only frozen protocol")
    dates = [
        pd.Timestamp(spec[key])
        for key in ("development_start", "development_end", "as_of")
    ]
    if not dates[0] < dates[1] < dates[2] or any(d.day != 1 for d in dates[:2]):
        raise ValueError("invalid study boundaries; development uses complete months")
    if as_of is not None and as_of != spec["as_of"]:
        raise ValueError("CLI and study as-of dates differ")
    for key in ("input_sha256", "nodes_sha256"):
        if len(spec.get(key, "")) != 64:
            raise ValueError("study requires frozen input and node SHA256")
    return spec, (path.parent / spec["nodes_path"]).resolve()


def load_study_inputs(snapshot, nodes_path, spec):
    if snapshot is None or digest(snapshot) != spec["input_sha256"]:
        raise ValueError("frozen input SHA256 mismatch")
    if digest(nodes_path) != spec["nodes_sha256"]:
        raise ValueError("industry node SHA256 mismatch")
    inputs = json.loads(Path(snapshot).read_text())
    if inputs["as_of_date"] != spec["as_of"] or "industry_nodes" in inputs["datasets"]:
        raise ValueError("unexpected study input date or duplicate industry nodes")
    nodes = pd.read_csv(nodes_path)
    if nodes.duplicated(["date", "tenor_years"]).any():
        raise ValueError("duplicate industry node")
    old = pd.DataFrame(inputs["datasets"]["industry_curve"])
    joined = nodes.loc[nodes.tenor_years.eq(3), ["date", "yield_pct"]].merge(
        old[["observation_date", "yield_pct"]],
        left_on="date",
        right_on="observation_date",
        validate="one_to_one",
        suffixes=("_new", "_old"),
    )
    if (
        len(joined) != len(old)
        or not joined.yield_pct_new.eq(joined.yield_pct_old).all()
    ):
        raise ValueError("industry nodes disagree with frozen 3Y reference")
    inputs["datasets"]["industry_nodes"] = [
        dict(
            curve_code=AAA_CURVE_CODE,
            observation_date=r.date,
            tenor_years=r.tenor_years,
            yield_pct=r.yield_pct,
        )
        for r in nodes.itertuples(index=False)
    ]
    if spec["schema_version"] in (5, 6, 7, 8, 9):
        inputs["issuance_scope"] = spec["issuance_scope"]
    return inputs


def stage_mask(requests, spec):
    from data.issuance_training import HORIZONS

    start, end = map(pd.Timestamp, (spec["development_start"], spec["development_end"]))
    if spec["stage"] == "historical-report":
        start, end = end, pd.Timestamp(spec["as_of"])
    mask = (
        requests.origin.ge(start)
        & requests.origin.lt(end)
        & requests.label_available_date.lt(end)
        & requests.lead_days.isin(HORIZONS)
    )
    if spec["stage"] == "smoke" and mask.any():
        first = requests.loc[mask, "origin"].min().to_period("M")
        mask &= requests.origin.dt.to_period("M").eq(first)
    if not mask.any():
        raise ValueError("no evaluation events in registered stage")
    return mask


def validate_rows(rows, expected):
    """Reject incomplete, duplicate, nonfinite or label-changing checkpoints."""
    import numpy as np

    if rows.duplicated(KEYS).any() or len(rows) != len(expected):
        raise ValueError("candidate comparison denominator differs")
    actual = rows.copy()
    want = expected.copy()
    for frame in (actual, want):
        frame["origin"] = pd.to_datetime(frame.origin).dt.strftime("%Y-%m-%d")
    merged = actual.merge(
        want[KEYS + ["coupon_bp"]],
        on=KEYS,
        validate="one_to_one",
        suffixes=("", "_expected"),
    )
    if (
        len(merged) != len(expected)
        or not np.isfinite(merged.predicted_bp).all()
        or not merged.coupon_bp.eq(merged.coupon_bp_expected).all()
    ):
        raise ValueError("checkpoint events, labels or predictions differ")
    return actual
