"""Export the user-selected D algorithm with one fixed final parameter fit."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys

import numpy as np
import pandas as pd
from scipy.optimize import minimize

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from data.issuance_calendar import CALENDAR_2026  # noqa: E402
from model.research_resources import bounded_command, bounded_window_research  # noqa: E402


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))
    return hashlib.sha256(path.read_bytes()).hexdigest()


@bounded_window_research
def main(args):
    study_path = args.study / "code/inner_transfer_v2.py"
    sys.path.insert(0, str(study_path.parent))
    spec = importlib.util.spec_from_file_location("selected_timing_study", study_path)
    study = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(study)
    assert json.loads((study.OUT / "independent-audit.json").read_text())["pass"]
    args.output.mkdir(parents=True, exist_ok=False)
    data = study.tasks()
    cutoff = pd.Timestamp("2026-01-01")
    sector = data["sector3"]
    train = study.support.purged_training_index(sector["labels"], cutoff)
    train = train[np.isfinite(sector["X"].loc[train]).all(axis=1)]
    train = train.rename(None)
    centers, _, center_audit = study.core.head.learned_centers(
        sector["a"].loc[train].to_numpy()
    )
    assert center_audit["identifiable"]
    _, transform = study.core.head.standardize(sector["X"].loc[train].to_numpy())
    split = {"cutoff": "2026-01-01", "train_dates": train}
    manifest, coverage = study.sample(data, split, "D_all_history")
    blocks, targets = [], []
    for task in study.TASKS:
        index = pd.DatetimeIndex(manifest.loc[manifest.task.eq(task), "origin"])
        blocks.append(study.design(data[task]["X"].loc[index], transform, task))
        targets.append(
            study.core.head.nearest(data[task]["a"].loc[index].to_numpy(), centers)
        )
        assert (
            data[task]["labels"]
            .loc[index, ["deadline", "label_end"]]
            .lt(cutoff)
            .all()
            .all()
        )
    Z, y, weights = (
        np.vstack(blocks),
        np.concatenate(targets),
        manifest.weight.to_numpy(),
    )
    result = minimize(
        study.objective,
        np.zeros(290),
        args=(Z, y, weights),
        method="L-BFGS-B",
        jac=True,
        options=study.core.head.OPTIONS,
    )
    value, gradient = study.objective(result.x, Z, y, weights)
    bound = float(gradient @ gradient / 0.2)
    if bound > 1e-6:
        raise ValueError("Final timing fit failed complete gradient certificate")
    model = {
        "kind": "linear_timing",
        "features": list(sector["X"]),
        "mean": transform["mean"].tolist(),
        "std": transform["std"].tolist(),
        "constant": transform["constant"].tolist(),
        "theta": result.x.tolist(),
        "centers": centers.tolist(),
        "training_label_cutoff": "2025-12-31",
        "fit": {
            "objective": value,
            "gap_bound": bound,
            "n": len(Z),
            "sector_n": len(train),
        },
    }
    checksum = dump(args.output / "model-main.json", model)
    version = checksum[:20]
    summary = (
        pd.read_csv(study.OUT / "validation-summary.csv")
        .set_index("arm")
        .loc["D_all_history"]
    )
    validation = {
        "status": "user_selected_exploratory",
        "validation_scope": "inner_development",
        "sample_count": int(summary.n),
        "prediction_start": "2022-07-01",
        "prediction_end": "2023-03-01",
        "logloss": float(summary.logloss),
        "brier": float(summary.Brier),
        "immediate_tp": int(summary.immediate_tp),
        "immediate_fp": int(summary.immediate_fp),
        "immediate_target": int(summary.immediate_target_n),
        "immediate_precision": float(summary.immediate_precision),
        "immediate_recall": float(summary.immediate_recall),
        "selected_a_mean_bp": float(summary.immediate_predicted_a_mean_bp),
    }
    package = {
        "schema_version": 1,
        "feature_version": "timing-advice-v1",
        "model_version": version,
        "training_as_of": args.as_of,
        "retrain_after": "2026-12-31",
        "training_label_cutoff": "2025-12-31",
        "scope": "AAA证券公司债3Y",
        "models": {"main": {"file": "model-main.json", "sha256": checksum}},
        "calendar": CALENDAR_2026,
        "validation": validation,
        "adoption": {
            "authorized_by": "user",
            "reason": "Publish current selected candidate while research is paused",
            "research_qualified": False,
            "new_validation": False,
        },
    }
    dump(args.output / "manifest.json", package)
    manifest.to_csv(args.output / "training-manifest.csv", index=False)
    dump(
        args.output / "selection.json",
        {
            "selected": "D_all_history",
            "algorithm_unchanged": True,
            "new_final_fits": 1,
            "source_sha256": study.core.parent.digest(study.core.parent.old.SOURCE),
            "study_sha256": study.core.parent.digest(study_path),
            "audit_sha256": study.core.parent.digest(
                study.OUT / "independent-audit.json"
            ),
            "summary_sha256": study.core.parent.digest(
                study.OUT / "validation-summary.csv"
            ),
            "coverage": coverage,
            "fit": model["fit"],
        },
    )
    print(json.dumps({"model_version": version, "fit": model["fit"]}), flush=True)


if __name__ == "__main__":
    if os.environ.get("QUANT_BOUNDED_PROCESS") != "1":
        raise SystemExit(bounded_command([sys.executable, __file__, *sys.argv[1:]]))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--study", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--as-of", default="2026-10-28")
    main(parser.parse_args())
