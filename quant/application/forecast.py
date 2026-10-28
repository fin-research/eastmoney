"""Forecast application orchestration."""

import pandas as pd
from .inputs import _coupon_inputs


def run_issuance_forecast(
    directory,
    as_of,
    days,
    snapshot_path,
    terms,
    market_model="unified_coupon",
    issue_size=30.0,
    waiting_cost_bp_day=0.0,
    evaluation_directory=None,
    coupon_selection=None,
):
    import json
    from data.issuance_training import IssuancePanel
    from model.export import write_json
    from model.issuance_output import coupon_snapshot, fit_selected
    from model.issuance_export import export_coupon_bundle

    if market_model != "unified_coupon" or waiting_cost_bp_day != 0:
        raise ValueError(
            "Unified coupon prediction does not support legacy market models or waiting costs"
        )

    date = (
        pd.Timestamp(as_of)
        if as_of
        else pd.Timestamp.now(tz="Asia/Shanghai").tz_localize(None)
    ).normalize()
    directory.mkdir(parents=True, exist_ok=True)
    from data.online_inputs import ISSUANCE_INPUT_GROUPS

    from model.release_eligibility import load_active_release
    from model.issuance_unified import CouponCandidate

    evaluation = load_active_release(coupon_selection)
    candidate = CouponCandidate(**evaluation["candidate"])
    groups = (
        (*ISSUANCE_INPUT_GROUPS, "industry_nodes")
        if candidate.uses_industry_tenor or candidate.uses_quote_history
        else ISSUANCE_INPUT_GROUPS
    )
    inputs = _coupon_inputs(directory, date.date().isoformat(), snapshot_path, groups)
    terms = {**terms, "placement_type": terms.get("placement_type", "公募")}
    if (
        inputs.get("issuance_scope", evaluation["issuance_scope"])
        != evaluation["issuance_scope"]
    ):
        raise ValueError("input and frozen selection issuance scope mismatch")
    inputs["issuance_scope"] = evaluation["issuance_scope"]
    panel = IssuancePanel.from_inputs(inputs)
    write_json(directory / "inputs.json", inputs)
    del inputs
    from model.research_resources import release_training_memory

    release_training_memory()
    if evaluation.get("training_label_cutoff"):
        panel = panel.with_label_cutoff(evaluation["training_label_cutoff"])
    model = fit_selected(panel, evaluation, date)
    snapshot = coupon_snapshot(panel, model, evaluation, date, days, terms, issue_size)
    write_json(directory / "issuance_forecast.json", snapshot)
    inputs = json.loads((directory / "inputs.json").read_text())
    if evaluation.get("training_label_cutoff"):
        inputs["training_label_cutoff"] = evaluation["training_label_cutoff"]
    export_coupon_bundle(
        panel, model, evaluation, inputs, snapshot, directory / "online"
    )
    from model.issuance_report import coupon_report

    report = coupon_report(snapshot)
    pd.DataFrame(snapshot["forecast"]).to_csv(directory / "forecast.csv", index=False)
    print(report)
    return snapshot
