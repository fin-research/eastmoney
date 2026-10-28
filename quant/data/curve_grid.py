"""Decode lossless curve-grid-v1 transport; never fill or filter observations."""

from datetime import date
import math


def decode_curve_inputs(inputs):
    value = inputs["datasets"].get("industry_nodes")
    if value is None or isinstance(value, list):
        return inputs
    if (
        not isinstance(value, dict)
        or value.get("encoding") != "curve-grid-v1"
        or value.get("curve_code") != "5781a1ff7651967e0176978d957b7346"
        or value.get("curve_name") != "中债证券公司债收益率曲线(AAA)"
        or not isinstance(value.get("rows"), list)
        or not value["rows"]
    ):
        raise ValueError("invalid curve grid transport")
    records = []
    previous = ("", 0)
    for row in value["rows"]:
        if not isinstance(row, list) or len(row) != 3:
            raise ValueError("invalid curve grid row")
        day, tenor, yield_pct = row
        valid_day = isinstance(day, str) and len(day) == 10
        try:
            valid_day = valid_day and date.fromisoformat(day).isoformat() == day
        except ValueError:
            valid_day = False
        if (
            not valid_day
            or type(tenor) not in (float, int)
            or not math.isfinite(tenor)
            or tenor <= 0
            or (
                yield_pct is not None
                and (
                    type(yield_pct) not in (float, int) or not math.isfinite(yield_pct)
                )
            )
            or (day, tenor) <= previous
        ):
            raise ValueError("invalid or unordered curve grid row")
        previous = (day, tenor)
        records.append(
            {
                "curve_code": value["curve_code"],
                "curve_name": value["curve_name"],
                "observation_date": day,
                "tenor_years": tenor,
                "yield_pct": yield_pct,
            }
        )
    return {**inputs, "datasets": {**inputs["datasets"], "industry_nodes": records}}
