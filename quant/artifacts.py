"""确定性产物序列化；不加载模型、数据客户端或历史业务报告。"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import date, datetime
from numbers import Integral, Real
from pathlib import Path
from tempfile import NamedTemporaryFile


def json_safe(value):
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Integral):
        return int(value)
    if isinstance(value, Real):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    raise TypeError(f"结构化快照包含不支持的类型: {type(value).__name__}")


def write_json(path: Path, value: object) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    value = json_safe(value)
    with NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, delete=False
    ) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(
                value,
                stream,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            )
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        with temporary.open("rb") as stream:
            checksum = hashlib.file_digest(stream, "sha256").hexdigest()
        temporary.replace(path)
        return checksum
    finally:
        temporary.unlink(missing_ok=True)


def export_tree(node: dict) -> dict:
    if "leaf_value" in node:
        return {key: node[key] for key in ("leaf_value", "leaf_count") if key in node}
    if node["decision_type"] not in ("<=", "=="):
        raise ValueError("Unsupported regression tree split")
    keys = (
        "split_feature",
        "threshold",
        "decision_type",
        "default_left",
        "missing_type",
        "internal_count",
    )
    return {
        **{key: node[key] for key in keys},
        "left_child": export_tree(node["left_child"]),
        "right_child": export_tree(node["right_child"]),
    }
