"""Run a fixed representation hypothesis through the existing short-coupon study."""

import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data.issuance_training import IssuancePanel  # noqa: E402
from model.issuance_study_protocol import immutable_json  # noqa: E402
from model.research_resources import bounded_command, release_training_memory  # noqa: E402
from model.short_coupon import evaluate_short_coupons  # noqa: E402


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument(
        "--representation",
        choices=(
            "raw",
            "curve_pca3",
            "product_quote",
            "curve_pls3_market",
            "origin_updates",
            "primary_batch",
            "raw_tree",
        ),
        default="raw",
    )
    parser.add_argument("--inner", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.representation != "raw":
        parser.error("旧表示实验已归档。当前仅运行全历史TSCV及2026年固定验证。")
    if (args.representation == "origin_updates") != (args.baseline is not None):
        parser.error("--baseline is required only for origin_updates")
    if not args.inner:
        raise SystemExit(
            bounded_command(
                [
                    sys.executable,
                    "-m",
                    "scripts.short_coupon_curve",
                    *sys.argv[1:],
                    "--inner",
                ],
                checkpoint_restart=True,
            )
        )
    args.output.mkdir(parents=True, exist_ok=True)
    hypothesis = {
        "protocol": "fixed-pre2026-v1",
        "representation": "raw",
        "input_sha256": hashlib.sha256(args.snapshot.read_bytes()).hexdigest(),
        "training": "all reliable pre-2026 data; annual expanding TSCV",
        "validation": "2026 origins with one frozen model; no 2026 labels or coupon-derived history",
        "models": "existing static Ridge, raw-history Ridge and Huber control; no algorithm expansion",
        "option_filter": "none",
        "parameter_search": False,
        "output_rules": "none",
    }
    immutable_json(args.output / "hypothesis.json", hypothesis)
    inputs = json.loads(args.snapshot.read_text())
    inputs["issuance_scope"] = "public_only"
    date = inputs["as_of_date"]
    panel = IssuancePanel.from_inputs(inputs)
    del inputs
    release_training_memory()
    result = evaluate_short_coupons(panel, date, args.output)
    print(
        json.dumps({"status": result["status"], "candidate": result.get("candidate")}),
        flush=True,
    )


if __name__ == "__main__":
    run()
