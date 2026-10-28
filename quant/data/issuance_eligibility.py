"""Separate new coupon-setting events from fixed-coupon reopenings."""

import re

import pandas as pd


def _date(value):
    return pd.to_datetime(value, errors="coerce")


def _same_contract(original, reopened):
    """Require multiple independent term fields, not a suffix or forecast error."""
    original_date, new_date = (
        _date(original.get("issue_date")),
        _date(reopened.get("issue_date")),
    )
    maturity = _date(original.get("maturity_date"))
    try:
        coupon_same = float(original["final_coupon_pct"]) == float(
            reopened["final_coupon_pct"]
        )
    except (TypeError, KeyError, ValueError):
        coupon_same = False
    return (
        coupon_same
        and pd.notna(maturity)
        and maturity == _date(reopened.get("maturity_date"))
        and pd.notna(original_date)
        and pd.notna(new_date)
        and original_date < new_date < maturity
        and original.get("issuer_name") == reopened.get("issuer_name")
        and original.get("bond_type") == reopened.get("bond_type")
        and all(
            row.get("interest_rate_type") == "固息"
            for row in (original, reopened)
        )
    )


def issuance_kind_audit(raw):
    """One ledger entry per source event; preserve unverified cases separately."""
    records = raw.to_dict(orient="records")
    by_code = {row["bond_code"]: row for row in records}
    result = []
    for row in records:
        code = row["bond_code"]
        original_code = re.sub(r"X\d*(?=\.(?:SH|SZ)$)", "", code)
        flagged = original_code != code or bool(
            re.search(r"续|增发", str(row.get("short_name") or ""))
        )
        original = by_code.get(original_code) if original_code != code else None
        verified = bool(flagged and original and _same_contract(original, row))
        result.append(
            {
                "bond_code": code,
                "issuance_kind": "fixed_coupon_reopening"
                if verified
                else "unverified_reopening"
                if flagged
                else "new_coupon",
                "original_bond_code": original_code if flagged else None,
                "eligibility_basis": "same issuer, fixed coupon, maturity and older original event"
                if verified
                else "requires independent term review"
                if flagged
                else "no reopening indicator in source metadata",
            }
        )
    return pd.DataFrame(result, index=raw.index)
