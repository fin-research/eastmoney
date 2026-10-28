"""One auditable qualification row for every source issuance event."""

import numpy as np
import pandas as pd

from .issuance_eligibility import issuance_kind_audit


def issuance_event_ledger(inputs, *, market_start=None):
    raw = pd.DataFrame(inputs["datasets"]["bond_issuance"])
    if raw.bond_code.duplicated().any():
        raise ValueError("duplicate issuance identifiers")
    kinds = issuance_kind_audit(raw)
    pricing_text = raw.tender_date.astype("string")
    pricing = pd.to_datetime(
        pricing_text.where(pricing_text.str.fullmatch(r"\d{4}-\d{2}-\d{2}", na=False)),
        errors="coerce",
    )
    issue = pd.to_datetime(raw.issue_date, errors="coerce")
    tenor = pd.to_numeric(raw.original_tenor_years, errors="coerce")
    coupon = pd.to_numeric(raw.final_coupon_pct, errors="coerce")
    structural = (
        raw.bond_code.str.endswith((".SH", ".SZ"))
        & raw.interest_rate_type.eq("固息")
        & tenor.between(1, 10)
        & raw.bond_type.isin(("证券公司债", "证券公司次级债"))
    )
    dated = pricing.notna() & pricing.le(issue)
    coupon_valid = coupon.gt(0) & coupon.lt(30)
    as_of = pd.Timestamp(inputs["as_of_date"])
    available = pd.concat([pricing, issue], axis=1).max(axis=1).lt(as_of)
    if market_start is None:
        aligned = pd.Series(True, index=raw.index)
    else:
        aligned = pricing.gt(pd.Timestamp(market_start))
    valid = (
        structural
        & dated
        & coupon_valid
        & kinds.issuance_kind.eq("new_coupon")
        & available
        & aligned
    )
    reason = np.select(
        [
            ~structural,
            ~dated,
            ~coupon_valid,
            kinds.issuance_kind.eq("fixed_coupon_reopening"),
            kinds.issuance_kind.eq("unverified_reopening"),
            ~available,
            ~aligned,
        ],
        [
            "outside_product_scope",
            "invalid_pricing_date",
            "invalid_coupon",
            "fixed_coupon_reopening",
            "unverified_reopening",
            "label_not_available",
            "no_prior_market_quote",
        ],
        default="included",
    )
    fields = [
        "bond_code",
        "short_name",
        "issuer_name",
        "bond_type",
        "placement_type",
        "bond_rating",
        "original_tenor_years",
        "issue_amount_100m",
        "tender_date",
        "issue_date",
        "maturity_date",
        "final_coupon_pct",
        "tender_announcement_date",
        "source_last_synced_at",
        "projected_at",
        "source_record_count",
    ]
    result = raw.reindex(columns=fields).copy()
    result["pricing_date_parsed"] = pricing
    result["label_available_proxy_date"] = pd.concat([pricing, issue], axis=1).max(
        axis=1
    )
    result["issuance_kind"] = kinds.issuance_kind
    result["original_bond_code"] = kinds.original_bond_code
    result["eligibility_basis"] = kinds.eligibility_basis
    result["product_scope"] = structural
    result["pricing_date_valid"] = dated
    result["coupon_valid"] = coupon_valid
    result["label_available_before_cutoff"] = available
    result["prior_market_quote"] = aligned
    result["training_eligible"] = valid
    result["evaluation_eligible"] = valid
    result["exclusion_reason"] = reason
    result["history_vintage_verified"] = False
    result["coupon_publication_time_verified"] = False
    result["pricing_date_source_verified"] = False
    return result
