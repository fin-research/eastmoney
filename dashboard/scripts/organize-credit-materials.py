"""Organize credit materials, including the authorized public-directory migration."""

import argparse
import datetime as dt
import hashlib
import json
import re
from pathlib import Path

SUPPORTED = {".pdf", ".doc", ".docx", ".xls", ".xlsx"}
CATEGORIES = {
    "定期报告",
    "财务报表",
    "信用评级",
    "风控与监管指标",
    "业务与经营数据",
    "债券批复",
    "授信答复与银行反馈",
}


def destination(relative):
    parts = relative.parts
    name = relative.name
    year = re.search(r"20\d{2}", name)
    year = year[0] if year else ""
    # Run these migrations before the already-organized fast path. A regulatory
    # special audit is confidential even though its name contains 审计报告.
    if "风险控制指标监管报表专项审计报告" in name:
        return Path("风控与监管指标") / (year + "年" if year else "其他") / name
    if relative == Path("风控与监管指标/历年汇总/监管指标.xlsx") or relative == Path(
        "监管指标.xlsx"
    ):
        return Path("定期报告/财务与监管指标.xlsx")
    if parts[0] == "定期报告与审计":
        return Path("定期报告", *parts[1:])
    if parts[0] in CATEGORIES and (parts[0] != "财务报表" or len(parts) > 2):
        return relative
    if parts[0] == "授信资料反馈" or name.startswith("授信答复"):
        group = (
            parts[1]
            if len(parts) > 2
            else next(
                (
                    bank
                    for bank in [
                        "齐鲁银行",
                        "吉林银行",
                        "黄河银行",
                        "汉寿农商银行",
                        "衡阳农商行",
                    ]
                    if bank in name
                ),
                "通用答复",
            )
        )
        return Path("授信答复与银行反馈") / group / name
    if "信用评级报告" in name:
        return Path("信用评级") / (year + "年" if year else "其他") / name
    if "审计报告" in name or re.search("公司债券.*报告|财务报表及附注", name):
        return (
            Path("定期报告")
            / (year + ("半年度" if "半年度" in name else "年度") if year else "其他")
            / name
        )
    if parts[0] == "财务报表":
        short = re.match(r"(\d{2})Q", name)
        year = year or ("20" + short[1] if short else "")
        return Path("财务报表") / (year + "年" if year else "其他") / name
    if parts[0] == "风控指标" or name == "监管指标.xlsx":
        group = "历年汇总" if "统计" in name or not year else year + "年"
        return Path("风控与监管指标") / group / name
    if parts[0] == "债券批复情况":
        return Path("债券批复") / name
    return (
        Path("业务与经营数据") / ("经营排名" if "排名" in name else "业务情况") / name
    )


def organize(source, manifest, apply=False):
    entries = []
    targets = set()
    for file in sorted(source.rglob("*")):
        relative = file.relative_to(source)
        if (
            not file.is_file()
            or any(p.startswith((".", "~$")) for p in relative.parts)
            or file.suffix.lower() not in SUPPORTED
        ):
            continue
        target = destination(relative)
        key = target.as_posix().casefold()
        if key in targets:
            raise ValueError(f"目标文件名冲突：{target}")
        targets.add(key)
        if relative != target and (source / target).exists():
            raise FileExistsError(target)
        entries.append(
            {
                "from": relative.as_posix(),
                "to": target.as_posix(),
                "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
                "bytes": file.stat().st_size,
            }
        )
    report = {
        "source": str(source),
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "applied": False,
        "files": entries,
    }
    manifest.parent.mkdir(parents=True, exist_ok=True)
    if manifest.exists():
        raise FileExistsError("保留已有整理清单，请使用新的 --manifest 路径")
    manifest.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    if apply:
        for item in entries:
            original, target = source / item["from"], source / item["to"]
            if original != target:
                target.parent.mkdir(parents=True, exist_ok=True)
                original.rename(target)
            if hashlib.sha256(target.read_bytes()).hexdigest() != item["sha256"]:
                raise ValueError(f"文件校验失败：{target}")
        for folder in sorted(
            (p for p in source.rglob("*") if p.is_dir()),
            key=lambda p: len(p.parts),
            reverse=True,
        ):
            if not any(p.startswith(".") for p in folder.relative_to(source).parts):
                try:
                    folder.rmdir()
                except OSError:
                    pass
        report["applied"] = True
        manifest.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    for item in entries:
        print(f"{item['from']} -> {item['to']}")
    print(
        json.dumps(
            {
                "files": len(entries),
                "moved": sum(x["from"] != x["to"] for x in entries),
                "applied": apply,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    organize(args.source.expanduser().resolve(), args.manifest.resolve(), args.apply)
