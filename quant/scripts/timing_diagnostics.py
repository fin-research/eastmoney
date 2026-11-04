"""Read-only diagnostics for the timing package: matured-label scoring and range calibration.

Rebuilds the fixed package's probabilities for every historical quote date from
Neon, scores them against matured 30-day labels, checks the direction-free
range model out of sample, and tests whether the mean-reversion sign is stable
on government yields from 2003. Nothing is trained, published or fetched from
Choice.
"""

import argparse
import json
import os
from pathlib import Path
import sys

import certifi
from dotenv import load_dotenv
import numpy as np
import pandas as pd
import psycopg

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from data.online_inputs import INDUSTRY_CURVE_CODE, SOURCES, source_frame  # noqa: E402
from data.rate_data import build_rate_dataset  # noqa: E402
from model.timing_advice import ACTIONS, timing_probabilities  # noqa: E402
from model.timing_range import daily_scale, range_forecast, window_change  # noqa: E402

PERIODS = {
    "train_2021_2025": ("2021-01-01", "2025-12-31"),
    "holdout_2026": ("2026-01-01", "2026-12-31"),
}
GOVERNMENT = {"E1000172": "gov_1y", "E1000183": "gov_30y", "E1000180": "gov_10y"}
ERAS = {"2003_2010": (2003, 2010), "2011_2018": (2011, 2018), "2019_2026": (2019, 2026)}


def connect():
    load_dotenv()
    connection = psycopg.connect(
        os.environ["DATABASE_URL"],
        sslrootcert=certifi.where(),
        connect_timeout=15,
        keepalives_idle=30,
        keepalives_interval=10,
        keepalives_count=3,
        application_name="quant-timing-diagnostics",
    )
    connection.execute("SET TRANSACTION READ ONLY")
    return connection


def fetch(sql, params):
    with connect() as connection:
        return connection.execute(sql, params).fetchall()


def edb_rows(code, since):
    return fetch(
        "SELECT indicator_code,observation_date::text,published_date::text,value::float8"
        " FROM public.edb WHERE indicator_code=%s AND observation_date>=%s::date"
        " ORDER BY observation_date",
        (code, since),
    )


def sector_series():
    rows = fetch(
        "SELECT observation_date,yield_pct::float8 FROM public.bond_industry_curve"
        " WHERE curve_code=%s AND tenor_years=3 ORDER BY observation_date",
        (INDUSTRY_CURVE_CODE,),
    )
    frame = pd.DataFrame(rows, columns=["date", "yield_pct"])
    return pd.Series(
        frame.yield_pct.to_numpy() * 100, index=pd.to_datetime(frame.date)
    ).sort_index()


def package_probabilities(model, sector):
    rows = [
        {
            "field": code,
            "observation_date": date,
            "published_date": published,
            "value": value,
        }
        for code in SOURCES["funding"]
        for _, date, published, value in edb_rows(code, "2018-06-01")
    ]
    raw = source_frame("funding", rows)
    common = build_rate_dataset(
        Path("diagnostics"), funding_frame=raw, extra_groups=("rate_path",)
    ).market_features.filter(like="path_")
    own = (
        build_rate_dataset(
            Path("diagnostics"),
            funding_frame=raw.assign(AAA_3Y=sector.div(100).reindex(raw.index)),
            extra_groups=("rate_path",),
        )
        .market_features.filter(like="path_aaa_3y_")
        .rename(columns=lambda key: key.replace("aaa_3y", "own"))
    )
    features = pd.concat([common, own], axis=1).reindex(columns=model["features"])
    features = features.dropna()
    return pd.DataFrame(
        [timing_probabilities(model, row) for row in features.to_numpy()],
        index=features.index,
        columns=["defer", "wait", "issue"],
    )


def score_package(probabilities, labels, centers):
    table = probabilities.join(labels.rename("change_bp"), how="inner").dropna()
    centers = np.asarray(centers)
    table["target"] = np.abs(table.change_bp.to_numpy()[:, None] - centers).argmin(1)
    table["pick"] = table[["defer", "wait", "issue"]].to_numpy().argmax(1)
    result = {}
    train = table.loc[PERIODS["train_2021_2025"][0] : PERIODS["train_2021_2025"][1]]
    prior = np.bincount(train.target, minlength=3) / len(train)
    for name, (start, end) in PERIODS.items():
        part = table.loc[start:end]
        if part.empty:
            continue
        share = np.bincount(part.target, minlength=3) / len(part)
        chosen = part[["defer", "wait", "issue"]].to_numpy()[
            np.arange(len(part)), part.target.to_numpy()
        ]
        result[name] = {
            "origins": len(part),
            "accuracy": float((part.pick == part.target).mean()),
            "majority_accuracy": float(share.max()),
            "logloss": float(-np.log(np.clip(chosen, 1e-12, 1)).mean()),
            "ex_ante_prior_logloss": float(-(share * np.log(prior)).sum()),
            "label_entropy": float(
                -(share[share > 0] * np.log(share[share > 0])).sum()
            ),
            "class_share": dict(zip(ACTIONS, share.round(4).tolist(), strict=True)),
            "pick_share": dict(
                zip(
                    ACTIONS,
                    (np.bincount(part.pick, minlength=3) / len(part)).round(4).tolist(),
                    strict=True,
                )
            ),
            "spearman_issue_minus_defer": float(
                (part.issue - part.defer).corr(part.change_bp, method="spearman")
            ),
            "label_std_bp": float(part.change_bp.std()),
        }
    return result


def range_calibration(levels, start="2021-06-01"):
    labels = window_change(levels)
    rows = []
    for i, date in enumerate(levels.index):
        if date < pd.Timestamp(start) or np.isnan(labels.iloc[i]):
            continue
        try:
            forecast = range_forecast(levels.iloc[: i + 1])
        except ValueError:
            continue
        rows.append(
            {
                "date": date,
                "change": labels.iloc[i],
                "half50": forecast["bands_bp"]["50"][1],
                "half80": forecast["bands_bp"]["80"][1],
                "p_material": forecast["p_material_move"],
            }
        )
    frame = pd.DataFrame(rows).set_index("date")
    material = frame.change.abs() > forecast["material_bp"]
    baseline = material.expanding().mean().shift(1).fillna(0.5)
    by_year = frame.assign(material=material).groupby(frame.index.year)
    return {
        "origins": len(frame),
        "coverage_50": float((frame.change.abs() <= frame.half50).mean()),
        "coverage_80": float((frame.change.abs() <= frame.half80).mean()),
        "material_brier": float(((frame.p_material - material) ** 2).mean()),
        "material_brier_expanding_frequency": float(
            ((baseline - material) ** 2).mean()
        ),
        "by_year": {
            int(year): {
                "origins": len(part),
                "coverage_80": float((part.change.abs() <= part.half80).mean()),
                "predicted_material": float(part.p_material.mean()),
                "realized_material": float(part.material.mean()),
            }
            for year, part in by_year
        },
    }


def direction_stability(seed=0, draws=2000):
    """Spearman of the 250-quote deviation against the volatility-scaled label."""
    rng = np.random.default_rng(seed)
    result = {}
    for code, name in GOVERNMENT.items():
        rows = edb_rows(code, "2002-01-01")
        series = pd.Series(
            [row[3] * 100 for row in rows],
            index=pd.to_datetime([row[1] for row in rows]),
        )
        series = series[series > 0].groupby(level=0).last().sort_index()
        change = series.diff()
        deviation = (series - series.rolling(250).mean()) / change.rolling(250).std()
        target = window_change(series) / daily_scale(series)
        frame = pd.DataFrame({"x": deviation, "y": target}).dropna()
        result[name] = {}
        for era, (first, last) in ERAS.items():
            part = frame[(frame.index.year >= first) & (frame.index.year <= last)]
            part = part.iloc[::21]
            if len(part) < 30:
                continue
            ic = part.x.corr(part.y, method="spearman")
            draws_ic = [
                part.iloc[rng.integers(0, len(part), len(part))]
                .reset_index(drop=True)
                .pipe(lambda s: s.x.corr(s.y, method="spearman"))
                for _ in range(draws)
            ]
            low, high = np.percentile(draws_ic, [2.5, 97.5])
            result[name][era] = {
                "samples": len(part),
                "spearman": float(ic),
                "ci95": [float(low), float(high)],
            }
    return result


def curve_smoothness(sector):
    """Daily-change autocorrelation and 5-day variance ratio since 2019."""
    result = {}
    for name, series in (
        ("sector_3y", sector),
        ("cdb_3y", edb_series("E1701708")),
        ("gov_3y", edb_series("E1000174")),
    ):
        series = series.loc["2019":]
        changes = series.diff().dropna()
        result[name] = {
            "autocorr_lag1": float(changes.autocorr(1)),
            "autocorr_lag2": float(changes.autocorr(2)),
            "autocorr_lag3": float(changes.autocorr(3)),
            "variance_ratio_5": float(series.diff(5).var() / (5 * changes.var())),
        }
    return result


def edb_series(code):
    rows = edb_rows(code, "2018-06-01")
    return pd.Series(
        [row[3] * 100 for row in rows], index=pd.to_datetime([row[1] for row in rows])
    ).sort_index()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path, help="timing package directory")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    model = json.loads((args.bundle / "model-main.json").read_text())
    sector = sector_series()
    labels = window_change(sector)
    report = {
        "model_version": json.loads((args.bundle / "manifest.json").read_text())[
            "model_version"
        ],
        "package_on_matured_labels": score_package(
            package_probabilities(model, sector), labels, model["centers"]
        ),
        "range_model": range_calibration(sector),
        "current_range": range_forecast(sector),
        "direction_stability": direction_stability(),
        "curve_smoothness": curve_smoothness(sector),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report["current_range"], ensure_ascii=False))


if __name__ == "__main__":
    main()
