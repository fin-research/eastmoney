"""Inputs application orchestration."""

from pathlib import Path


def _prepare_issuance_engine(date, snapshot_path, directory, market_model):
    import json
    from data.online_inputs import (
        ISSUANCE_INPUT_GROUPS,
        fetch_inputs,
        build_online_issuance,
    )
    from model.export import write_json
    from model.primary_pricing import evaluate_primary_pricing
    from model.issuance_forecast import IssuanceForecaster

    if snapshot_path is None:
        snapshot_path = directory / "inputs.json"
        write_json(
            snapshot_path, fetch_inputs(str(date.date()), groups=ISSUANCE_INPUT_GROUPS)
        )
    payload = json.loads(snapshot_path.read_text())
    if payload["as_of_date"] != str(date.date()):
        raise ValueError("input snapshot date differs from forecast date")
    if "issue" not in payload["datasets"]:
        raise ValueError(
            "issuance forecast requires funding and real issue pricing inputs"
        )
    rates, dataset, pricing_audit = build_online_issuance(payload)
    _, history = evaluate_primary_pricing(dataset)
    return (
        IssuanceForecaster(rates, history, market_model),
        dataset,
        {
            "market": {"source": "Neon public.edb", "snapshot": str(snapshot_path)},
            "primary": pricing_audit,
        },
    )


def _coupon_inputs(directory, date, snapshot_path, groups=None):
    import json
    import os
    from data.online_inputs import ISSUANCE_INPUT_GROUPS, fetch_inputs
    from model.export import write_json

    restart_enabled = os.environ.get("QUANT_CHECKPOINT_RESTART") == "1"
    pinned = snapshot_path or (
        os.environ.get("QUANT_FROZEN_INPUT_PATH") if restart_enabled else None
    )
    inputs = (
        json.loads(Path(pinned).read_text())
        if pinned
        else fetch_inputs(date, groups or ISSUANCE_INPUT_GROUPS)
    )
    if inputs["as_of_date"] != date:
        raise ValueError("input snapshot date differs from model date")
    if not pinned:
        pinned = directory / "inputs.json"
        write_json(pinned, inputs)
    if restart_enabled:
        os.environ["QUANT_FROZEN_INPUT_PATH"] = str(Path(pinned).resolve())
    return inputs
