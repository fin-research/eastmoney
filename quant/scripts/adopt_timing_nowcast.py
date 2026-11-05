"""Export the short-horizon catch-up forecast as a timing package, one fixed final fit.

Reads Neon (read-only), refits both ridge targets on every matured origin and
writes model-main.json and manifest.json. Nothing is uploaded or published.
"""

import argparse
import hashlib
import json
from pathlib import Path
import sys

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from data.issuance_calendar import CALENDAR_2026  # noqa: E402
from model import timing_nowcast as nowcast  # noqa: E402
import timing_nowcast_validation as study  # noqa: E402

THRESHOLD_KEY = str(nowcast.SIGNAL_BP)
WAIT = f"wait_{nowcast.WAIT_TARGET}"


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validation(forecasts, target):
    accuracy = study.accuracy(forecasts, target)
    both = forecasts[WAIT].to_frame("f").join(target[WAIT].rename("y")).dropna()
    low, high = study.block_stat_ci(both, study.spread(nowcast.SIGNAL_BP))
    spread = float(study.spread(nowcast.SIGNAL_BP)(both))
    return {
        "status": "post_hoc_selected",
        "validation_scope": "walk_forward",
        "sample_count": accuracy["catch_up"]["origins"],
        "prediction_start": str(forecasts.index[0].date()),
        "prediction_end": str(both.index[-1].date()),
        "catch_up_corr": accuracy["catch_up"]["corr"],
        "catch_up_r2": accuracy["catch_up"]["r2_vs_no_change"],
        "wait_corr": accuracy[WAIT]["corr"],
        "spread_bp": spread,
        "spread_ci_low_bp": min(low, spread),
        "spread_ci_high_bp": max(high, spread),
    }, (both.y - both.f)


def main(args):
    sector, liquid, funding = study.inputs()
    features = nowcast.build_features(sector, liquid, funding)
    target = nowcast.targets(sector)
    forecasts = nowcast.walk_forward(features, target, study.FIRST_FORECAST)
    checks, residuals = validation(forecasts, target)
    # Quote date of the last window end used by the final fit; it must precede training_as_of.
    matured = features.join(target[[WAIT, "catch_up"]]).dropna()
    last_origin = matured.index[-1]
    cutoff = sector.index[sector.index.get_loc(last_origin) + 1 + nowcast.WAIT_TARGET]
    if not cutoff < pd.Timestamp(args.as_of):
        raise ValueError("Training labels must end before the package date")
    model = nowcast.export_model(features, target, residuals)
    args.output.mkdir(parents=True, exist_ok=False)
    checksum = dump(args.output / "model-main.json", model)
    version = checksum[:20]
    dump(
        args.output / "manifest.json",
        {
            "schema_version": 1,
            "feature_version": nowcast.FEATURE_VERSION,
            "model_version": version,
            "training_as_of": args.as_of,
            "retrain_after": "2026-12-31",
            "training_label_cutoff": str(cutoff.date()),
            "scope": "AAA证券公司债3Y",
            "models": {"main": {"file": "model-main.json", "sha256": checksum}},
            "calendar": CALENDAR_2026,
            "validation": checks,
            "adoption": {
                "authorized_by": "user",
                "reason": "Replace timing-advice-v1 with the model that is better on the 2026 holdout",
                "research_qualified": False,
                "new_validation": True,
            },
        },
    )
    print(json.dumps({"model_version": version, "cutoff": str(cutoff.date())}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--as-of", required=True)
    main(parser.parse_args())
