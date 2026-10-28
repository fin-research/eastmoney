"""Reject files and credential patterns that must never enter this repository."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROHIBITED_SUFFIXES = {
    ".doc",
    ".docx",
    ".feather",
    ".joblib",
    ".key",
    ".ods",
    ".parquet",
    ".pfx",
    ".pkl",
    ".pickle",
    ".xls",
    ".xlsb",
    ".xlsm",
    ".xlsx",
}
PROHIBITED_PARTS = {".Codex", "outputs"}
PROHIBITED_NAMES = {"report.md"}
COMPANY_DATA_NAME_MARKERS = (
    "业务数据",
    "资金计划",
    "主体利差",
    "company_market_bridge",
)
COMPANY_DATA_SUFFIXES = {
    ".csv",
    ".db",
    ".duckdb",
    ".json",
    ".jsonl",
    ".sqlite",
    ".sqlite3",
    ".tsv",
}
SECRET_PATTERNS = {
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "credentialed database URL": re.compile(
        r"postgres(?:ql)?://[^\s:/@]+:[^\s/@]+@",
        re.IGNORECASE,
    ),
    "GitHub token": re.compile(r"gh[pousr]_[A-Za-z0-9_]{20,}"),
    "AWS access key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "assigned secret": re.compile(
        r"(?:DATABASE_URL|CHOICE_AUTH|R2_SECRET_ACCESS_KEY|"
        r"AWS_SECRET_ACCESS_KEY|CLOUDFLARE_API_TOKEN)\s*=\s*[\"'][^\"']+[\"']",
    ),
}


def tracked_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return [
        ROOT / value.decode("utf-8") for value in result.stdout.split(b"\0") if value
    ]


def main() -> int:
    violations: list[str] = []
    for file_path in tracked_files():
        relative = file_path.relative_to(ROOT)
        if (
            file_path.suffix.lower() in PROHIBITED_SUFFIXES
            or any(part in PROHIBITED_PARTS for part in relative.parts)
            or relative.as_posix() in PROHIBITED_NAMES
            or (
                file_path.suffix.lower() in COMPANY_DATA_SUFFIXES
                and any(
                    marker in relative.as_posix()
                    for marker in COMPANY_DATA_NAME_MARKERS
                )
            )
        ):
            violations.append(f"restricted file: {relative}")
            continue

        try:
            content = file_path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for label, pattern in SECRET_PATTERNS.items():
            if pattern.search(content):
                violations.append(f"{label}: {relative}")

    if violations:
        print("Repository data-safety check failed:")
        for violation in sorted(set(violations)):
            print(f"- {violation}")
        return 1

    print("Repository data-safety check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
