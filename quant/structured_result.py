"""融资择时模型的结构化快照契约与本地归档。"""

from __future__ import annotations

import json
import math
import uuid

from artifacts import json_safe as _json_safe
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any


SNAPSHOT_SCHEMA_VERSION = 3
MODEL_NAME = "bond_financing_timing_lgbm"
DEFAULT_OUTPUT_PATH = Path("outputs/financing_model_latest.json")


def build_financing_model_snapshot(assessment: dict) -> dict:
    """把当日评分结果转换为稳定、可上传的 JSON 契约。"""
    forecast = _json_safe(assessment.get("forecast_window", []))
    readiness = _json_safe(assessment.get("company_metrics")) or None
    validation = _json_safe(assessment.get("validation_summary", {}))
    drivers = _json_safe(assessment.get("market_drivers", []))
    driver_groups = _json_safe(assessment.get("driver_structure", []))
    product_recommendation = _json_safe(assessment.get("product_recommendation", {}))
    as_of_date = str(assessment["as_of_date"])
    generated_at = datetime.now(timezone.utc).isoformat()

    snapshot = {
        "schema_version": SNAPSHOT_SCHEMA_VERSION,
        "run_id": str(uuid.uuid4()),
        "model_name": MODEL_NAME,
        "generated_at": generated_at,
        "as_of_date": as_of_date,
        "market_data_date": assessment["market_data_date"],
        "issue_terms": {
            "issue_size_billion_yuan": assessment["issue_size"],
            "tenor_years": assessment["tenor"],
            "rating": assessment["rating"],
            "bond_type": assessment["bond_type"],
        },
        "prediction": {
            "deviation_bp": assessment["pred_bp"],
            "peer_spread_median_bp": assessment["peer_spread_median"],
            "historical_percentile": assessment["percentile"],
            "recommendation": assessment["recommend"],
            "recommendation_label": assessment["label"],
            "window_zone": assessment["window_zone"],
            "decision": assessment["decision"],
        },
        "company_metrics": readiness,
        "market_drivers": drivers,
        "driver_structure": driver_groups,
        "product_recommendation": product_recommendation,
        "forecast_window": forecast,
        "validation": validation,
        "base_conclusion": _build_base_conclusion(assessment, readiness, forecast),
        "source_freshness": {
            "market_data_date": assessment["market_data_date"],
            "company_metrics_date": readiness.get("date") if readiness else None,
            "subject_spread_date": (
                readiness.get("ef_subject_spread_date") if readiness else None
            ),
        },
    }
    return _json_safe(snapshot)


def write_financing_model_snapshot(
    snapshot: dict,
    output_path: str | Path = DEFAULT_OUTPUT_PATH,
) -> Path:
    """将结构化快照写入本地未跟踪目录，便于核对与重放上传。"""
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    return path


def _build_base_conclusion(
    assessment: dict,
    readiness: dict | None,
    forecast: list[dict],
) -> dict:
    preferred = _preferred_window(forecast)
    deviation = float(assessment["pred_bp"])
    percentile = float(assessment["percentile"])
    market_sentence = (
        f"模型预测发行利差相对近30日可比债中位数偏离 {deviation:+.2f} bp，"
        f"处于历史 P{percentile:.0f}。"
    )
    if readiness:
        company_sentence = (
            f"公司流动性状态为{readiness.get('readiness_label', '数据不足')}。"
        )
    else:
        company_sentence = "公司业务指标暂无可用快照。"
    window_sentence = (
        f"未来窗口中相对更优日期为{preferred['label']}。"
        if preferred["dates"]
        else "未来窗口暂无可用预测。"
    )
    return {
        "verdict": assessment["decision"],
        "preferred_window": preferred["label"],
        "narrative": market_sentence + company_sentence + window_sentence,
        "preferred_dates": preferred["dates"],
    }


def _preferred_window(forecast: list[dict], limit: int = 3) -> dict:
    valid = [
        row
        for row in forecast
        if isinstance(row, dict)
        and isinstance(row.get("date"), str)
        and _finite_number(row.get("pred_bp")) is not None
    ]
    selected = sorted(valid, key=lambda row: float(row["pred_bp"]))[:limit]
    dates = sorted(row["date"] for row in selected)
    return {
        "dates": dates,
        "label": "、".join(_month_day(value) for value in dates) if dates else "待定",
    }


def _month_day(value: str) -> str:
    parsed = date.fromisoformat(value)
    return f"{parsed.month}月{parsed.day}日"


def _signed_number(value: Any, digits: int) -> str:
    number = _finite_number(value)
    return "NA" if number is None else f"{number:+.{digits}f}"


def _finite_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None
