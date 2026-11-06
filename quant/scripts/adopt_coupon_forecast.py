"""Fit the fixed Huber coupon model on a research training table and write the package + replay evidence."""

import argparse
import hashlib
import json
from pathlib import Path
import sys

import pandas as pd
from sklearn.linear_model import HuberRegressor
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from data.coupon_inputs import fetch_inputs  # noqa: E402
from data.issuance_calendar import CALENDAR_2026  # noqa: E402
from model import coupon_forecast as cf  # noqa: E402

RETRAIN_AFTER = "2026-12-31"


def fit(training, as_of):
    columns = cf.columns()
    ev = pd.read_pickle(training)
    ev = ev[ev.issuer_median.notna() & (ev.label_date + pd.Timedelta(days=1) < pd.Timestamp(as_of))].sort_values(["tender_date", "bond_code"])
    pool = ev.dropna(subset=columns + ["catch_up_hat"])
    x = pool[columns].to_numpy(float)
    y = (pool.dev_bp - pool.issuer_median - pool.catch_up_hat).to_numpy(float)
    alpha = cf.ALPHA
    scaler = StandardScaler().fit(x)
    huber = HuberRegressor(alpha=alpha, max_iter=2000).fit(scaler.transform(x), y)
    model = {
        "kind": "coupon_huber", "columns": columns, "alpha": alpha,
        "mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist(),
        "coef": huber.coef_.tolist(), "intercept": float(huber.intercept_),
    }
    return model, {"training_events": int(len(pool)), "training_label_cutoff": str(pool.label_date.max().date()),
                   "first_event": str(pool.tender_date.min().date())}


def validation_block(path, trained, model):
    """The walk-forward artifact must describe exactly the model being packaged."""
    walk = json.loads(Path(path).read_text())
    spec = walk.get("spec") or {}
    wanted = hashlib.sha256(json.dumps(sorted(model["columns"]), ensure_ascii=False).encode()).hexdigest()
    if (spec.get("alpha") != model["alpha"] or spec.get("model") != "huber" or spec.get("columns_sha256") != wanted
            or spec.get("target") != "dev_bp-issuer_median-catch_up_hat"):
        raise ValueError("Walk-forward artifact does not describe the packaged model")
    def metrics(period, span):
        d = period["S1|huber"]
        return {"start": span[0], "end": span[1], "sample_count": period["n"], "mae_bp": d["mae"], "hit_rate_5bp": d["hit5"], "win_rate_vs_issuer_median": d["win"]}
    return {
        "validation_scope": "walk_forward", "status": "post_hoc_selected",
        "training_events": trained["training_events"], "first_training_event": trained["first_event"],
        "development": metrics(walk["dev"], walk["spans"]["dev"]),
        "holdout": metrics(walk["hold2026"], walk["spans"]["holdout"]),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--training", required=True)
    parser.add_argument("--walk-forward", required=True)
    parser.add_argument("--timing-result", required=True, help="same-day timing-advice-v2 result.json")
    parser.add_argument("--output", required=True)
    parser.add_argument("--as-of", required=True)
    args = parser.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    model, trained = fit(args.training, args.as_of)
    raw = json.dumps(model, ensure_ascii=False, sort_keys=True).encode()
    version = hashlib.sha256(raw).hexdigest()[:20]
    (out / "model-main.json").write_text(json.dumps(model, ensure_ascii=False))
    sha = hashlib.sha256((out / "model-main.json").read_bytes()).hexdigest()
    manifest = {
        "feature_version": cf.FEATURE_VERSION, "model_version": version, "training_as_of": args.as_of,
        "training_label_cutoff": trained["training_label_cutoff"], "retrain_after": RETRAIN_AFTER,
        "calendar": CALENDAR_2026, "validation": validation_block(args.walk_forward, trained, model),
        "models": {"main": {"file": "model-main.json", "sha256": sha}},
    }
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    inputs = fetch_inputs(args.as_of)
    (out / "inputs.json").write_text(json.dumps(inputs, ensure_ascii=False))
    timing = json.loads(Path(args.timing_result).read_text())
    timing_in = {"catch_up_bp": timing["forecast"]["catch_up_bp"], "wait_bp": timing["forecast"]["wait_bp"], "action": timing["decision"]["action"]}
    (out / "timing.json").write_text(json.dumps(timing_in))
    snapshot = cf.coupon_snapshot(manifest, model, inputs, timing_in)
    (out / "python-result.json").write_text(json.dumps(snapshot, ensure_ascii=False))
    print(json.dumps({"model_version": version, **trained, "alpha": model["alpha"],
                      "forecast": {p["key"]: round(p["coupon_pct"], 4) for p in snapshot["products"]}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
