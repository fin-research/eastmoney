"""Record a user-selected frozen model; research scores are never release gates."""

import argparse
from dataclasses import asdict
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from model.frozen_mlp import POLICY, load_frozen_release
from model.issuance_study_protocol import digest, immutable_json
from model.issuance_unified import CouponCandidate


def adopt(study_root, summary_path, output):
    root, summary_path = Path(study_root).resolve(), Path(summary_path).resolve()
    inventory_path = root / "inventory.final.json"
    inventory = json.loads(inventory_path.read_text())
    for item in inventory:
        if digest(root / item["path"]) != item["sha256"]:
            raise ValueError("sealed study inventory mismatch")
    summary = json.loads(summary_path.read_text())
    if summary["inventory_sha256"] != digest(inventory_path):
        raise ValueError("summary does not identify this sealed study")
    source_files = {
        "state": root / "study/validation-2026.state.json",
        "receipt": root / "study/validation-2026.receipt.json",
        "optimizer": root / "study/validation-2026.optimizer.json",
        "optimizer_raw": root / "study/validation-2026.optimizer-raw.npz",
        "optimizer_warnings": root
        / "study/validation-2026.optimizer-raw.warnings.json",
        "predictions": root / "study/validation-2026.csv",
        "protocol": root / "study/protocol.json",
        "audit": root / "study/all-independent-audit.json",
        "inventory": inventory_path,
        "summary": summary_path,
    }
    rows = json.loads((root / "study/protocol.json").read_text())["folds"]
    validation = next(row for row in rows if row["name"] == "validation-2026")
    value = {
        "release_policy": POLICY,
        "candidate": asdict(
            CouponCandidate("mlp", "coupon", 0, feature_set="quote_history")
        ),
        "issuance_scope": "public_only",
        "estimand": "conditional_mean",
        "expected_savings_supported": False,
        "training_label_cutoff": "2026-01-01",
        "forecast_horizons": [1, 14, 30],
        "sample_count": summary["validation"]["events"],
        "prediction_start": validation["cutoff"],
        "prediction_end": validation["end"],
        "metrics": [{**row, "year": 2026} for row in summary["validation"]["metrics"]],
        "training_tscv": summary["tscv"],
        "historical_qualification": {
            "tscv": summary["tscv"]["qualified"],
            "validation": summary["validation"]["qualified"],
        },
        "adoption": {
            "authorized_by": "user",
            "date": "2026-10-26",
            "reason": "Adopt this improved version; historical research gates do not block release.",
            "restored_without_fit": True,
        },
        "status": "user-selected frozen coupon model; historical validation, not new forward evidence",
        "sources": {
            name: {"path": str(path), "sha256": digest(path)}
            for name, path in source_files.items()
        },
    }
    immutable_json(Path(output), value)
    return load_frozen_release(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--study-root", type=Path, required=True)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    adopt(args.study_root, args.summary, args.output)
    print(f"Selected frozen MLP: {args.output}")
