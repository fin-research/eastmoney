"""Validate aggregate evidence independently of rendering and file operations."""


def validate_evidence(data):
    if data["schema_version"] != 1:
        raise ValueError("unsupported research report schema")
    rows = data["development"]["rows"]
    if len(rows) != data["development"]["configs"]:
        raise ValueError("incomplete development matrix")
    if len({r["name"] for r in rows}) != len(rows):
        raise ValueError("duplicate development candidates")
    _validate_development(rows, data["development"]["events"])
    _validate_historical(data["historical"]["rows"])
    if data["production"]["expected_savings_supported"] is not False:
        raise ValueError("point model must preserve null savings semantics")
    for study in data["market_studies"]:
        if study.get("diagnostics"):
            _validate_market_diagnostics(study)
    for study in data.get("calibration_studies", []):
        _validate_calibration(study)


def _validate_calibration(study):
    if study["production_eligible"] is not False:
        raise ValueError("historical calibration cannot authorize production")
    for row in study["candidates"]:
        _validate_development(
            [row["gates"]["h30"]["candidate"]], study["h30"]["requested"]
        )
        if (
            row["event_horizon_rows"] != study["rows"]
            or sum(g["requested"] for g in row["coverage"].values()) != study["rows"]
            or any(
                g["active"] + g["fallback"] != g["requested"]
                for g in row["coverage"].values()
            )
            or row["issuer_interval"]["samples"] != study["h30"]["samples"]
            or row["gates"]["paired_month_interval"]["samples"]
            != study["h30"]["samples"]
        ):
            raise ValueError("calibration evidence denominator differs")


def _validate_market_diagnostics(study):
    expected = {r["name"]: r["samples"] for r in study["rows"]}
    if {r["name"] for r in study["diagnostics"]} != set(expected):
        raise ValueError("market diagnostics candidates differ")
    for row in study["diagnostics"]:
        count = expected[row["name"]]
        for interval in row["paired_vs_huber"].values():
            if interval["samples"] != count:
                raise ValueError("market paired denominators differ")
        if row.get("market"):
            market = row["market"]
            if (
                market["samples"] != count
                or market["training_constant"]["samples"] != count
            ):
                raise ValueError("market diagnostic denominators differ")


def _validate_development(rows, events):
    for row in rows:
        if row["requested"] != events:
            raise ValueError("development denominators differ")
        if row["samples"] + row["missing"] != row["requested"]:
            raise ValueError("development coverage differs")


def _validate_historical(rows):
    for row in rows:
        if row["samples"] + row["missing"] != row["requested"]:
            raise ValueError("historical coverage differs")
        if not 0 <= row["hit_rate_5bp"] <= 1:
            raise ValueError("invalid hit rate")
