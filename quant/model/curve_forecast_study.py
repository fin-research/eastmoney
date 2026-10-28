"""Auxiliary curve study, using shared raw features and frozen monthly evidence."""

import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

from artifacts import write_json
from research_sources import source_hashes, runtime_identity
from .curve_projection import (
    curve_forecast_data,
    fit_curve_forecast,
    predict_curve_forecast,
)
from .issuance_diagnostics import error_metrics, paired_month_interval
from .issuance_evaluation import _atomic_csv
from .issuance_study_protocol import digest, immutable_json
from .research_resources import bounded_window_research, checkpoint_training_process

HORIZONS = (1, 14, 30)
TENORS = (1, 3, 5, 7, 10)
METHODS = ("pls3", "current_curve", "training_mean")
KEYS = ["origin", "lead_days", "tenor"]


def _requests(x, y, meta):
    rows = []
    for h in HORIZONS:
        for t in TENORS:
            rows.append(
                pd.DataFrame(
                    {
                        "origin": meta.origin,
                        "source_date": meta.source_date,
                        "deadline": meta.origin + pd.Timedelta(days=h),
                        "lead_days": h,
                        "tenor": t,
                        "actual_bp": y[f"h{h}_t{t}"],
                        "current_curve": x[f"sector_{t}_quote_lag_0_bp"],
                    }
                )
            )
    return pd.concat(rows, ignore_index=True).loc[lambda r: r.origin.ge("2023-01-01")]


def _metrics(rows):
    records = []
    for (period, h, t), group in rows.groupby(["period", "lead_days", "tenor"]):
        common = np.isfinite(group[["actual_bp", *METHODS]]).all(axis=1)
        scores = {}
        for method in METHODS:
            scores[method] = {
                **error_metrics(group.actual_bp, group[method].where(common)),
                "raw_coverage": error_metrics(group.actual_bp, group[method]),
                "available_predictions": int(np.isfinite(group[method]).sum()),
            }
        paired = group.loc[common].rename(
            columns={
                "actual_bp": "coupon_bp",
                "origin": "pricing_date",
                "pls3": "predicted_bp",
            }
        )
        records.append(
            {
                "period": period,
                "lead_days": int(h),
                "tenor": int(t),
                "requested": len(group),
                "actual_available": int(np.isfinite(group.actual_bp).sum()),
                "common_samples": int(common.sum()),
                "methods": scores,
                "paired_month_intervals": {
                    baseline: paired_month_interval(
                        paired.rename(columns={baseline: "simple_bp"})
                    )
                    for baseline in METHODS[1:]
                },
            }
        )
    return records


def _gates(metrics):
    result = []
    for period in ("development", "recent"):
        for h in HORIZONS:
            nodes = [
                r for r in metrics if r["period"] == period and r["lead_days"] == h
            ]
            complete = len(nodes) == 5 and all(
                r["requested"] == r["common_samples"] > 0 for r in nodes
            )
            scores = {
                name: float(np.mean([r["methods"][name]["mae_bp"] for r in nodes]))
                if complete
                else None
                for name in METHODS
            }
            passed = (
                complete
                and all(scores["pls3"] < scores[name] for name in METHODS[1:])
                and all(
                    r["methods"]["pls3"]["mae_bp"]
                    <= r["methods"]["current_curve"]["mae_bp"]
                    for r in nodes
                )
            )
            result.append(
                {
                    "period": period,
                    "lead_days": h,
                    "complete": complete,
                    "node_equal_mae_bp": scores,
                    "passed": bool(passed),
                }
            )
    return result


def _month_rows(expected, predictions, state, dates):
    wide = pd.DataFrame(predictions, index=dates, columns=state["targets"])
    output = expected.copy()
    output["pls3"] = np.nan
    output["training_mean"] = np.nan
    for index, (h, t) in enumerate((h, t) for h in HORIZONS for t in TENORS):
        selected = output.lead_days.eq(h) & output.tenor.eq(t)
        endpoints = pd.DatetimeIndex(output.loc[selected, "source_date"])
        output.loc[selected, "pls3"] = wide.loc[endpoints, f"h{h}_t{t}"].to_numpy()
        output.loc[selected, "training_mean"] = state["y_mean"][index]
    output["training_cutoff"] = state["audit"]["cutoff"]
    return output


def _verified_rows(directory, expected):
    rows = pd.concat(
        [
            pd.read_csv(directory / f"{month}.csv")
            for month in sorted(expected.origin.dt.to_period("M").unique())
        ],
        ignore_index=True,
    )
    for field in ("origin", "deadline", "source_date"):
        rows[field] = pd.to_datetime(rows[field])
    paired = expected.merge(
        rows,
        on=KEYS,
        how="outer",
        indicator=True,
        validate="one_to_one",
        suffixes=("_expected", ""),
    )
    if len(paired) != len(expected) or not paired._merge.eq("both").all():
        raise ValueError("curve request denominator changed")
    for field in ("actual_bp", "current_curve"):
        np.testing.assert_allclose(
            paired[field], paired[field + "_expected"], equal_nan=True
        )
    for field in ("source_date", "deadline"):
        if not paired[field].equals(paired[field + "_expected"]):
            raise ValueError("curve request timing differs from frozen denominator")
    cutoffs = rows.origin.dt.to_period("M").dt.start_time.dt.strftime("%Y-%m-%d")
    if not rows.training_cutoff.eq(cutoffs).all():
        raise ValueError("curve training cutoff differs from origin month")
    return rows


@bounded_window_research
def evaluate_curve_forecasts(panel, as_of, directory, input_sha256):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    x, y, meta = curve_forecast_data(panel)
    expected = _requests(x, y, meta)
    expected_path = directory / "expected-requests.csv"
    if not expected_path.exists():
        _atomic_csv(expected_path, expected)
    else:
        from io import StringIO

        pd.testing.assert_frame_equal(
            pd.read_csv(expected_path),
            pd.read_csv(StringIO(expected.to_csv(index=False))),
        )
    protocol = {
        "as_of": as_of,
        "input_sha256": input_sha256,
        "sources": source_hashes(),
        "runtime": runtime_identity(),
        "expected_sha256": digest(expected_path),
        "data_sha256": {
            name: hashlib.sha256(
                pd.util.hash_pandas_object(frame).values.tobytes()
            ).hexdigest()
            for name, frame in (("x", x), ("y", y), ("meta", meta))
        },
        "model": "one PLS2, 3 components, scale=False, max_iter=500, tol=1e-6",
        "inputs": "shared raw five nodes by twenty quote dates; bp, no imputation",
        "targets": "raw five nodes strictly before origin+1/14/30 natural days; never interpolated",
        "origins": "one per shared model quote day d, origin=d+1 natural day",
        "maturity": "all 15 labels and 100 inputs complete; oldest input in past 3 years; max deadline and target date strictly before month cutoff",
        "evaluation": "origins since 2023; deadline strictly before as_of is mature; pending requests retained separately; pre-2026 origins with 2026 deadline are boundary rows",
        "baselines": "unchanged current raw curve; each target training mean from identical complete mature origins",
        "gates": "each period/horizon mean node MAE strictly below both controls, every node no worse than current curve, all mature requested rows commonly scored",
        "limits": "auxiliary market target only; observed history, no coupon selection or publication; month blocks overlap at 30 days",
        "parameter_search": False,
    }
    immutable_json(directory / "protocol.json", protocol)
    token = digest(directory / "protocol.json")
    for month, group in expected.groupby(expected.origin.dt.to_period("M")):
        path = directory / f"{month}.csv"
        receipt = path.with_suffix(".receipt.json")
        state_path = path.with_suffix(".state.json")
        if path.exists():
            saved = json.loads(receipt.read_text())
            if saved != {
                "protocol_sha256": token,
                "predictions_sha256": digest(path),
                "state_sha256": digest(state_path),
            }:
                raise ValueError("curve checkpoint differs from frozen protocol")
            continue
        state = fit_curve_forecast(x, y, meta, month.start_time)
        selected = meta.origin.dt.to_period("M").eq(month)
        predictions = predict_curve_forecast(x.loc[selected], state)
        if not np.isfinite(predictions[np.isfinite(x.loc[selected]).all(axis=1)]).all():
            raise ValueError("nonfinite curve prediction")
        output = _month_rows(group, predictions, state, x.index[selected])
        write_json(state_path, state)
        _atomic_csv(path, output)
        write_json(
            receipt,
            {
                "protocol_sha256": token,
                "predictions_sha256": digest(path),
                "state_sha256": digest(state_path),
            },
        )
        print(
            f"[curve] {month}: {state['audit']['complete_origins']} mature training origins; {len(group)} requested outputs",
            flush=True,
        )
        checkpoint_training_process()
    rows = _verified_rows(directory, expected)
    mature = rows.deadline.lt(pd.Timestamp(as_of))
    boundary = rows.origin.lt("2026-01-01") & rows.deadline.ge("2026-01-01")
    scored = rows.loc[mature & ~boundary].copy()
    scored["period"] = np.where(scored.origin.lt("2026-01-01"), "development", "recent")
    metrics = _metrics(scored)
    gates = _gates(metrics)
    result = {
        "schema_version": 1,
        "study": "curve_pls3_market",
        "protocol_sha256": token,
        "input_sha256": input_sha256,
        "requested_rows": len(rows),
        "requested_origins": int(rows.origin.nunique()),
        "pending_rows": int((~mature).sum()),
        "boundary_rows": int((mature & boundary).sum()),
        "scored_requested_rows": len(scored),
        "metrics": metrics,
        "gates": gates,
        "status": "market_increment_found"
        if all(g["passed"] for g in gates)
        else "no_market_increment",
        "coupon_candidate": None,
        "production_activation": False,
    }
    write_json(directory / "evaluation.json", result)
    return result
