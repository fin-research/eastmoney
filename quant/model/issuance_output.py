"""Existing report shape, one coupon model, simple lower-quartile dates."""

import math

import numpy as np
import pandas as pd

from data.issuance_calendar import IssuanceCalendar
from .issuance_unified import CouponCandidate, CouponModel, coupon_anchor


def low_rate_dates(rows):
    if not rows:
        return {"dates": [], "windows": [], "lowest_date": None, "action": "暂无预测"}
    threshold = sorted(row["coupon_percent"] for row in rows)[
        math.ceil(len(rows) * 0.25) - 1
    ]
    chosen = [row["date"] for row in rows if row["coupon_percent"] <= threshold]
    windows = []
    previous_chosen = False
    for row in rows:
        selected = row["date"] in chosen
        if selected:
            if previous_chosen:
                windows[-1]["end"] = row["date"]
            else:
                windows.append({"start": row["date"], "end": row["date"]})
        previous_chosen = selected
    return {
        "dates": chosen,
        "windows": windows,
        "lowest_date": min(rows, key=lambda row: row["coupon_percent"])["date"],
        "action": "尽快发行" if rows[0]["date"] in chosen else "等待",
    }


def _forecast_dates(date, days, short):
    if short and days != 30:
        raise ValueError("short coupon forecast requires a 30-day window")
    calendar = IssuanceCalendar()
    deadline = date + pd.Timedelta(days=days)
    dates = calendar.issuance_dates(date, deadline)
    if short:
        dates = pd.DatetimeIndex([date + pd.Timedelta(days=h) for h in (1, 14, 30)])
    return calendar, deadline, dates


def fit_selected(panel, evaluation, as_of):
    if evaluation.get("release_policy") == "user_selected_frozen_mlp":
        from .frozen_mlp import restore_frozen_model

        return restore_frozen_model(evaluation)
    if evaluation.get("candidate") is None:
        raise ValueError(
            "no qualified short-coupon candidate; study results are retained"
        )
    candidate = CouponCandidate(**evaluation["candidate"])
    cutoff = evaluation.get("training_label_cutoff")
    if cutoff:
        panel = panel.with_label_cutoff(cutoff)
    requests = (
        panel.requests((1, 14, 30))
        if candidate.uses_quote_history
        else panel.requests()
    )
    features = panel.features(
        requests,
        include_weighted_primary=candidate.uses_weighted_primary,
        include_industry_tenor=candidate.uses_industry_tenor,
        include_curve_dynamics=candidate.uses_curve_dynamics,
        include_industry_basis=candidate.uses_industry_basis,
        include_quote_history=candidate.uses_quote_history,
    )
    model = CouponModel(candidate).fit(
        features,
        requests,
        pd.Timestamp(cutoff) if cutoff else pd.Timestamp(as_of).replace(day=1),
        market_panel=panel,
    )
    model.audit["issuance_scope"] = panel.audit.get("issuance_scope", "all")
    return model


def _requests(date, dates, terms, size):
    return pd.DataFrame(
        [
            {
                **terms,
                "origin": date,
                "lead_days": (day - date).days,
                "issue_size": size,
            }
            for day in dates
        ]
    )


def _point(day, prediction, feature, date, source, model):
    return {
        "date": day.date().isoformat(),
        "lead_days": (day - date).days,
        "forecast_origin": date.date().isoformat(),
        "effective_horizon": (day - date).days,
        "coupon_percent": float(prediction / 100),
        "coupon_low_percent": None,
        "coupon_high_percent": None,
        "market_change_bp": 0.0,
        "market_volatility_bp": None,
        "market_level_percent": float(feature.known_treasury_bp / 100),
        "market_source_date": source,
        "market_train_label_end": model.audit["training_label_end"],
        "market_training_samples": model.audit["events"],
        "primary_history_latest_date": None,
        "calibration_latest_label": None,
        "status": "estimated"
        if all(
            str(feature[name]) in model.categories[name]
            for name in ("rating", "bond_type", "placement_type")
        )
        else "coverage_limited",
        "interval_samples": 0,
        "own_observations": int(feature.issuer_observations),
        "peer_observations": int(feature.peer_observations),
        "issuer_premium_bp": None,
        "waiting_cost_bp": 0.0,
        "saving_probability": None,
        "saving_p10_bp": None,
        "pair_samples": None,
    }


def coupon_snapshot(panel, model, evaluation, as_of, days, terms, size):
    point = (
        model.candidate.estimand == "huber_center"
        and evaluation.get("issuance_scope") == "public_only"
        and evaluation.get("estimand") == model.candidate.estimand
        and evaluation.get("expected_savings_supported") is False
        and evaluation.get("release_policy")
        in ("user_authorized_best_public_point", "validated_market_separation")
    )
    if model.candidate.estimand != "conditional_mean" and not point:
        raise ValueError(
            "robust-center research cannot publish expected coupon savings"
        )
    if (
        panel.audit.get("issuance_scope", "all") == "public_only"
        and terms.get("placement_type") != "公募"
    ):
        raise ValueError("public-only model requires confirmed public placement")
    short = model.candidate.uses_quote_history
    date = pd.Timestamp(as_of)
    if (
        days not in (30, 60, 90)
        or not 1 <= terms["tenor"] <= 10
        or not np.isfinite(size)
        or size <= 0
    ):
        raise ValueError("window 30/60/90, tenor 1..10, positive size required")
    calendar, deadline, dates = _forecast_dates(date, days, short)
    source = panel.rates.market_features.index[-1]
    if source != calendar.previous_quote_day(date):
        raise ValueError("latest market data does not cover the prior quote day")
    requests = _requests(date, dates, terms, size)
    features = (
        panel.features(
            requests,
            include_weighted_primary=model.candidate.uses_weighted_primary,
            include_industry_tenor=model.candidate.uses_industry_tenor,
            include_curve_dynamics=model.candidate.uses_curve_dynamics,
            include_industry_basis=model.candidate.uses_industry_basis,
            include_quote_history=model.candidate.uses_quote_history,
        )
        if len(requests)
        else pd.DataFrame()
    )
    predictions = model.predict(features) if len(requests) else []
    if not np.isfinite(predictions).all() or any(value <= 0 for value in predictions):
        raise ValueError("invalid predicted coupon")
    rows = [
        _point(day, prediction, feature, date, source.date().isoformat(), model)
        for day, prediction, (_, feature) in zip(
            dates, predictions, features.iterrows(), strict=True
        )
    ]
    if hasattr(model, "market_layer") and rows:
        from .issuance_market_change import market_change

        for row, change in zip(
            rows, market_change(model.market_layer, features), strict=True
        ):
            row["market_change_bp"] = float(change)
    for row in rows:
        saving = (rows[0]["coupon_percent"] - row["coupon_percent"]) * 100
        row.update(
            expected_saving_bp=None if point or short else saving,
            net_saving_bp=None if point or short else saving,
            annual_saving_wan=None if point or short else saving * size,
        )
    low = (
        {"dates": [], "windows": [], "lowest_date": None, "action": "仅预测票面"}
        if short
        else low_rate_dates(rows)
    )
    best = next((row for row in rows if row["date"] == low["lowest_date"]), None)
    decision = {
        "action": low["action"],
        "reason": "coupon_prediction_only" if short else "lowest_quartile",
        "scope": "three horizon coupon predictions; no manual market signal rules"
        if short
        else "Huber robust coupon point forecast; not expected financing cost"
        if point
        else "predicted coupon only",
        "validation_status": "historical conditional coupon forecasts",
        "first_issuance_date": None if short else rows[0]["date"] if rows else None,
        "lowest_expected_cost_date": low["lowest_date"],
        "low_rate_dates": low["dates"],
        "low_rate_windows": low["windows"],
        "expected_net_saving_bp": best["net_saving_bp"] if best else None,
        "annual_saving_wan": best["annual_saving_wan"] if best else None,
        "saving_probability": None,
        "saving_p10_bp": None,
        "joint_error_pairs": None,
    }
    explanation = None
    scenarios = []
    if rows:
        phi = model.contributions(features.iloc[:1])[0]
        vector = model.encode(features.iloc[:1]).iloc[0]
        explanation = {
            "method": "additive_market_coupon"
            if hasattr(model, "market_layer")
            else "tree_path_dependent"
            if model.candidate.kind == "lgb"
            else "relu_path_integrated_gradients"
            if model.candidate.kind == "mlp"
            else "linear",
            "unit": "bp",
            "base_coupon_bp": float(phi[-1]),
            "prediction_coupon_bp": float(predictions[0]),
            "market_anchor_bp": float(
                coupon_anchor(features.iloc[:1], model.candidate)[0]
            ),
            "issuer_premium_bp": 0.0,
            "horizon_drift_bp": 0.0,
            "tree_expected_change_bp": 0.0,
            "features": [
                {"feature": name, "value": float(vector[name]), "shap_bp": float(value)}
                for name, value in zip(model.feature_names, phi[:-1], strict=True)
            ],
        }
        scenarios = _product_scenarios(panel, model, date, dates[0], terms, size)
    market = [
        {
            "date": day.date().isoformat(),
            "market_level_percent": float(panel.rates.levels_bp.GOV_3Y.iloc[-1] / 100),
            "quote_day": calendar.is_quote_workday(day),
            "issuance_day": calendar.is_issuance_day(day),
            "value_date": source.date().isoformat(),
            "status": "known reference, not a separate forecast",
        }
        for day in pd.date_range(date, deadline)
    ]
    return {
        "schema_version": "issuance-forecast-v1",
        "as_of_date": date.date().isoformat(),
        "deadline": deadline.date().isoformat(),
        "window_days": days,
        "market_source_date": source.date().isoformat(),
        "market_model": "unified_coupon",
        "terms": terms,
        "issue_size_yi": size,
        "waiting_cost_bp_day": 0.0,
        "decision": decision,
        "forecast": rows,
        "market_forecast": market,
        "product_scenarios": scenarios,
        "explanation": explanation,
        "validation": evaluation,
        "source_audit": panel.audit,
        "calendar_audit": {"calendar": calendar.specification},
        "publication": "issuance-forecast",
    }


def _product_scenarios(panel, model, date, target, terms, size):
    requests = pd.concat(
        [
            _requests(
                date, [target], {**terms, "tenor": tenor, "bond_type": kind}, size
            )
            for kind in ("证券公司债", "证券公司次级债")
            for tenor in (3.0, 5.0)
        ],
        ignore_index=True,
    )
    features = panel.features(
        requests,
        include_weighted_primary=model.candidate.uses_weighted_primary,
        include_industry_tenor=model.candidate.uses_industry_tenor,
        include_curve_dynamics=model.candidate.uses_curve_dynamics,
        include_industry_basis=model.candidate.uses_industry_basis,
        include_quote_history=model.candidate.uses_quote_history,
    )
    predictions = model.predict(features)
    return [
        {
            "tenor": float(request.tenor),
            "bond_type": request.bond_type,
            "coupon_percent": float(prediction / 100),
            "own_observations": int(feature.issuer_observations),
            "peer_observations": int(feature.peer_observations),
        }
        for (_, request), (_, feature), prediction in zip(
            requests.iterrows(), features.iterrows(), predictions, strict=True
        )
    ]
