"""Official-source exclusions shared with JS; never infer offering method from codes."""

import json
from pathlib import Path


SCOPE_FILE = Path(__file__).resolve().parents[1] / "online/issuance-exclusions.json"
ISSUANCE_SCOPE = json.loads(SCOPE_FILE.read_text())
EXCLUDED_PRIVATE_CODES = frozenset(
    code for entry in ISSUANCE_SCOPE["entries"] for code in entry["codes"]
)


def excluded_private_mask(bonds):
    return bonds.bond_code.astype(str).str.upper().isin(EXCLUDED_PRIVATE_CODES)
