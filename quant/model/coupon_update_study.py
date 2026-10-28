"""One fixed information-update comparison using the shared coupon evaluator."""

from dataclasses import asdict
from functools import partial
from io import StringIO
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

from artifacts import write_json
from research_sources import source_hashes, runtime_identity
from .issuance_evaluation import (
    _monthly_predictions,
    _prediction_window,
    _atomic_csv,
    _fingerprint,
)
from .issuance_study import checkpoint_guard
from .issuance_study_protocol import digest, immutable_json, validate_rows
from .issuance_unified import CouponModel
from .research_resources import bounded_window_research
from .short_coupon import (
    short_candidates,
    CONTROL,
    _short_expected,
    _periods,
    horizon_metrics,
    SELECTION,
    SHORT_HORIZONS,
)

POLICY = {
    "change": "right training cutoff becomes request origin; monthly left edge stays fixed",
    "left": "first day of origin month minus three years",
    "right": "label availability and all training origins strictly before prediction origin",
    "model": "unchanged raw40 Ridge alpha10, preprocessing and equal issuance weights",
    "comparison": "frozen static, monthly raw, Huber and valuation on identical requests",
    "gates": "original three-horizon development/recent conditions plus each horizon no worse than monthly raw and equal-horizon mean strictly better in each period",
    "failure": "any missing request or failed fit fails study; no production release",
    "limitations": "observed history and proxy label maturity; not independent publication-time or forward evidence",
    "parameter_search": False,
}
RAW = short_candidates()[1]


def frame_sha(frame):
    return hashlib.sha256(
        pd.util.hash_pandas_object(frame).values.tobytes()
    ).hexdigest()


def validate_control_identity(identity, panel, as_of, requests, features):
    """Bind all original training inputs, including the Huber-only panel inputs."""
    date = str(pd.Timestamp(as_of).date())
    representation = identity.get("representation", "raw")
    candidates = short_candidates(representation)
    selection = {
        **SELECTION,
        **(
            {
                "eligibility": f"{representation} candidate only; static/raw-history/Huber are controls"
            }
            if representation != "raw"
            else {}
        ),
    }
    expected = {
        "as_of": date,
        "events_sha256": frame_sha(requests),
        "features_sha256": frame_sha(features),
        "runtime": runtime_identity(),
        "candidates": [asdict(c) for c in candidates],
        "controls": [asdict(CONTROL)],
        "horizons": list(SHORT_HORIZONS),
        "development_start": "2023-01-01",
        "development_end": "2026-01-01",
        "historical_end": date,
        "selection": selection,
        "control_training_leads": "original 0..90 daily expansion; score 1/14/30 only",
    }
    for key, value in expected.items():
        if identity.get(key) != value:
            raise ValueError(f"frozen control {key} differs from current inputs/design")
    current = _fingerprint(panel, (*candidates, CONTROL), pd.Timestamp(as_of))
    if {key: value for key, value in identity["panel"].items() if key != "code"} != {
        key: value for key, value in current.items() if key != "code"
    }:
        raise ValueError("frozen control panel inputs or representation differ")


def frozen_controls(baseline, expected, *, panel, as_of, requests, features):
    identity = json.loads((baseline / "protocol.json").read_text())
    validate_control_identity(identity, panel, as_of, requests, features)
    token = digest(baseline / "protocol.json")
    pd.testing.assert_frame_equal(
        pd.read_csv(baseline / "expected-events.csv"),
        pd.read_csv(StringIO(expected.to_csv(index=False))),
    )
    if identity["expected_sha256"] != digest(baseline / "expected-events.csv"):
        raise ValueError("frozen expected requests changed")
    controls, sources = (
        {},
        {"protocol.json": token, "expected-events.csv": identity["expected_sha256"]},
    )
    months = set(pd.to_datetime(expected.origin).dt.strftime("%Y-%m"))
    for candidate in (*short_candidates(), CONTROL):
        paths = sorted((baseline / candidate.name).glob("*.csv"))
        if {p.stem for p in paths} != months:
            raise ValueError("frozen control months incomplete")
        for path in paths:
            checkpoint_guard(path, False, token, candidate)
            for item in (
                path,
                path.with_suffix(".diagnostics.json"),
                path.with_suffix(".receipt.json"),
            ):
                sources[str(item.relative_to(baseline))] = digest(item)
        controls[candidate.name] = validate_rows(
            pd.concat([pd.read_csv(p) for p in paths], ignore_index=True), expected
        )
    return controls, sources


def origin_guard(path, created, *, token, cutoff, start, requests, indices):
    window = path.with_suffix(".window.json")
    state = path.with_suffix(".state.json")
    if not state.exists() or (not created and not window.exists()):
        raise ValueError("origin checkpoint lacks model state or window receipt")
    checkpoint_guard(path, created, token, RAW)
    mask = CouponModel(RAW).training_mask(requests, cutoff, window_start=start)
    value = {
        "protocol_sha256": token,
        "frequency": "origin",
        "cutoff": str(cutoff.date()),
        "window_start": str(start.date()),
        "training_rows_sha256": frame_sha(requests.loc[mask]),
        "requested_rows_sha256": frame_sha(requests.loc[indices]),
        "state_sha256": digest(state),
    }
    immutable_json(window, value)


def summarize_updates(rows, expected, controls):
    rows = validate_rows(rows, expected)
    metrics, gates = [], []
    methods = {
        "origin_updates": rows,
        **controls,
        "valuation": expected.assign(predicted_bp=expected.valuation_bp),
    }
    for period_index, period in enumerate(("development", "recent")):
        by_method = {
            name: horizon_metrics(_periods(frame)[period_index])
            for name, frame in methods.items()
        }
        if any(
            [row["lead_days"] for row in values] != list(SHORT_HORIZONS)
            for values in by_method.values()
        ):
            raise ValueError("three complete horizons required in each period")
        metrics.append({"period": period, "methods": by_method})
        candidate = by_method["origin_updates"]
        old = by_method[RAW.name]
        huber = by_method[CONTROL.name]
        complete = all(
            r["samples"] == r["requested"] and r["missing"] == 0
            for values in by_method.values()
            for r in values
        )

        def mean(values):
            return float(np.mean([r["mae_bp"] for r in values]))

        comparisons = ("valuation", CONTROL.name, RAW.name) + (
            (short_candidates()[0].name,) if period_index == 0 else ()
        )
        passed = complete and all(
            mean(candidate) < mean(by_method[name]) for name in comparisons
        )
        passed = passed and all(
            c["mae_bp"] <= a["mae_bp"] and c["mae_bp"] <= b["mae_bp"]
            for c, a, b in zip(candidate, old, huber, strict=True)
        )
        gates.append({"period": period, "passed": bool(passed), "complete": complete})
    return {
        "status": "passed_historical_conditions"
        if all(r["passed"] for r in gates)
        else "no_update_increment",
        "candidate": None,
        "production_activation": False,
        "metrics": metrics,
        "gates": gates,
        "requests": len(expected),
        "events": int(expected.bond_code.nunique()),
        "evidence_status": POLICY["limitations"],
    }


def _updated_predictions(panel, features, requests, eligible, directory, token):
    outputs = []
    for cutoff, indices in requests.loc[eligible].groupby("origin").groups.items():
        cutoff = pd.Timestamp(cutoff)
        start = cutoff.to_period("M").start_time - pd.DateOffset(years=3)
        path = directory / f"{cutoff.date()}.csv"
        guard = partial(
            origin_guard,
            token=token,
            cutoff=cutoff,
            start=start,
            requests=requests,
            indices=indices,
        )
        try:
            rows = _prediction_window(
                panel,
                features,
                requests,
                indices,
                RAW,
                cutoff,
                path,
                checkpoint_guard=guard,
                window_start=start,
                retain_state=True,
            )
        except (ValueError, MemoryError) as error:
            write_json(
                directory.parent / "failure.json",
                {
                    "origin": str(cutoff.date()),
                    "error": str(error),
                    "requested_rows": int(eligible.sum()),
                    "expected_sha256": digest(directory.parent / "expected-events.csv"),
                    "status": "failed_no_selection",
                },
            )
            raise
        outputs.append(rows)
    return pd.concat(outputs, ignore_index=True)


@bounded_window_research
def evaluate_coupon_updates(panel, as_of, directory, baseline, input_sha256):
    directory, baseline = Path(directory), Path(baseline)
    directory.mkdir(parents=True, exist_ok=True)
    requests = panel.requests((1, 14, 30))
    features = panel.features(requests, include_quote_history=True)
    eligible = requests.origin.ge("2023-01-01") & requests.label_available_date.lt(
        pd.Timestamp(as_of)
    )
    expected = _short_expected(requests, features, eligible)
    controls, sources = frozen_controls(
        baseline,
        expected,
        panel=panel,
        as_of=as_of,
        requests=requests,
        features=features,
    )
    expected_path = directory / "expected-events.csv"
    if not expected_path.exists():
        _atomic_csv(expected_path, expected)
    pd.testing.assert_frame_equal(
        pd.read_csv(expected_path), pd.read_csv(StringIO(expected.to_csv(index=False)))
    )
    identity = {
        "policy": POLICY,
        "input_sha256": input_sha256,
        "sources": source_hashes(),
        "runtime": runtime_identity(),
        "expected_sha256": digest(expected_path),
        "requests_sha256": frame_sha(requests),
        "features_sha256": frame_sha(features),
        "frozen_controls": sources,
        "candidate": asdict(RAW),
        "as_of": str(as_of),
    }
    immutable_json(directory / "protocol.json", identity)
    token = digest(directory / "protocol.json")
    monthly = _monthly_predictions(
        panel,
        features,
        requests,
        eligible,
        RAW,
        directory / "monthly-reproduction",
        checkpoint_guard=partial(checkpoint_guard, token=token, candidate=RAW),
    )
    monthly = validate_rows(monthly, expected)
    keys = ["bond_code", "origin", "lead_days"]
    check = monthly.merge(
        controls[RAW.name][keys + ["predicted_bp"]],
        on=keys,
        validate="one_to_one",
        suffixes=("", "_frozen"),
    )
    maximum = float(np.max(np.abs(check.predicted_bp - check.predicted_bp_frozen)))
    if maximum > 1e-9:
        raise ValueError(
            "monthly default predictions no longer reproduce frozen control"
        )
    rows = _updated_predictions(
        panel, features, requests, eligible, directory / "origin", token
    )
    result = summarize_updates(rows, expected, controls)
    result.update(
        protocol_sha256=token,
        monthly_reproduction_max_difference_bp=maximum,
        monthly_reproduction_rows=len(check),
        origin_fits=int(requests.loc[eligible].origin.nunique()),
        policy=POLICY,
    )
    _atomic_csv(directory / "origin-predictions.csv", rows)
    write_json(directory / "cadence-evaluation.json", result)
    return result
