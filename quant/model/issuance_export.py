"""新模型的跨运行时发布包：两棵期限模型、校准证据与明确的数据契约。"""

import hashlib
import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from data.industry_source import PROFILE, validate_industry_profile

from data.issuance_calendar import CALENDAR_2026
from data.online_inputs import ISSUANCE_INPUT_GROUPS
from data.issuance_scope import ISSUANCE_SCOPE
from .export import _tree, write_json
from .rate_forecast import candidate_features
from .issuance_validation import issuance_validation_summary


def export_coupon_bundle(panel, model, evaluation, inputs, snapshot, directory):
    """One artifact holds all categories and horizons; no per-scenario models."""
    from data.issuance_training import CATEGORIES

    point = (
        model.candidate.estimand == "huber_center"
        and evaluation.get("issuance_scope") == "public_only"
        and evaluation.get("estimand") == model.candidate.estimand
        and evaluation.get("expected_savings_supported") is False
        and evaluation.get("release_policy")
        in ("user_authorized_best_public_point", "validated_market_separation")
    )
    if model.candidate.estimand != "conditional_mean" and not point:
        raise ValueError("robust-center research cannot export expected coupon savings")

    if model.candidate.uses_industry_tenor and (
        panel.industry_nodes is None or not inputs["datasets"].get("industry_nodes")
    ):
        raise ValueError("industry tenor bundle requires dated AAA node inputs")
    scope = panel.audit.get("issuance_scope", "all")
    if (
        inputs.get("issuance_scope", "all") != scope
        or model.audit.get("issuance_scope", "all") != scope
    ):
        raise ValueError("issuance scope mismatch across inputs, panel and model")
    if set(inputs["datasets"]) & {"industry_curve", "industry_nodes"}:
        validate_industry_profile(inputs)
    as_of = snapshot["as_of_date"]
    filename = "model-main.json"
    digest = write_json(directory / filename, model.export())
    manifest = {
        "schema_version": 1,
        "feature_version": "issuance-coupon",
        "market_model": "unified_coupon",
        "issuance_scope": scope,
        "estimand": model.candidate.estimand,
        "expected_savings_supported": not point
        and not model.candidate.uses_quote_history,
        "training_as_of": model.audit["training_as_of"],
        "retrain_after": str((pd.Timestamp(as_of) + pd.offsets.MonthEnd(0)).date()),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "feature_names": model.feature_names,
        "feature_groups": [*panel.rates.audit["feature_groups"], "coupon_quote_history"]
        if model.candidate.uses_quote_history
        else panel.rates.audit["feature_groups"],
        "required_input_groups": list(inputs["datasets"]),
        "industry_source_profile": PROFILE,
        "models": {"main": {"file": filename, "sha256": digest}},
        "calendar": CALENDAR_2026,
        "terms": snapshot["terms"],
        "window_days": snapshot["window_days"],
        "issue_size_yi": snapshot["issue_size_yi"],
        "validation": evaluation,
        "retraining": "one global coupon model, monthly refit, daily feature refresh",
    }
    if evaluation.get("training_label_cutoff"):
        manifest["training_label_cutoff"] = evaluation["training_label_cutoff"]
        manifest["retraining"] = (
            "fixed pre-2026 model; daily dated market features; coupon label history frozen"
        )
    if model.candidate.kind == "mlp":
        manifest["forecast_horizons"] = [1, 14, 30]
    manifest["model_version"] = hashlib.sha256(
        json.dumps(manifest, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()[:20]
    write_json(directory / "manifest.json", manifest)
    write_json(directory / "inputs.json", inputs)
    write_json(directory / "python-result.json", snapshot)
    write_json(
        directory / "python-features.json",
        panel.rates.market_features.reset_index(names="date").to_dict(orient="records"),
    )
    requests = (
        panel.requests(
            (1, 14, 30) if model.candidate.uses_quote_history else (0, 7, 30, 60, 90)
        )
        .iloc[::83]
        .copy()
    )
    for name in CATEGORIES:
        requests.loc[requests.index[-1], name] = "unseen-" + name
    features = panel.features(
        requests,
        include_weighted_primary=model.candidate.uses_weighted_primary,
        include_industry_tenor=model.candidate.uses_industry_tenor,
        include_curve_dynamics=model.candidate.uses_curve_dynamics,
        include_industry_basis=model.candidate.uses_industry_basis,
        include_quote_history=model.candidate.uses_quote_history,
    )
    encoded = model.encode(features)
    write_json(
        directory / "python-predictions.json",
        {
            "main": {
                "vectors": encoded.to_numpy().tolist(),
                "anchors": features.known_treasury_bp.tolist(),
                "predictions": model.predict(features).tolist(),
                "contributions": model.contributions(features).tolist(),
            }
        },
    )
    write_json(
        directory / "python-request-features.json",
        {
            "requests": requests.to_dict(orient="records"),
            "features": features.to_dict(orient="records"),
        },
    )
    return manifest


def export_issuance_bundle(engine, predictions, pairs, directory, as_of, terms):
    date = pd.Timestamp(as_of)
    files = {}
    fixtures = {}
    columns = candidate_features(
        engine.rates.features, "AAA_3Y", engine.candidate.feature_set
    )
    if engine.candidate.name != "lgb_anchor_drift":
        raise ValueError("production bundle requires selected lgb_anchor_drift")
    for horizon in (0, 1):
        prediction = engine.market_prediction(
            date, date, date + pd.Timedelta(days=horizon)
        )
        model = engine.fit_cache[(date, horizon)]
        dump = model.booster_.dump_model()
        value = {
            "feature_version": "issuance-lgb-v2",
            "feature_names": columns,
            "training_as_of": as_of,
            "training_label_end": str(prediction["market_train_label_end"].date()),
            "training_samples": prediction["market_training_samples"],
            "trees": [_tree(tree["tree_structure"]) for tree in dump["tree_info"]],
        }
        filename = f"model-{horizon}.json"
        files[str(horizon)] = {
            "file": filename,
            "sha256": write_json(directory / filename, value),
        }
        sample = (
            engine.rates.features.loc[engine.rates.features.index < date, columns]
            .iloc[::37]
            .copy()
        )
        vectors = sample.to_numpy()
        missing = vectors[-3:].copy()
        missing[:, ::7] = np.nan
        vectors = np.vstack([vectors, missing])
        fixtures[str(horizon)] = {
            "vectors": vectors.tolist(),
            "predictions": model.predict(vectors).tolist(),
            "contributions": model.booster_.predict(
                vectors, pred_contrib=True
            ).tolist(),
        }
    calibration_keys = [
        "issuer",
        "rating",
        "tenor",
        "bond_type",
        "lead_days",
        "as_of",
        "date",
        "label_available_date",
        "error_bp",
    ]
    artifact = {
        "feature_version": "issuance-lgb-v2",
        "calibration": predictions[calibration_keys].to_dict(orient="records"),
        "pairs": pairs.to_dict(orient="records"),
    }
    files["2"] = {
        "file": "model-2.json",
        "sha256": write_json(directory / "model-2.json", artifact),
    }
    manifest = {
        "schema_version": 2,
        "feature_version": "issuance-lgb-v2",
        "market_model": "lgb_anchor_drift",
        "sample_policy_version": ISSUANCE_SCOPE["version"],
        "training_as_of": as_of,
        "retrain_after": str((date + pd.Timedelta(days=30)).date()),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "feature_names": columns,
        "feature_groups": engine.rates.audit["feature_groups"],
        "required_input_groups": list(ISSUANCE_INPUT_GROUPS),
        "models": files,
        "calendar": CALENDAR_2026,
        "terms": terms,
        "window_days": 30,
        "issue_size_yi": 30,
        "waiting_cost_bp_day": 0,
        "validation": issuance_validation_summary(predictions),
        "retraining": "trees and calibration fixed until republished; live market and pricing inputs refreshed every run",
    }
    manifest["model_version"] = hashlib.sha256(
        json.dumps(manifest, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()[:20]
    write_json(directory / "manifest.json", manifest)
    write_json(directory / "python-predictions.json", fixtures)
    feature_rows = engine.rates.market_features.reset_index().rename(
        columns={"index": "date", "feature_date": "date"}
    )
    write_json(
        directory / "python-features.json", feature_rows.to_dict(orient="records")
    )
    return manifest
