"""Frozen three-horizon evaluation of regressions learned from raw quotes."""

from dataclasses import asdict, replace
from functools import partial
import json
from pathlib import Path
from io import StringIO

import numpy as np
import pandas as pd

from artifacts import write_json
from data.coupon_quotes import QUOTE_COLUMNS
from research_sources import source_hashes, runtime_identity
from .issuance_unified import CouponCandidate
from .issuance_evaluation import (
    coupon_metrics,
    _atomic_csv,
    _fingerprint,
    _prediction_window,
)
from .research_resources import bounded_window_research, release_training_memory
from .issuance_study import checkpoint_guard
from .issuance_study_protocol import digest, immutable_json, validate_rows

SHORT_HORIZONS = (1, 14, 30)
CONTROL = CouponCandidate("lgb", "industry_excess", 5, 5, "combined", "front30")
SELECTION = {
    "period": "origin and available label before 2026-01-01",
    "rank": "equal mean of three horizon MAEs; name breaks exact ties",
    "eligibility": "raw-history candidates only; static regression is an ablation control",
    "gates": "aggregate MAE strictly below valuation, static regression and original Huber; each horizon MAE no worse than original Huber",
    "recent_acceptance": "2026 aggregate MAE strictly below valuation and original Huber; each horizon MAE no worse than original Huber",
    "failure": "no qualified candidate; do not release",
}


def short_candidates(representation="raw"):
    candidates = (
        CouponCandidate("ridge", "coupon", 3, 0, "quote_static"),
        CouponCandidate("ridge", "coupon", 3, 0, "quote_history"),
    )
    if representation == "raw":
        return candidates
    if representation == "raw_tree":
        return (*candidates, CouponCandidate("lgb", "coupon", 3, 2, "quote_history"))
    if representation == "curve_pca3":
        return (*candidates, CouponCandidate("ridge", "coupon", 3, 0, "quote_pca"))
    if representation == "product_quote":
        return (*candidates, CouponCandidate("ridge", "coupon", 3, 0, "quote_product"))
    if representation == "primary_batch":
        return (
            *candidates,
            CouponCandidate("ridge", "coupon", 3, 0, "quote_primary_batch"),
        )
    raise ValueError("unknown short-coupon representation study")


def horizon_metrics(rows):
    return [
        {"lead_days": int(h), **coupon_metrics(g)} for h, g in rows.groupby("lead_days")
    ]


def _periods(rows):
    origin = pd.to_datetime(rows.origin)
    available = pd.to_datetime(rows.label_available_date)
    return (
        rows.loc[(origin < "2026-01-01") & (available < "2026-01-01")],
        rows.loc[origin >= "2026-01-01"],
    )


def _comparison(candidate, rows, representation="raw"):
    dev, historical = _periods(rows)
    metrics = horizon_metrics(dev)
    if [r["lead_days"] for r in metrics] != list(SHORT_HORIZONS):
        raise ValueError("three complete development horizons required")
    return {
        "name": candidate.name,
        "candidate": asdict(candidate),
        "selection_score": float(np.mean([r["mae_bp"] for r in metrics])),
        "development": metrics,
        "historical": horizon_metrics(historical),
        "control_only": candidate != short_candidates(representation)[-1],
    }


def quote_coverage(expected):
    result = []
    for period, rows in zip(
        ("development", "historical"), _periods(expected), strict=True
    ):
        for lead, group in rows.groupby("lead_days"):
            result.append(
                {
                    "period": period,
                    "lead_days": int(lead),
                    "requested": len(group),
                    "sector_current": int(group.sector_quote_lag_0_bp.notna().sum()),
                    "issuer_current": int(group.issuer_quote_lag_0_bp.notna().sum()),
                    "complete_history": int(
                        group[list(QUOTE_COLUMNS)].notna().all(axis=1).sum()
                    ),
                }
            )
    return result


def _tree_increment(predictions, expected):
    """Paired descriptive differences; do not change the original release gates."""
    tree = short_candidates("raw_tree")[-1]
    raw = short_candidates()[1]
    keys = ["bond_code", "origin", "lead_days"]
    a = validate_rows(predictions[tree.name], expected)
    b = validate_rows(predictions[raw.name], expected)
    paired = a.merge(
        b[keys + ["predicted_bp"]],
        on=keys,
        validate="one_to_one",
        suffixes=("", "_raw"),
    )
    paired["absolute_error_delta_bp"] = (
        paired.coupon_bp - paired.predicted_bp
    ).abs() - (paired.coupon_bp - paired.predicted_bp_raw).abs()
    return {
        "candidate": tree.name,
        "reference": raw.name,
        "interpretation": "negative paired mean absolute-error difference favors tree; descriptive observed history only",
        "periods": {
            period: [
                {
                    "lead_days": int(h),
                    "samples": len(group),
                    "mae_delta_bp": float(group.absolute_error_delta_bp.mean()),
                }
                for h, group in rows.groupby("lead_days")
            ]
            for period, rows in zip(
                ("development", "historical"), _periods(paired), strict=True
            )
        },
    }


def summarize_short(predictions, expected, token, scope, representation="raw"):
    """Reconstruct selection and reported metrics from complete paired evidence."""
    if not np.isfinite(expected.valuation_bp).all():
        raise ValueError(
            "valuation baseline must cover the complete comparison denominator"
        )
    candidates = (*short_candidates(representation), CONTROL)
    comparisons = []
    for candidate in candidates:
        rows = validate_rows(predictions[candidate.name], expected)
        comparisons.append(_comparison(candidate, rows, representation))
    baseline = expected.assign(predicted_bp=expected.valuation_bp)
    baseline_dev, baseline_hist = _periods(baseline)
    baseline_metrics = {
        "development": horizon_metrics(baseline_dev),
        "historical": horizon_metrics(baseline_hist),
    }
    references = [comparisons[0], comparisons[-1]]
    reference_scores = [r["selection_score"] for r in references]
    reference_scores.append(
        float(np.mean([r["mae_bp"] for r in baseline_metrics["development"]]))
    )
    old_by_h = {r["lead_days"]: r["mae_bp"] for r in comparisons[-1]["development"]}
    for row in comparisons:
        row["qualified"] = (
            not row["control_only"]
            and all(row["selection_score"] < score for score in reference_scores)
            and all(m["mae_bp"] <= old_by_h[m["lead_days"]] for m in row["development"])
        )
    qualified = [r for r in comparisons if r["qualified"]]
    chosen = (
        min(qualified, key=lambda r: (r["selection_score"], r["name"]))
        if qualified
        else None
    )
    recent = {
        r["name"]: {m["lead_days"]: m["mae_bp"] for m in r["historical"]}
        for r in comparisons
    }
    old_recent = recent[CONTROL.name]
    base_recent = {m["lead_days"]: m["mae_bp"] for m in baseline_metrics["historical"]}
    recent_passed = bool(chosen) and (
        set(recent[chosen["name"]]) == set(SHORT_HORIZONS)
        and all(recent[chosen["name"]][h] <= old_recent[h] for h in SHORT_HORIZONS)
        and np.mean(list(recent[chosen["name"]].values()))
        < np.mean(list(old_recent.values()))
        and np.mean(list(recent[chosen["name"]].values()))
        < np.mean(list(base_recent.values()))
    )
    final = _periods(predictions[chosen["name"]])[1] if chosen else expected.iloc[:0]
    metrics = [
        {"lead_days": int(h), "year": int(year), **coupon_metrics(group)}
        for (h, year), group in final.groupby(
            ["lead_days", pd.to_datetime(final.pricing_date).dt.year]
        )
    ]
    return {
        **({"representation": representation} if representation != "raw" else {}),
        **(
            {"raw_history_increment": _tree_increment(predictions, expected)}
            if representation == "raw_tree"
            else {}
        ),
        "candidate": chosen["candidate"] if chosen and recent_passed else None,
        "development_selected": chosen["candidate"] if chosen else None,
        "recent_acceptance_passed": bool(recent_passed),
        "issuance_scope": scope,
        "estimand": "conditional_mean",
        "expected_savings_supported": False,
        "release_policy": "short_coupon_prediction",
        "forecast_horizons": list(SHORT_HORIZONS),
        "sample_count": int(expected.bond_code.nunique()),
        "boundary_excluded_rows": int(
            (
                (pd.to_datetime(expected.origin) < "2026-01-01")
                & (pd.to_datetime(expected.label_available_date) >= "2026-01-01")
            ).sum()
        ),
        "prediction_start": str(pd.to_datetime(expected.pricing_date).min().date()),
        "prediction_end": str(pd.to_datetime(expected.pricing_date).max().date()),
        "metrics": metrics,
        "quote_coverage": quote_coverage(expected),
        "comparison": comparisons,
        "valuation_baseline": baseline_metrics,
        "status": "qualified_historical_candidate"
        if chosen and recent_passed
        else "no_qualified_candidate",
        "evidence_status": "previously observed conditional forecasts; not independent forward evidence",
        "protocol_sha256": token,
    }


def _expected(directory, identity):
    path = directory / "expected-events.csv"
    if digest(path) != identity["expected_sha256"]:
        raise ValueError("short-coupon expected events changed")
    return pd.read_csv(path)


def load_short_release(path):
    path = Path(path)
    result = json.loads(path.read_text())
    protocol = path.parent / "protocol.json"
    identity = json.loads(protocol.read_text())
    token = digest(protocol)
    if (
        identity["sources"] != source_hashes()
        or identity["runtime"] != runtime_identity()
    ):
        raise ValueError("short-coupon release does not match frozen source/evidence")
    expected = _expected(path.parent, identity)
    if identity.get("schema_version") == "fixed-pre2026-v1":
        return _load_fixed_release(path, result, identity, expected, token)
    representation = identity.get("representation", "raw")
    predictions = {}
    months = set(pd.to_datetime(expected.origin).dt.strftime("%Y-%m"))
    for candidate in (*short_candidates(representation), CONTROL):
        paths = sorted((path.parent / candidate.name).glob("*.csv"))
        if {p.stem for p in paths} != months:
            raise ValueError("short-coupon monthly evidence is incomplete")
        for checkpoint in paths:
            checkpoint_guard(
                checkpoint,
                False,
                token,
                candidate,
                state_required=representation == "raw_tree",
            )
        predictions[candidate.name] = pd.concat(
            [pd.read_csv(p) for p in paths], ignore_index=True
        )
    reconstructed = summarize_short(
        predictions,
        expected,
        token,
        identity["audit"]["issuance_scope"],
        representation,
    )
    if result != reconstructed or result["candidate"] is None:
        raise ValueError(
            "short-coupon selection/metrics differ or no qualified candidate"
        )
    return result


def _load_fixed_release(path, result, identity, expected, token):
    if digest(path.parent / "unscored-requests.csv") != identity["unscored_sha256"]:
        raise ValueError("unscored request coverage changed")
    candidates = fixed_candidates(identity["representation"])
    predictions = {}
    names = {f["name"] for f in identity["folds"] if f["status"] == "ready"}
    for candidate in candidates:
        paths = sorted((path.parent / candidate.name).glob("*.csv"))
        if {p.stem for p in paths} != names:
            raise ValueError("fixed-split fold evidence is incomplete")
        frames = []
        for checkpoint in paths:
            checkpoint_guard(checkpoint, False, token, candidate, state_required=True)
            frames.append(pd.read_csv(checkpoint).assign(fold=checkpoint.stem))
        predictions[candidate.name] = pd.concat(frames, ignore_index=True)
    reconstructed = _fixed_summary(
        predictions,
        expected,
        candidates,
        identity["folds"],
        token,
        identity["audit"]["issuance_scope"],
    )
    reconstructed["boundary_excluded_rows"] = identity["boundary_excluded_rows"]
    if result != reconstructed or result["candidate"] is None:
        raise ValueError("fixed-split release differs from complete qualified evidence")
    return result


def _short_expected(requests, features, eligible):
    expected = requests.loc[eligible].copy()
    quote = features.loc[eligible]
    expected[list(QUOTE_COLUMNS)] = quote[list(QUOTE_COLUMNS)].to_numpy()
    expected["valuation_bp"] = (
        quote.issuer_quote_lag_0_bp.fillna(quote.sector_quote_lag_0_bp)
        .fillna(quote.known_treasury_bp)
        .to_numpy()
    )
    return expected


LABEL_CUTOFF = "2026-01-01"


def fixed_candidates(representation="raw"):
    """Existing raw regressions and Huber; zero years means all mature history."""
    return tuple(
        replace(c, years=0) for c in (*short_candidates(representation), CONTROL)
    )


def fixed_folds(requests, as_of):
    """Annual expanding TSCV, followed by a single frozen 2026 validation fit."""
    boundary = pd.Timestamp(LABEL_CUTOFF)
    first = int(requests.pricing_date.min().year)
    folds = []
    for year in range(first + 1, 2027):
        cutoff = pd.Timestamp(year=year, month=1, day=1)
        final = year == 2026
        end = min(pd.Timestamp(year=year + 1, month=1, day=1), pd.Timestamp(as_of))
        train = requests.label_available_date.lt(cutoff) & requests.origin.lt(cutoff)
        selected = requests.origin.ge(cutoff) & requests.origin.lt(end)
        selected &= requests.label_available_date.lt(
            pd.Timestamp(as_of) if final else boundary
        )
        folds.append(
            {
                "name": "validation-2026" if final else f"tscv-{year}",
                "cutoff": cutoff,
                "end": end,
                "selected": selected,
                "train": train,
                "training_events": int(requests.loc[train].bond_code.nunique()),
                "validation_events": int(requests.loc[selected].bond_code.nunique()),
                "requested": int(selected.sum()),
                "requests_by_horizon": {
                    str(h): int((selected & requests.lead_days.eq(h)).sum())
                    for h in SHORT_HORIZONS
                },
                "status": "ready"
                if requests.loc[train].bond_code.nunique() >= 40 and selected.any()
                else "insufficient_training_or_validation_events",
            }
        )
    return folds


def _freeze(
    panel, as_of, directory, requests, features, eligible, representation="raw"
):
    expected = _short_expected(requests, features, eligible)
    path = directory / "expected-events.csv"
    if path.exists():
        pd.testing.assert_frame_equal(
            pd.read_csv(path), pd.read_csv(StringIO(expected.to_csv(index=False)))
        )
    else:
        _atomic_csv(path, expected)
    identity = {
        "schema_version": "fixed-pre2026-v1",
        "as_of": str(pd.Timestamp(as_of).date()),
        "sources": source_hashes(),
        "runtime": runtime_identity(),
        "panel": _fingerprint(
            panel, fixed_candidates(representation), pd.Timestamp(as_of)
        ),
        "expected_sha256": digest(path),
        "unscored_sha256": digest(directory / "unscored-requests.csv"),
        "representation": representation,
        "candidates": [asdict(c) for c in fixed_candidates(representation)],
        "training_label_cutoff": LABEL_CUTOFF,
        "training_history": "all reliable mature events before each cutoff; expanding annual TSCV",
        "validation": "2026 origins; one fit frozen at 2026-01-01; no 2026 coupon-derived feature history",
        "horizons": list(SHORT_HORIZONS),
        "selection": "TSCV only; existing raw-history candidate must beat static, Huber and valuation controls",
        "option_filter": "none; IS_OEB retained only as source metadata",
        "audit": panel.audit,
        "folds": _fold_metadata(fixed_folds(requests, as_of)),
        "boundary_excluded_rows": int(
            (
                requests.origin.lt(LABEL_CUTOFF)
                & requests.label_available_date.ge(LABEL_CUTOFF)
            ).sum()
        ),
    }
    immutable_json(
        directory / "protocol.json", json.loads(json.dumps(identity, default=str))
    )
    return expected, digest(directory / "protocol.json")


def _candidate_features(panel, requests, candidate, representation):
    return panel.features(
        requests,
        include_quote_history=candidate.uses_quote_history,
        include_weighted_primary=candidate.uses_weighted_primary,
        include_industry_tenor=candidate.uses_industry_tenor,
        include_primary_batch=representation == "primary_batch"
        and candidate.uses_quote_history,
    )


def _predict(panel, requests, folds, candidate, directory, token, representation):
    frames = []
    for fold in folds:
        if fold["status"] != "ready":
            continue
        frozen = panel.with_label_cutoff(fold["cutoff"])
        features = _candidate_features(frozen, requests, candidate, representation)
        rows = _prediction_window(
            frozen,
            features,
            requests,
            requests.index[fold["selected"]],
            candidate,
            fold["cutoff"],
            directory / candidate.name / f"{fold['name']}.csv",
            checkpoint_guard=partial(
                checkpoint_guard, token=token, candidate=candidate, state_required=True
            ),
            retain_state=True,
        )
        rows["fold"] = fold["name"]
        frames.append(rows)
        del features
        release_training_memory()
    return pd.concat(frames, ignore_index=True)


def _fixed_summary(predictions, expected, candidates, folds, token, scope):
    if not np.isfinite(expected.valuation_bp).all():
        raise ValueError("valuation baseline must cover all requested forecasts")
    comparisons = []
    for candidate in candidates:
        rows = validate_rows(predictions[candidate.name], expected)
        dev, validation = _periods(rows)
        metrics = horizon_metrics(dev)
        if [m["lead_days"] for m in metrics] != list(SHORT_HORIZONS):
            raise ValueError("TSCV requires all three forecast horizons")
        comparisons.append(
            {
                "name": candidate.name,
                "candidate": asdict(candidate),
                "selection_score": float(np.mean([m["mae_bp"] for m in metrics])),
                "tscv": metrics,
                "validation": horizon_metrics(validation),
                "folds": [
                    {
                        "fold": name,
                        "events": int(group.bond_code.nunique()),
                        "metrics": horizon_metrics(group),
                    }
                    for name, group in rows.groupby("fold")
                ],
            }
        )
    base_dev, base_validation = _periods(
        expected.assign(predicted_bp=expected.valuation_bp)
    )
    baseline = {
        "tscv": horizon_metrics(base_dev),
        "validation": horizon_metrics(base_validation),
    }
    target = comparisons[-2]
    controls = [comparisons[0], comparisons[-1]]
    old_h = {m["lead_days"]: m["mae_bp"] for m in comparisons[-1]["tscv"]}
    qualified = all(target["selection_score"] < r["selection_score"] for r in controls)
    qualified &= target["selection_score"] < np.mean(
        [m["mae_bp"] for m in baseline["tscv"]]
    )
    qualified &= all(m["mae_bp"] <= old_h[m["lead_days"]] for m in target["tscv"])
    return {
        "protocol_sha256": token,
        "schema_version": "fixed-pre2026-v1",
        "training_label_cutoff": LABEL_CUTOFF,
        "candidate": target["candidate"] if qualified else None,
        "development_selected": target["candidate"] if qualified else None,
        "issuance_scope": scope,
        "estimand": "conditional_mean",
        "expected_savings_supported": False,
        "release_policy": "short_coupon_prediction",
        "forecast_horizons": list(SHORT_HORIZONS),
        "sample_count": int(expected.bond_code.nunique()),
        "metrics": target["validation"],
        "comparison": comparisons,
        "valuation_baseline": baseline,
        "folds": _fold_metadata(folds),
        "status": "tscv_qualified" if qualified else "no_qualified_candidate",
        "evidence_status": "fixed pre-2026 label-isolated historical validation; previously observed 2026",
    }


def _fold_metadata(folds):
    return [
        {
            k: str(v.date()) if isinstance(v, pd.Timestamp) else v
            for k, v in f.items()
            if k not in ("train", "selected")
        }
        for f in folds
    ]


@bounded_window_research
def evaluate_short_coupons(panel, as_of, directory, representation="raw"):
    """Use all pre-2026 history; report TSCV and fixed 2026 validation separately."""
    directory = Path(directory)
    if representation != "raw":
        raise ValueError(
            "representation experiments are archived; use the fixed raw-data protocol"
        )
    directory.mkdir(parents=True, exist_ok=True)
    candidates = fixed_candidates(representation)
    requests = panel.requests(SHORT_HORIZONS)
    folds = fixed_folds(requests, as_of)
    eligible = pd.Series(False, index=requests.index)
    for fold in folds:
        if fold["status"] == "ready":
            eligible |= fold["selected"]
    frozen = panel.with_label_cutoff(LABEL_CUTOFF)
    features = _candidate_features(frozen, requests, candidates[1], representation)
    unscored = requests.loc[~eligible].copy()
    unscored["reason"] = "initial_training_history_or_cross_year"
    for fold in folds:
        if fold["status"] != "ready":
            unscored.loc[
                unscored.index.intersection(requests.index[fold["selected"]]), "reason"
            ] = fold["status"]
    _atomic_csv(directory / "unscored-requests.csv", unscored)
    expected, token = _freeze(
        panel, as_of, directory, requests, features, eligible, representation
    )
    boundary = requests.origin.lt(LABEL_CUTOFF) & requests.label_available_date.ge(
        LABEL_CUTOFF
    )
    _atomic_csv(directory / "cross-year-requests.csv", requests.loc[boundary])
    del features
    release_training_memory()
    predictions = {
        c.name: _predict(panel, requests, folds, c, directory, token, representation)
        for c in candidates
    }
    result = _fixed_summary(
        predictions, expected, candidates, folds, token, panel.audit["issuance_scope"]
    )
    result["boundary_excluded_rows"] = int(boundary.sum())
    write_json(directory / "comparison.json", result["comparison"])
    write_json(directory / "valuation-baseline.json", result["valuation_baseline"])
    write_json(directory / "release-evaluation.json", result)
    return result
