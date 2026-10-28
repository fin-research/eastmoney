"""发行事件回放：固定真实目标，逐个自然日重建可得信息集。"""

import hashlib
import json
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import pandas as pd

from .export import write_json
from .issuance_forecast import IssuanceForecaster
from .issuance_validation import historical_sessions, issuance_pair_errors
from .primary_pricing import coupon_predictions
from .issuance_decision import issuance_decision
from data.issuance_scope import EXCLUDED_PRIVATE_CODES


BACKTEST_CANDIDATES = (
    "random_walk",
    "historical_drift",
    "conditional_drift",
    "recent_drift",
    "robust_drift",
    "smooth_conditional_drift",
    "lgb_anchor_drift",
    "lgb_anchor_monthly",
    "direct_lgb",
    "direct_lgb_shrink",
    "direct_ridge_shrink",
)


def apply_event_overrides(dataset, path):
    """Audited corrections are explicit inputs; never infer a date from bond codes."""
    overrides = json.loads(Path(path).read_text())
    result = dataset.copy()
    result["original_issue_date"] = result.issue_date
    result["issue_date_source"] = (
        "input supplier ISSUE_DATE; not independently verified"
    )
    for row in overrides:
        source = urlparse(row["source_url"])
        if source.scheme != "https" or source.hostname not in {
            "disc.static.szse.cn",
            "www.szse.cn",
            "static.cninfo.com.cn",
            "www.cninfo.com.cn",
            "www.sse.com.cn",
            "static.sse.com.cn",
        }:
            raise ValueError("event correction requires official source URL")
        match = result.bond_code.eq(row["bond_code"])
        if not match.any() and row["bond_code"].upper() in EXCLUDED_PRIVATE_CODES:
            continue  # Known exclusion precedes all event-date corrections.
        if match.sum() != 1:
            raise ValueError("event correction bond missing or duplicated")
        current = result.loc[match].iloc[0]
        corrected = pd.Timestamp(row["issue_date"])
        if current.issue_date != pd.Timestamp(row["original_issue_date"]):
            raise ValueError("event correction original date differs from snapshot")
        if corrected < current.decision_date:
            raise ValueError("corrected issue date must not precede pricing date")
        result.loc[match, "issue_date"] = corrected
        result.loc[match, "label_available_date"] = max(
            corrected, current.decision_date
        )
        result.loc[match, "issue_date_source"] = row["source_url"]
    return result


def evaluate_issue_paths(
    engine, dataset, *, date_basis="issue_date", start="2021-01-01"
):
    """T defaults to actual issue start; predict its actual pricing-day coupon.

    Terms and pricing date are fixed scenario assumptions, not claimed to have
    been announced at the origin. Origins after pricing are retained as excluded
    rows: already-priced coupons are never counted as successful forecasts.
    """
    if date_basis not in ("issue_date", "decision_date"):
        raise ValueError("unknown event date basis")
    records = []
    for bond in dataset.sort_values("decision_date").itertuples():
        event = getattr(bond, date_basis)
        if event < pd.Timestamp(start):
            continue
        for lead in range(1, 31):
            as_of = event - pd.Timedelta(days=lead)
            row = {
                "candidate": engine.candidate.name,
                "bond_code": bond.bond_code,
                "issuer": bond.issuer,
                "issue_date": bond.issue_date,
                "pricing_date": bond.decision_date,
                "event_date": event,
                "event_lead_days": lead,
                "as_of": as_of,
                "actual_coupon_bp": bond.coupon_bp,
                "actual_market_bp": bond.anchor_market_bp,
                "label_available_date": bond.label_available_date,
                "date_basis": date_basis,
                "market_clock": "natural_day_origin"
                if engine.candidate.calendar_clock
                else "next_quote_origin_legacy",
                "training_schedule": "monthly_trees_live_drift"
                if engine.candidate.monthly_fit
                else "daily_refit",
                "issue_date_source": getattr(
                    bond,
                    "issue_date_source",
                    "input supplier ISSUE_DATE; not independently verified",
                ),
            }
            if as_of > bond.decision_date:
                records.append({**row, "status": "already_priced_excluded"})
                continue
            dates = historical_sessions(engine.rates, as_of, bond.decision_date)
            origin = (
                as_of if engine.candidate.calendar_clock or dates.empty else dates[0]
            )
            prediction = engine.predict_one(
                as_of, origin, bond.decision_date, bond._asdict()
            )
            source = prediction["market_source_date"]
            if not source < as_of or not prediction[
                "market_train_label_end"
            ] < engine.fit_date(as_of):
                raise ValueError("future information in market forecast")
            latest = prediction["primary_history_latest_date"]
            if pd.notna(latest) and not latest < as_of:
                raise ValueError("future primary label in forecast")
            base = float(engine.rates.levels_bp.loc[source, "AAA_3Y"])
            coupon = prediction["coupon_percent"] * 100
            row.update(prediction)
            row.update(
                prediction_coupon_bp=coupon,
                flat_coupon_bp=coupon - prediction["market_change_bp"],
                source_market_bp=base,
                actual_market_change_bp=bond.anchor_market_bp - base,
                error_bp=bond.coupon_bp - coupon,
                market_error_bp=bond.anchor_market_bp
                - prediction["market_level_percent"] * 100,
            )
            stats = engine.context(as_of, bond._asdict())
            for name, value in coupon_predictions(stats, base).items():
                row[f"primary_{name}_bp"] = value + prediction["market_change_bp"]
            row["last_coupon_baseline_bp"] = stats["last_issuer_coupon_bp"]
            own_last = stats["last_issuer_premium_bp"]
            if not np.isfinite(own_last):
                own_last = stats["peer_premium_bp"]
            row["primary_issuer_last_premium_bp"] = (
                base + own_last + prediction["market_change_bp"]
            )
            records.append(row)
    return pd.DataFrame(records)


def path_metrics(frame, groups=("candidate", "event_lead_days")):
    rows = []
    for key, group in frame.groupby(list(groups), dropna=False):
        key = key if isinstance(key, tuple) else (key,)
        valid = group.loc[group.status.eq("estimated")].copy()
        errors = valid.error_bp
        flat = valid.actual_coupon_bp - valid.flat_coupon_bp
        direction = np.sign(
            valid.market_change_bp.where(valid.market_change_bp.abs().gt(0.5), 0)
        )
        actual = np.sign(
            valid.actual_market_change_bp.where(
                valid.actual_market_change_bp.abs().gt(0.5), 0
            )
        )
        signals = direction.ne(0) & actual.ne(0)
        rows.append(
            {
                **dict(zip(groups, key, strict=True)),
                "requested": len(group),
                "samples": len(valid),
                "bonds": valid.bond_code.nunique(),
                "pricing_events": valid[["issuer", "pricing_date"]]
                .drop_duplicates()
                .shape[0],
                "mae_bp": errors.abs().mean(),
                "rmse_bp": np.sqrt((errors**2).mean()),
                "bias_bp": -errors.mean(),
                "within_5bp": errors.abs().le(5).mean(),
                "within_10bp": errors.abs().le(10).mean(),
                "flat_mae_bp": flat.abs().mean(),
                "last_coupon_samples": int(valid.last_coupon_baseline_bp.notna().sum()),
                "last_coupon_mae_bp": (
                    valid.actual_coupon_bp - valid.last_coupon_baseline_bp
                )
                .abs()
                .mean(),
                "beat_flat_rate": errors.abs().lt(flat.abs() - 1e-8).mean(),
                "tie_flat_rate": (errors.abs() - flat.abs()).abs().le(1e-8).mean(),
                "market_mae_bp": valid.market_error_bp.abs().mean(),
                "market_direction_accuracy": direction.eq(actual).mean(),
                "direction_signal_samples": int(signals.sum()),
                "direction_signal_accuracy": direction.loc[signals]
                .eq(actual.loc[signals])
                .mean(),
                "direction_signal_always_down_accuracy": actual.loc[signals]
                .eq(-1)
                .mean(),
                "always_down_direction_accuracy": actual.eq(-1).mean(),
            }
        )
    return pd.DataFrame(rows)


def evaluate_pair_policy(pairs, waiting_cost_bp_day=0.0):
    """Replay the existing rule before each first issuance, never fit on its pair.

    Actual coupons on both dates are observable, but these selected repeated
    issues are not a complete counterfactual issuance-opportunity universe.
    """
    rows = []
    for pair in pairs.itertuples():
        terms = {
            key: getattr(pair, key)
            for key in ("issuer", "rating", "tenor", "bond_type")
        }
        window = pd.DataFrame(
            [
                {**terms, "date": pair.origin, "coupon_percent": 2.0},
                {
                    **terms,
                    "date": pair.origin + pd.Timedelta(days=pair.lead_days),
                    "coupon_percent": 2.0 - pair.prediction_saving_bp / 100,
                },
            ]
        )
        decision, _ = issuance_decision(
            window, pairs, pair.origin, waiting_cost_bp_day=waiting_cost_bp_day
        )
        wait = decision["action"] == "可择机等待"
        saving = pair.actual_saving_bp - waiting_cost_bp_day * pair.lead_days
        rows.append(
            {
                **pair._asdict(),
                "action": decision["action"],
                "wait": wait,
                "prior_calibration_pairs": decision["joint_error_pairs"],
                "predicted_probability": decision["saving_probability"],
                "actual_net_saving_bp": saving,
                "realized_saving_vs_immediate_bp": saving if wait else 0.0,
                "realized_saving_vs_always_wait_bp": 0.0 if wait else -saving,
                "regret_bp": max(0, saving) - (saving if wait else 0.0),
                "waiting_cost_bp_day": waiting_cost_bp_day,
            }
        )
    return pd.DataFrame(rows)


def clustered_loss_interval(frame, repetitions=2000):
    """Event-cluster bootstrap of loss improvement; 30 origins are not 30 bonds.

    Descriptive uncertainty only: small samples and cross-event dependence remain.
    """
    valid = frame.loc[frame.status.eq("estimated")].copy()
    valid["gain"] = (
        valid.actual_coupon_bp - valid.flat_coupon_bp
    ).abs() - valid.error_bp.abs()
    clusters = valid.groupby(["issuer", "pricing_date"]).gain.mean().to_numpy()
    if not len(clusters):
        return {"events": 0}
    rng = np.random.default_rng(20260921)
    means = rng.choice(clusters, (repetitions, len(clusters)), replace=True).mean(
        axis=1
    )
    low, high = np.quantile(means, [0.025, 0.975])
    return {
        "events": len(clusters),
        "mean_gain_bp": float(clusters.mean()),
        "low95_bp": float(low),
        "high95_bp": float(high),
    }


def save_backtest_candidate(rates, history, targets, directory, name):
    """One bounded candidate run; caches are tied to exact code and input content."""
    root = Path(__file__).resolve().parents[1]
    files = [
        "data/rate_data.py",
        "model/rate_forecast.py",
        "model/conditional_drift.py",
        "model/issuance_forecast.py",
        "model/primary_pricing.py",
        "model/issuance_backtest.py",
        "model/issuance_validation.py",
        "data/primary_pricing.py",
        "data/issuance_scope.py",
        "online/issuance-exclusions.json",
    ]
    signature = {
        "candidate": name,
        "code": {p: hashlib.sha256((root / p).read_bytes()).hexdigest() for p in files},
        "inputs": [
            hashlib.sha256(pd.util.hash_pandas_object(f).values.tobytes()).hexdigest()
            for f in (rates.market_features, rates.levels_bp, history, targets)
        ],
    }
    directory.mkdir(parents=True, exist_ok=True)
    manifest = directory / f"{name}-manifest.json"
    output = directory / f"{name}-paths.csv"
    if manifest.exists() and output.exists():
        saved = json.loads(manifest.read_text())
        if (
            saved.get("signature") == signature
            and saved.get("sha256") == hashlib.sha256(output.read_bytes()).hexdigest()
        ):
            return pd.read_csv(
                output,
                parse_dates=["as_of", "issue_date", "pricing_date", "event_date"],
            )
    engine = IssuanceForecaster(rates, history, name)
    frames = []
    for basis in ("issue_date", "decision_date"):
        frames.append(evaluate_issue_paths(engine, targets, date_basis=basis))
    paths = pd.concat(frames, ignore_index=True)
    paths.to_csv(output, index=False)
    pairs = issuance_pair_errors(engine, targets)
    pairs.to_csv(directory / f"{name}-pairs.csv", index=False)
    write_json(
        manifest,
        {
            "signature": signature,
            "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
            "limitation": "retrospective conditional replay; historical data vintages unavailable; 2026 previously observed",
        },
    )
    return paths


def summarize_backtest(paths, directory):
    frame = paths.copy()
    frame["year"] = pd.to_datetime(frame.pricing_date).dt.year
    for suffix, groups in (
        ("horizons", ("candidate", "date_basis", "event_lead_days")),
        ("years", ("candidate", "date_basis", "year")),
        ("overall", ("candidate", "date_basis")),
        ("terms", ("candidate", "date_basis", "tenor", "bond_type")),
    ):
        path_metrics(frame, groups).to_csv(directory / f"{suffix}.csv", index=False)
    intervals = {
        f"{name}/{basis}": clustered_loss_interval(group)
        for (name, basis), group in frame.groupby(["candidate", "date_basis"])
    }
    write_json(directory / "event-cluster-intervals.json", intervals)
    ablations = []
    valid = frame.loc[frame.status.eq("estimated")]
    columns = [c for c in valid if c.startswith("primary_") and c.endswith("_bp")]
    for (name, basis, year), group in valid.groupby(
        ["candidate", "date_basis", "year"]
    ):
        common = group.dropna(subset=columns)
        for column in columns:
            error = common[column] - common.actual_coupon_bp
            ablations.append(
                {
                    "candidate": name,
                    "date_basis": basis,
                    "year": year,
                    "primary": column,
                    "common_samples": len(common),
                    "mae_bp": error.abs().mean(),
                    "bias_bp": error.mean(),
                }
            )
    pd.DataFrame(ablations).to_csv(directory / "premium-ablation.csv", index=False)
