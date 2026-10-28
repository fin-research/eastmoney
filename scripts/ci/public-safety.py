"""Keep credentials, local research data and licensed SDK binaries out of Git."""

from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
PATTERNS = {
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "credentialed database URL": re.compile(
        r"postgres(?:ql)?://[^\s:/@]+:[^\s/@]+@", re.I
    ),
    "GitHub token": re.compile(r"gh[pousr]_[A-Za-z0-9_]{20,}"),
    "AWS access key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
}


def main():
    names = (
        subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
        .decode()
        .split("\0")
    )
    violations = []
    for name in filter(None, names):
        path = Path(name)
        if (
            any(
                part in {".venv", ".Codex", "outputs", "node_modules"}
                for part in path.parts
            )
            or ((path.name.startswith(".env") or path.name.startswith(".dev.vars")) and not path.name.endswith(".example"))
            or name.startswith("choice/vendor/linux-x64/")
            or (
                name.startswith("quant/")
                and path.suffix.lower()
                in {".xlsx", ".xls", ".parquet", ".pkl", ".joblib"}
            )
        ):
            violations.append(f"restricted file: {name}")
            continue
        try:
            content = subprocess.check_output(["git", "show", f":{name}"], cwd=ROOT).decode()
        except (UnicodeError, OSError):
            continue
        for label, pattern in PATTERNS.items():
            matches = list(pattern.finditer(content))
            if label == "credentialed database URL":
                real = []
                for match in matches:
                    uri = content[match.start():].split()[0].split('"')[0].split("'")[0]
                    parsed = urlsplit(uri)
                    local_test = parsed.username == "test" and parsed.password == "test" and parsed.hostname in {"localhost", "127.0.0.1", "::1"} and (
                        "/tests/" in name or name.endswith("scripts/verify-financing-routes.mjs")
                    )
                    template = name.endswith(".example") and parsed.username == "USER" and parsed.password == "PASSWORD" and parsed.hostname == "host"
                    if not (local_test or template):
                        real.append(match)
                matches = real
            if matches:
                violations.append(f"{label}: {name}")
    if violations:
        raise SystemExit("\n".join(violations))
    print(f"Public content check passed: {len(list(filter(None, names)))} files.")


if __name__ == "__main__":
    main()
