"""Offline immutable research registry. Does not fetch data or publish production results."""

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from application.prospective import (  # noqa: E402
    audit_registry,
    cancel_scheme,
    initialize,
    predict,
    register_batch,
    register_scheme,
    register_synthetic_label,
)
from data.prospective_ledger import Ledger  # noqa: E402


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", type=Path, required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init")
    init.add_argument("--study-id", required=True)
    init.add_argument("--candidate-method", type=Path, required=True)
    for name in ("scheme", "batch", "synthetic-label"):
        command = sub.add_parser(name)
        command.add_argument("--document", type=Path, required=True)
        if name == "scheme":
            command.add_argument("--source", type=Path, required=True)
    run = sub.add_parser("predict")
    for name in ("batch-id", "request-id"):
        run.add_argument("--" + name, required=True)
    for name in ("control-bundle", "candidate-bundle", "inputs"):
        run.add_argument("--" + name, type=Path, required=True)
    cancel = sub.add_parser("cancel")
    cancel.add_argument("--scheme-sha256", required=True)
    sub.add_parser("audit")
    return parser, parser.parse_args()


def execute(ledger, args):
    document = (
        json.loads(args.document.read_text()) if hasattr(args, "document") else None
    )
    if args.command == "init":
        return initialize(
            ledger, args.study_id, json.loads(args.candidate_method.read_text())
        )
    if args.command == "scheme":
        return register_scheme(ledger, document, args.source.read_bytes())
    if args.command == "batch":
        return register_batch(ledger, document)
    if args.command == "synthetic-label":
        return register_synthetic_label(ledger, document)
    if args.command == "predict":
        return predict(
            ledger,
            args.batch_id,
            args.request_id,
            args.control_bundle,
            args.candidate_bundle,
            args.inputs,
        )
    if args.command == "cancel":
        return cancel_scheme(ledger, args.scheme_sha256)
    return audit_registry(ledger)


def main():
    parser, args = arguments()
    directory = args.ledger.resolve()
    if not directory.is_relative_to(ROOT / "outputs"):
        parser.error(
            "Registry directory must be below this checkout's ignored outputs/"
        )
    result = execute(Ledger(directory), args)
    if args.command == "audit":
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    else:
        print(
            json.dumps(
                {
                    key: result[key]
                    for key in (
                        "sequence",
                        "kind",
                        "payload_sha256",
                        "event_sha256",
                        "time_anchor",
                    )
                }
            )
        )
        if (
            args.command == "predict"
            and result["payload"]["status"] != "paired_success"
        ):
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
