"""Register or run a fixed, non-publishable calibration study on old OOF receipts."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from model.issuance_calibration_study import register_study, run_study  # noqa: E402

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("register", "run"))
    parser.add_argument("--output", required=True)
    parser.add_argument("--source")
    parser.add_argument("--source-root")
    args = parser.parse_args()
    if args.action == "register":
        if not args.source or not args.source_root:
            parser.error("registration requires --source and --source-root")
        register_study(args.source, args.source_root, args.output)
        print("Registered immutable calibration protocol")
    else:
        result = run_study(args.output)
        print(
            json.dumps(
                {
                    "status": result["status"],
                    "selected": result["selected"],
                    "h30": result["h30"],
                    "candidates": [
                        {"name": r["name"], "gates": r["gates"]}
                        for r in result["candidates"]
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
