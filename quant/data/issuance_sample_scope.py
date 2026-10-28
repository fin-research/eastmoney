"""Explicit coupon population; retain raw inputs and filter every bond history."""

from .curve_grid import decode_curve_inputs


def scoped_coupon_inputs(inputs):
    inputs = decode_curve_inputs(inputs)
    scope = inputs.get("issuance_scope", "all")
    if scope not in ("all", "public_only"):
        raise ValueError("unsupported issuance scope")
    if scope == "all":
        return inputs, {"issuance_scope": scope}
    datasets = inputs["datasets"]
    raw = datasets["bond_issuance"]
    public = [r for r in raw if r.get("placement_type") == "公募"]
    codes = {r["bond_code"].upper() for r in public}
    filtered = {
        **datasets,
        "bond_issuance": public,
        "issue": [r for r in datasets["issue"] if r["entity_key"].upper() in codes],
    }
    if "issuer_daily" in datasets:
        filtered["issuer_daily"] = [
            r for r in datasets["issuer_daily"] if r.get("placement_type") == "公募"
        ]
    audit = {
        "issuance_scope": scope,
        "source_raw_events": len(raw),
        "source_public_events": len(public),
        "scope_excluded_private_events": sum(
            r.get("placement_type") == "私募" for r in raw
        ),
        "scope_excluded_unknown_events": sum(
            r.get("placement_type") not in ("公募", "私募") for r in raw
        ),
        "scope_excluded_secondary_rows": len(datasets.get("issuer_daily", []))
        - len(filtered.get("issuer_daily", [])),
    }
    return {**inputs, "datasets": filtered}, audit
