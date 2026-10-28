"""Register a new reproduction without changing any original study evidence."""

import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from model.issuance_study_protocol import (  # noqa: E402
    digest,
    immutable_json,
    registered_candidates,
)
from research_sources import runtime_identity, source_hashes  # noqa: E402


def _git_location():
    repository = Path(subprocess.check_output(
        ["git", "rev-parse", "--show-toplevel"], cwd=ROOT, text=True
    ).strip())
    return repository, ROOT.relative_to(repository)


def _restored_commit(name, checksum):
    repository, prefix = _git_location()
    git_name = (prefix / name).as_posix()
    revisions = subprocess.check_output(
        ["git", "log", "--format=%H", "--", git_name],
        cwd=repository,
        text=True,
    ).splitlines()
    for revision in revisions:
        result = subprocess.run(
            ["git", "show", f"{revision}:{git_name}"],
            cwd=repository,
            capture_output=True,
        )
        if (
            result.returncode == 0
            and hashlib.sha256(result.stdout).hexdigest() == checksum
        ):
            return revision
    return None


def register(request, point, snapshot, directory):
    if subprocess.check_output(["git", "status", "--porcelain", "--", "."], cwd=ROOT).strip():
        raise ValueError(
            "Commit the reviewed implementation before freezing a reproduction"
        )
    original = json.loads(request.read_text())
    protocol = request.parent / "development/protocol.json"
    selection = request.parent / "development/selection.json"
    if (
        digest(snapshot) != original["input_sha256"]
        or digest(Path(original["nodes_path"])) != original["nodes_sha256"]
    ):
        raise ValueError("Original input or node hash changed")
    current = source_hashes()
    development = json.loads(protocol.read_text())
    point_policy = json.loads((point / "protocol.json").read_text())
    rows = []
    for scope, sources in (
        ("development", development["identity"]["code"]),
        ("point_training", point_policy["identity"]["code"]),
        ("point_publication", point_policy["release_code"]),
    ):
        for name, checksum in sources.items():
            rows.append(
                {
                    "scope": scope,
                    "source": name,
                    "original_sha256": checksum,
                    "current_sha256": current.get(name),
                    "changed": checksum != current.get(name),
                    "original_git_revision": _restored_commit(name, checksum),
                }
            )
    directory.mkdir(parents=True, exist_ok=True)
    inventory = directory / "migration-inventory.json"
    revision = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
    ).strip()
    immutable_json(
        inventory,
        {
            "purpose": "reproduction-under-current-code",
            "source_revision": revision,
            "current_sources": current,
            "runtime": runtime_identity(),
            "original_sources": rows,
            "original_evidence": {
                role: {"path": str(path), "sha256": digest(path)}
                for role, path in {
                    "spec": request,
                    "protocol": protocol,
                    "selection": selection,
                    "point_protocol": point / "protocol.json",
                    "point_validation": point / "validation.json",
                    "point_release": point / "release-evaluation.json",
                }.items()
            },
            "semantic_changes": [
                "Application functions retain their original AST; CLI keeps arguments and resource restart semantics.",
                "Existing market-separation changes added pricing-date reference and market-known-zero handling.",
                "Existing fixed symmetric 5bp hit rate is a metric revision; original sigma scores are not renamed.",
                "Default market_change=none field expands candidate serialization without changing schema5 model parameters.",
                "Source closure now includes every current application, model/data adapter, script, JS mirror and dependency lock.",
            ],
            "acceptance": "Complete original candidate matrix; compare common event keys, labels, maturity, monthly predictions, diagnostics and timing; no new forward evidence.",
        },
    )
    reproduction = {
        "purpose": "reproduction-under-current-code",
        "source_revision": revision,
        "original_spec_sha256": digest(request),
        "original_protocol_sha256": digest(protocol),
        "original_selection_sha256": digest(selection),
        "inventory_sha256": digest(inventory),
    }
    spec = {
        **original,
        "candidates": [asdict(c) for c in registered_candidates(original)],
        "reproduction": reproduction,
    }
    for stage in ("smoke", "development"):
        immutable_json(directory / f"{stage}.json", {**spec, "stage": stage})
    print(
        json.dumps(
            {
                "source_revision": revision,
                "source_files": len(current),
                "changes": sum(row["changed"] for row in rows),
                "directory": str(directory),
            }
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original-request", type=Path, required=True)
    parser.add_argument("--original-point", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    register(
        args.original_request.resolve(),
        args.original_point.resolve(),
        args.snapshot.resolve(),
        args.output.resolve(),
    )
