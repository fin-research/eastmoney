"""Walk-forward validation of the catch-up forecast; read-only Neon, no training outside the run."""

import argparse
import json
from pathlib import Path
import sys

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from model import timing_nowcast as nowcast  # noqa: E402
from timing_diagnostics import edb_series, fetch, sector_series  # noqa: E402

CODES = {
    "CDB3": "E1701708",
    "G3": "E1000174",
    "G1": "E1000172",
    "G10": "E1000180",
    "AAA3": "E1000413",
}
FIRST_FORECAST = "2021-01-01"


def block_stat_ci(frame, statistic, block=10, draws=2000, seed=0):
    """Moving-block bootstrap of a statistic of the whole frame; keeps overlap dependence."""
    if len(frame) < 3 * block:
        return [None, None]
    rng = np.random.default_rng(seed)
    starts = np.arange(len(frame) - block + 1)
    count = int(np.ceil(len(frame) / block))
    values = []
    for _ in range(draws):
        rows = np.concatenate(
            [np.arange(s, s + block) for s in rng.choice(starts, count)]
        )
        values.append(statistic(frame.iloc[rows[: len(frame)]]))
    return np.nanpercentile(values, [2.5, 97.5]).round(3).tolist()


def spread(threshold):
    """Waiting saving on wait calls minus the same saving on issue calls, bp."""

    def statistic(part):
        wait = -part.y[part.f < -threshold]
        issue = -part.y[part.f > threshold]
        if wait.empty or issue.empty:
            return np.nan
        return wait.mean() - issue.mean()

    return statistic


def inputs():
    sector = sector_series()
    liquid = pd.DataFrame({name: edb_series(code) for name, code in CODES.items()})
    return sector, liquid, edb_series("E1300004")


def r_squared(forecast, actual):
    return float(1 - ((actual - forecast) ** 2).sum() / (actual**2).sum())


def accuracy(forecasts, target):
    result = {}
    for name in forecasts:
        both = pd.DataFrame({"f": forecasts[name], "y": target[name]}).dropna()
        result[name] = {
            "origins": len(both),
            "corr": float(both.f.corr(both.y)),
            "r2_vs_no_change": r_squared(both.f, both.y),
            "mae_no_change": float(both.y.abs().mean()),
            "mae_model": float((both.y - both.f).abs().mean()),
            "by_year": {
                int(year): {
                    "corr": float(part.f.corr(part.y)),
                    "r2": r_squared(part.f, part.y),
                }
                for year, part in both.groupby(both.index.year)
            },
        }
    return result


def calls(forecasts, target, thresholds=(0.3, 0.5, 1.0)):
    result = {}
    for name in forecasts:
        if not name.startswith("wait_"):
            continue
        both = pd.DataFrame({"f": forecasts[name], "y": target[name]}).dropna()
        result[name] = {"unconditional_saving_from_waiting_bp": float(-both.y.mean())}
        for threshold in thresholds:
            wait = -both.y[both.f < -threshold]
            issue = -both.y[both.f > threshold]
            statistic = spread(threshold)
            result[name][str(threshold)] = {
                "wait_calls": len(wait),
                "wait_saving_bp": float(wait.mean()),
                "issue_calls": len(issue),
                "issue_call_saving_from_waiting_bp": float(issue.mean()),
                "spread_bp": float(statistic(both)),
                "spread_ci95": block_stat_ci(both, statistic),
            }
    return result


def coupon_link(forecast, sector):
    """Does the actual public 3Y broker coupon move with the forecast catch-up?"""
    rows = fetch(
        "SELECT tender_date,final_coupon_pct::float8 FROM public.bond_issuance"
        " WHERE bond_type='证券公司债' AND placement_type='公募' AND interest_rate_type='固息'"
        " AND NOT COALESCE(has_option,false) AND original_tenor_years BETWEEN 2.8 AND 3.2"
        " AND NOT COALESCE(pricing_invalid_code,false) AND tender_date IS NOT NULL"
        " AND final_coupon_pct IS NOT NULL ORDER BY tender_date",
        (),
    )
    index = sector.index
    records = []
    for tender, coupon in rows:
        date = pd.Timestamp(tender)
        position = index.searchsorted(date)
        if position < 2 or position >= len(index) or index[position] != date:
            continue
        previous = index[position - 1]
        if previous not in forecast.index:
            continue
        records.append(
            (
                date,
                coupon * 100 - sector.iloc[position - 1],
                forecast[previous],
                sector.iloc[position] - sector.iloc[position - 1],
            )
        )
    frame = pd.DataFrame(records, columns=["date", "level", "forecast", "realized"])
    frame["premium"] = frame.level - frame.level.rolling(
        40, min_periods=15
    ).median().shift(1)
    frame = frame.dropna()
    result = {
        "coupons": len(frame),
        "premium_mad_bp": float(frame.premium.abs().mean()),
    }
    for column in ("forecast", "realized"):
        slope = float(np.polyfit(frame[column], frame.premium, 1)[0])
        rng = np.random.default_rng(0)
        draws = []
        for _ in range(2000):
            sample = frame.iloc[rng.integers(0, len(frame), len(frame))]
            draws.append(np.polyfit(sample[column], sample.premium, 1)[0])
        result[f"{column}_slope"] = {
            "slope": slope,
            "ci95": np.percentile(draws, [2.5, 97.5]).round(3).tolist(),
        }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    sector, liquid, funding = inputs()
    features = nowcast.build_features(sector, liquid, funding)
    target = nowcast.targets(sector)
    forecasts = nowcast.walk_forward(features, target, FIRST_FORECAST)
    autoregressive = nowcast.walk_forward(
        features[[c for c in features if c.startswith("sector_")]],
        target,
        FIRST_FORECAST,
        horizons={"catch_up": 0},
    )
    model = nowcast.fit(features, target["wait_3"])
    latest = features.iloc[[-1]]
    expected = float(nowcast.predict(model, latest)[0])
    report = {
        "accuracy": accuracy(forecasts, target),
        "catch_up_autoregressive_only": accuracy(autoregressive, target)["catch_up"],
        "calls": calls(forecasts, target),
        "coupon_link": coupon_link(forecasts["catch_up"], sector),
        "latest": {
            "last_quote": str(features.index[-1].date()),
            "expected_wait_3_bp": expected,
            "action": nowcast.signal(expected),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report["latest"], ensure_ascii=False))


if __name__ == "__main__":
    main()
