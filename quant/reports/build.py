"""Check the single authored Markdown report and its evidence/source review."""

import json
from pathlib import Path
import hashlib

from research_sources import source_hashes as source_hashes
from .evidence import validate_evidence as validate_evidence
from .short_evidence import validate_short_evidence

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "README.md"
REVIEW = ROOT / "reports/review.json"


def build(check=False, note=None):
    if check and note is not None:
        raise ValueError("检查模式不能更新审阅记录")
    if (ROOT / "REPORT.html").exists():
        raise ValueError("REPORT.html已退役，唯一研究报告是README.md")
    validate_evidence(json.loads((ROOT / "reports/research.json").read_text()))
    evidence_path = ROOT / "reports/short-coupon.json"
    validate_short_evidence(json.loads(evidence_path.read_text()))
    evidence_sha = hashlib.sha256(evidence_path.read_bytes()).hexdigest()
    timing_sha = hashlib.sha256(
        (ROOT / "reports/timing-advice.json").read_bytes()
    ).hexdigest()
    current = source_hashes()
    report_sha = hashlib.sha256(REPORT.read_bytes()).hexdigest()
    if note is not None:
        if not note.strip():
            raise ValueError("source review needs a substantive note")
        REVIEW.write_text(
            json.dumps(
                {
                    "note": note,
                    "source_hashes": current,
                    "readme_sha256": report_sha,
                    "short_evidence_sha256": evidence_sha,
                    "timing_evidence_sha256": timing_sha,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        )
    review = json.loads(REVIEW.read_text())
    if review["source_hashes"] != current:
        raise ValueError("模型实现已变化：更新README研究报告并审阅源码")
    if review.get("short_evidence_sha256") != evidence_sha:
        raise ValueError("新研究证据与审阅记录不一致")
    if review.get("timing_evidence_sha256") != timing_sha:
        raise ValueError("择时证据与审阅记录不一致")
    if review.get("readme_sha256") != report_sha:
        raise ValueError("README.md与审阅记录不一致，请核对研究报告")
    return REPORT
