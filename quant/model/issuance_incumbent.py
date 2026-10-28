"""Replay the previous pricing architecture on matched real issuance events."""

from dataclasses import replace

import numpy as np
import pandas as pd

from .issuance_forecast import IssuanceForecaster
from .export import write_json


def compare_incumbent(panel, predictions, directory):
    if panel.incumbent_history is None:
        return {"status": "incumbent inputs unavailable", "metrics": []}
    engine = IssuanceForecaster(panel.rates, panel.incumbent_history)
    engine.candidate = replace(engine.candidate, monthly_fit=True)
    records = []
    for month, group in predictions.groupby(
        pd.to_datetime(predictions.origin).dt.to_period("M")
    ):
        path = directory / f"{month}.csv"
        if path.exists():
            records.extend(pd.read_csv(path).to_dict(orient="records"))
            continue
        rows = []
        for record in group.loc[group.lead_days.le(30)].to_dict(orient="records"):
            row = {**record, "incumbent_bp": np.nan, "failure": None}
            try:
                date = pd.Timestamp(record["origin"])
                quotes = panel.rates.levels_bp.index
                origin = quotes[quotes.searchsorted(date, side="left")]
                value = engine.predict_one(
                    date, origin, pd.Timestamp(record["pricing_date"]), record
                )
                row["incumbent_bp"] = value["coupon_percent"] * 100
                if not np.isfinite(row["incumbent_bp"]):
                    row["failure"] = "incumbent primary history unavailable"
            except (ValueError, IndexError) as error:
                row["failure"] = str(error)
            rows.append(row)
        directory.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        pd.DataFrame(rows).to_csv(temporary, index=False)
        temporary.replace(path)
        records.extend(rows)
    frame = pd.DataFrame(records)
    metrics = []
    for lead, group in frame.groupby("lead_days"):
        shared = group.loc[np.isfinite(group.incumbent_bp)]
        metrics.append(
            {
                "lead_days": int(lead),
                "requested": len(group),
                "matched": len(shared),
                "model_mae_bp": (shared.coupon_bp - shared.predicted_bp).abs().mean(),
                "incumbent_mae_bp": (shared.coupon_bp - shared.incumbent_bp)
                .abs()
                .mean(),
            }
        )
    result = {
        "status": "previous architecture replayed with monthly frozen trees; historical observed quote calendar",
        "unsupported_horizons": [60, 90],
        "metrics": metrics,
    }
    write_json(directory / "comparison.json", result)
    return result
