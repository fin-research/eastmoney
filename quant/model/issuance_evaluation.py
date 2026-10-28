"""Finite real-coupon search, monthly refits and fingerprinted checkpoints."""

from dataclasses import asdict
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

from data.issuance_training import HORIZONS, IssuancePanel
from research_sources import source_hashes, runtime_identity
from .export import write_json
from .issuance_unified import (
    CouponCandidate,
    CouponModel,
    coupon_anchor,
    coupon_candidates,
)
from .issuance_diagnostics import (
    diagnostic_report,
    error_metrics,
    training_diagnostics,
)
from .research_resources import (
    bounded_window_research,
    check_resource_budget,
    release_training_memory,
    checkpoint_training_process,
)


def coupon_metrics(rows, sigma=None):
    errors = rows.coupon_bp - rows.predicted_bp
    e = errors.loc[np.isfinite(errors)]
    return {
        **error_metrics(rows.coupon_bp, rows.predicted_bp),
        "error_std_bp": sigma,
        "win_rate": None,
        "hit_rate_5bp": float(e.abs().le(5.0).mean()) if len(e) else None,
    }


def frozen_sigmas(rows):
    result = {}
    for horizon, group in rows.groupby("lead_days"):
        errors = (group.coupon_bp - group.predicted_bp).dropna()
        result[int(horizon)] = float(errors.std(ddof=1)) if len(errors) >= 30 else None
    return result


def _fingerprint(panel, candidates, as_of):
    return {
        "as_of": str(as_of.date()),
        "issuance_scope": panel.audit.get("issuance_scope", "all"),
        "secondary": hashlib.sha256(
            pd.util.hash_pandas_object(panel.secondary).values.tobytes()
        ).hexdigest()
        if panel.secondary is not None
        else None,
        "industry_nodes": hashlib.sha256(
            pd.util.hash_pandas_object(panel.industry_nodes).values.tobytes()
        ).hexdigest()
        if panel.industry_nodes is not None
        else None,
        "candidates": [asdict(c) for c in candidates],
        "events": hashlib.sha256(
            pd.util.hash_pandas_object(panel.events).values.tobytes()
        ).hexdigest(),
        "market": hashlib.sha256(
            pd.util.hash_pandas_object(panel.rates.market_features).values.tobytes()
        ).hexdigest(),
        "code": source_hashes(),
        "runtime": runtime_identity(),
    }


def _atomic_csv(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    rows.to_csv(tmp, index=False)
    tmp.replace(path)


def _monthly_references(rows, features, candidate):
    if candidate.uses_industry_basis:
        for column in (
            "industry_basis_fallback",
            "issuer_industry_basis_observations",
            "peer_industry_basis_observations",
        ):
            rows[column] = features[column].to_numpy()
    peer = features.peer_premium_mean_bp.fillna(0).to_numpy()
    rows["simple_bp"] = features.known_treasury_bp.to_numpy() + peer
    for column, target, feature_set, required in (
        (
            "primary_flat_bp",
            "primary_residual",
            "weighted_primary",
            "issuer_shrunk_premium_bp",
        ),
        (
            "industry_flat_bp",
            "industry_excess",
            "industry_tenor",
            "industry_aaa_tenor_bp",
        ),
    ):
        if required in features:
            rows[column] = coupon_anchor(
                features, CouponCandidate("ridge", target, 5, feature_set=feature_set)
            )


def _prediction_window(
    panel,
    features,
    requests,
    indices,
    candidate,
    cutoff,
    path,
    excluded=(),
    *,
    checkpoint_guard=None,
    timing_audit=None,
    window_start=None,
    retain_state=False,
):
    """One shared fit/predict/checkpoint; callers supply the dated training boundary."""
    if path.exists():
        if not path.with_suffix(".diagnostics.json").exists():
            raise ValueError("monthly checkpoint lacks training diagnostics")
        if checkpoint_guard is not None:
            checkpoint_guard(path, False)
        return pd.read_csv(path)
    keys = [
        "bond_code",
        "issuer",
        "rating",
        "bond_type",
        "placement_type",
        "tenor",
        "pricing_date",
        "label_available_date",
        "origin",
        "lead_days",
        "coupon_bp",
        "pricing_reference_bp",
        "pricing_reference_covered",
    ]
    check_resource_budget()
    rows = requests.loc[indices, keys].copy()
    model = CouponModel(candidate).fit(
        features,
        requests,
        cutoff,
        excluded,
        market_panel=panel,
        window_start=window_start,
    )
    model.audit["issuance_scope"] = panel.audit.get("issuance_scope", "all")
    rows["predicted_bp"] = model.predict(features.loc[indices])
    if candidate.target == "pricing_excess":
        from .issuance_market_change import market_change, market_constant_change

        rows["market_predicted_change_bp"] = market_change(
            model.market_layer, features.loc[indices]
        )
        rows["market_constant_change_bp"] = market_constant_change(
            model.market_layer, features.loc[indices]
        )
        rows["market_actual_change_bp"] = (
            rows.pricing_reference_bp.to_numpy()
            - coupon_anchor(features.loc[indices], candidate)
        )
        covered = (
            rows.pricing_reference_covered.to_numpy()
            & features.loc[indices].industry_aaa_available.eq(1).to_numpy()
        )
        rows.loc[~covered, "market_actual_change_bp"] = np.nan
    rows["training_label_end"] = model.audit["training_label_end"]
    rows["training_cutoff"] = cutoff.date().isoformat()
    _monthly_references(rows, features.loc[indices], candidate)
    if timing_audit is not None:
        _atomic_csv(path.with_suffix(".timing.csv"), timing_audit(model, rows))
    write_json(
        path.with_suffix(".diagnostics.json"),
        training_diagnostics(
            model, features, requests, cutoff, excluded, window_start=window_start
        ),
    )
    _atomic_csv(path, rows)
    if retain_state:
        state = model.export()
        state["training_parameters"] = (
            model.estimator.get_params()
            if candidate.kind == "lgb"
            else {"loss": "weighted_l2", "alpha": model.audit["ridge_alpha"]}
        )
        write_json(path.with_suffix(".state.json"), state)
    if checkpoint_guard is not None:
        checkpoint_guard(path, True)
    checkpoint_training_process()
    del model
    release_training_memory()
    print(
        f"[coupon] {path.parent.name} {candidate.name} {path.stem}: {len(rows)} forecasts",
        flush=True,
    )
    return rows


def _monthly_predictions(
    panel,
    features,
    requests,
    selected,
    candidate,
    directory,
    excluded=(),
    checkpoint_guard=None,
    timing_audit=None,
    retain_state=False,
):
    outputs = []
    for month, indices in (
        requests.loc[selected].groupby(requests.origin.dt.to_period("M")).groups.items()
    ):
        outputs.append(
            _prediction_window(
                panel,
                features,
                requests,
                indices,
                candidate,
                month.start_time,
                directory / f"{month}.csv",
                excluded,
                checkpoint_guard=checkpoint_guard,
                timing_audit=timing_audit,
                retain_state=retain_state,
            )
        )
    if not outputs:
        raise ValueError("no issuance events in evaluation interval")
    return pd.concat(outputs, ignore_index=True)


def _metric_rows(rows, sigmas):
    output = []
    rows = rows.copy()
    rows["year"] = pd.to_datetime(rows.pricing_date).dt.year
    for (lead, year), group in rows.groupby(["lead_days", "year"]):
        metrics = coupon_metrics(group, sigmas.get(int(lead)))
        base = float((group.coupon_bp - group.simple_bp).abs().mean())
        output.append(
            {
                "lead_days": int(lead),
                "year": int(year),
                **metrics,
                "flat_market_mae_bp": base,
                "mae_skill_vs_flat_market": 1 - metrics["mae_bp"] / base
                if base
                else None,
            }
        )
    return output


def _best_candidate(rankings):
    valid = [
        row for row in rankings if row["failure"] is None and row["mae_bp"] is not None
    ]
    if not valid:
        raise ValueError("no complete candidate; inspect candidates.json")
    lowest = min(row["mae_bp"] for row in valid)
    return min(
        [row for row in valid if row["mae_bp"] <= lowest + 0.2],
        key=lambda r: (
            r["rmse_bp"],
            r["candidate"]["kind"] != "ridge",
            r["name"],
        ),
    )


def _save_final_predictions(directory, candidate, tune_rows, rows):
    _atomic_csv(directory / "predictions.csv", rows)
    training = [
        json.loads(path.read_text())
        for phase in (directory / "tune" / candidate.name, directory / "test")
        for path in sorted(phase.glob("*.diagnostics.json"))
    ]
    write_json(
        directory / "diagnostics.json",
        diagnostic_report(training, tune_rows, rows),
    )


@bounded_window_research
def evaluate_coupons(
    panel, as_of, directory, candidates=None, *, development_start=None
):
    """Tuning uses only earlier origins whose labels matured before test start."""
    date = pd.Timestamp(as_of)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    candidates = candidates or coupon_candidates()
    if len(candidates) > 24:
        raise ValueError("maximum 24 configurations")
    signature = _fingerprint(panel, candidates, date)
    signature["development_start"] = development_start
    protocol_path = directory / "protocol.json"
    if (
        protocol_path.exists()
        and json.loads(protocol_path.read_text())["signature"] != signature
    ):
        raise ValueError(
            "checkpoint data/code/config fingerprint mismatch; use a new experiment directory"
        )
    test_start = (date - pd.DateOffset(months=12)).replace(day=1)
    tune_start = (
        pd.Timestamp(development_start)
        if development_start is not None
        else test_start - pd.DateOffset(months=12)
    )
    if tune_start >= test_start:
        raise ValueError("development interval must precede final evaluation")
    write_json(
        protocol_path,
        {
            "signature": signature,
            "test_start": test_start,
            "tune_start": tune_start,
            "selection": "30-day MAE, RMSE, simplicity; win rate not used",
            "resource_limits": {"processes": 1, "threads": 1, "rss_bytes": 2 * 1024**3},
            "audit": panel.audit,
            "status": "historical research, not independent forward evidence",
        },
    )
    requests = panel.requests()
    features = panel.features(
        requests,
        include_weighted_primary=any(
            candidate.uses_weighted_primary for candidate in candidates
        ),
        include_industry_tenor=any(
            candidate.uses_industry_tenor for candidate in candidates
        ),
        include_curve_dynamics=any(
            candidate.uses_curve_dynamics for candidate in candidates
        ),
        include_industry_basis=any(
            candidate.uses_industry_basis for candidate in candidates
        ),
    )
    scored = requests.lead_days.isin(HORIZONS)
    tune = (
        scored
        & requests.origin.ge(tune_start)
        & requests.origin.lt(test_start)
        & requests.label_available_date.lt(test_start)
    )
    test = (
        scored & requests.origin.ge(test_start) & requests.label_available_date.lt(date)
    )
    rankings = []
    for candidate in candidates:
        try:
            rows = _monthly_predictions(
                panel,
                features,
                requests,
                tune,
                candidate,
                directory / "tune" / candidate.name,
            )
            metric = coupon_metrics(rows.loc[rows.lead_days.eq(30)])
            if metric["samples"] != int((tune & requests.lead_days.eq(30)).sum()):
                raise ValueError("candidate has incomplete comparison denominator")
            rankings.append(
                {
                    "candidate": asdict(candidate),
                    "name": candidate.name,
                    **metric,
                    "failure": None,
                }
            )
        except (ValueError, RuntimeError) as error:
            rankings.append(
                {
                    "candidate": asdict(candidate),
                    "name": candidate.name,
                    "failure": str(error),
                }
            )
        write_json(directory / "candidates.json", rankings)
    best = _best_candidate(rankings)
    candidate = next(c for c in candidates if c.name == best["name"])
    tune_rows = _monthly_predictions(
        panel, features, requests, tune, candidate, directory / "tune" / candidate.name
    )
    sigmas = frozen_sigmas(tune_rows)
    write_json(
        directory / "selection.json",
        {"candidate": asdict(candidate), "sigmas": sigmas, "frozen_before": test_start},
    )
    rows = _monthly_predictions(
        panel, features, requests, test, candidate, directory / "test"
    )
    _save_final_predictions(directory, candidate, tune_rows, rows)
    held_out = sorted(
        issuer
        for issuer in panel.events.issuer.unique()
        if int(hashlib.sha256(issuer.encode()).hexdigest()[:8], 16) % 5 == 0
    )
    holdout_mask = test & requests.issuer.isin(held_out)
    held_panel = IssuancePanel(
        panel.rates,
        panel.events.loc[~panel.events.issuer.isin(held_out)],
        panel.audit,
        panel.secondary,
        panel.incumbent_history,
        panel.industry_nodes,
    )
    del features
    release_training_memory()
    held_features = held_panel.features(
        requests,
        include_weighted_primary=candidate.uses_weighted_primary,
        include_industry_tenor=candidate.uses_industry_tenor,
        include_curve_dynamics=candidate.uses_curve_dynamics,
        include_industry_basis=candidate.uses_industry_basis,
    )
    held_rows = _monthly_predictions(
        held_panel,
        held_features,
        requests,
        holdout_mask,
        candidate,
        directory / "issuer-holdout",
        held_out,
    )
    from .issuance_incumbent import compare_incumbent

    incumbent = compare_incumbent(panel, rows, directory / "incumbent")
    result = {
        "sample_count": rows.bond_code.nunique(),
        "prediction_start": str(pd.to_datetime(rows.origin).min().date()),
        "prediction_end": str(pd.to_datetime(rows.origin).max().date()),
        "metrics": _metric_rows(rows, sigmas),
        "incumbent": incumbent,
        "candidate": asdict(candidate),
        "sigmas": sigmas,
        "audit": panel.audit,
        "issuer_holdout": {
            "issuers": held_out,
            "metrics": _metric_rows(held_rows, sigmas),
        },
        "selection": best,
        "evidence_status": "historical conditional coupon forecasts",
    }
    write_json(directory / "evaluation.json", result)
    return result
