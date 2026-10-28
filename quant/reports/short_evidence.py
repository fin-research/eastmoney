"""Validate safe aggregate evidence without loading training dependencies."""

import math


def _validate_tree_increment(result):
    increment = result["raw_history_increment"]
    comparisons = {row["name"]: row for row in result["comparison"]}
    tree = comparisons[increment["candidate"]]
    raw = comparisons[increment["reference"]]
    common = {
        "target": "coupon",
        "years": 3,
        "feature_set": "quote_history",
        "lead_policy": "uniform",
        "market_change": "none",
    }
    if (
        increment["candidate"] != "lgb_coupon_3y_2_quote_history"
        or increment["reference"] != "ridge_coupon_3y_0_quote_history"
        or tree["candidate"] != {**common, "kind": "lgb", "profile": 2}
        or raw["candidate"] != {**common, "kind": "ridge", "profile": 0}
    ):
        raise ValueError("raw-tree paired learning schemes differ")
    for period in ("development", "historical"):
        rows = increment["periods"][period]
        if [row["lead_days"] for row in rows] != [1, 14, 30]:
            raise ValueError("raw-tree paired horizons differ")
        for delta, a, b in zip(rows, tree[period], raw[period], strict=True):
            if delta["samples"] != a["samples"] or not math.isclose(
                delta["mae_delta_bp"], a["mae_bp"] - b["mae_bp"], abs_tol=1e-10
            ):
                raise ValueError(
                    "raw-tree paired denominator or MAE difference differs"
                )


def _validate_study(value):
    result = value["evaluation"]
    representation = result.get("representation", "raw")
    expected_candidates = {
        "raw": 3,
        "curve_pca3": 4,
        "product_quote": 4,
        "primary_batch": 4,
        "raw_tree": 4,
    }.get(representation)
    if (
        value["schema_version"] != 1
        or result["forecast_horizons"] != [1, 14, 30]
        or result["expected_savings_supported"] is not False
        or result["release_policy"] != "short_coupon_prediction"
        or expected_candidates is None
        or len(result["comparison"]) != expected_candidates
        or len({row["name"] for row in result["comparison"]}) != expected_candidates
    ):
        raise ValueError("short-coupon aggregate contract differs")
    baseline = result["valuation_baseline"]
    for period in ("development", "historical"):
        expected = baseline[period]
        if [r["lead_days"] for r in expected] != [1, 14, 30]:
            raise ValueError("short-coupon horizons are incomplete")
        for candidate in result["comparison"]:
            rows = candidate[period]
            if [r["lead_days"] for r in rows] != [1, 14, 30]:
                raise ValueError("short-coupon horizons are incomplete")
            for metric, reference in zip(rows, expected, strict=True):
                if (
                    metric["requested"] != reference["requested"]
                    or metric["samples"] != metric["requested"]
                    or metric["missing"] != 0
                    or any(
                        not math.isfinite(metric[k])
                        for k in ("mae_bp", "rmse_bp", "bias_bp")
                    )
                ):
                    raise ValueError("short-coupon denominators or metrics differ")
    qualified = result["status"] == "qualified_historical_candidate"
    if (
        qualified != (result["candidate"] is not None)
        or qualified != result["recent_acceptance_passed"]
    ):
        raise ValueError("short-coupon qualification status differs")
    if not value.get("protocol_sha256") or not value.get("input_sha256"):
        raise ValueError("short-coupon evidence lacks frozen provenance")


def validate_short_evidence(value):
    _validate_study(value)
    if value["evaluation"].get("representation") == "raw_tree":
        _validate_tree_increment(value["evaluation"])
    for study in value.get("followup_studies", []):
        validate_short_evidence(study)
    if "fixed_pre2026_study" in value:
        _validate_fixed_study(value["fixed_pre2026_study"])


def _validate_fixed_study(study):
    result = study["evaluation"]
    if result["training_label_cutoff"] != "2026-01-01" or study["production_activated"]:
        raise ValueError("fixed validation boundary or activation differs")
    for candidate in result["comparison"]:
        for period in ("tscv", "validation"):
            metrics = candidate[period]
            baseline = result["valuation_baseline"][period]
            if [m["lead_days"] for m in metrics] != [1, 14, 30]:
                raise ValueError("fixed validation horizons are incomplete")
            if any(
                m["requested"] != b["requested"]
                or m["samples"] != m["requested"]
                or m["missing"]
                for m, b in zip(metrics, baseline, strict=True)
            ):
                raise ValueError("fixed validation denominators differ")
        states = study["training"][candidate["name"]]
        final = [s for s in states if s["fold"] == "validation-2026"]
        if len(final) != 1 or final[0]["audit"]["training_label_end"] >= "2026-01-01":
            raise ValueError("fixed model contains validation labels")
    if (
        study["quality"]["training_before_2026"]
        != result["folds"][-1]["training_events"]
    ):
        raise ValueError("final training coverage differs")
