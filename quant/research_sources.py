"""Conservative executable-source closure for research and report identities."""

import hashlib
from os.path import relpath
from importlib.metadata import version
from pathlib import Path
import platform
import sys
import subprocess

ROOT = Path(__file__).resolve().parent
PACKAGES = (
    "numpy",
    "scipy",
    "pandas",
    "scikit-learn",
    "lightgbm",
    "shap",
    "threadpoolctl",
)


def source_hashes(root=ROOT):
    root = Path(root)
    files = list(root.glob("*.py"))
    for directory in ("application", "model", "data", "choice", "scripts"):
        files.extend((root / directory).rglob("*.py"))
    files.extend(
        p
        for p in (root / "online").glob("*")
        if p.suffix in {".mjs", ".ts", ".json", ".jsonc", ".yaml"}
        and p.name != "worker-configuration.d.ts"
    )
    files.extend(root / name for name in ("pyproject.toml", "uv.lock"))
    files.extend(
        root.parent / name
        for name in ("package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml")
    )
    return {
        Path(relpath(p, root)).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(set(files))
        if p.is_file()
    }


def runtime_identity():
    return {
        "python": platform.python_version(),
        "implementation": sys.implementation.name,
        "node": subprocess.check_output(["node", "--version"], text=True).strip(),
        "platform": sys.platform,
        "machine": platform.machine(),
        "packages": {name: version(name) for name in PACKAGES},
    }
