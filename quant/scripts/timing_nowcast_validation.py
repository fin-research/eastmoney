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
from model.timing_range import window_change  # noqa: E402
from data.online_inputs import INDUSTRY_CURVE_CODE  # noqa: E402
from timing_diagnostics import (  # noqa: E402
    edb_series,
    fetch,
    package_probabilities,
    sector_series,
)

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
    liquid = pd.DataFrame(
        {name: edb_series(code) for name, code in nowcast.CODES.items()}
    )
    return sector, liquid, edb_series(nowcast.FUNDING_CODE)


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


def curve_matrix():
    """Sector curve at every published tenor, bp, by quote date; one query per year."""
    rows = []
    for year in range(2019, pd.Timestamp.today().year + 1):
        rows += fetch(
            "SELECT observation_date,tenor_years::float8,yield_pct::float8"
            " FROM public.bond_industry_curve WHERE curve_code=%s"
            " AND tenor_years BETWEEN 0.4 AND 10.1 AND observation_date>=%s::date"
            " AND observation_date<%s::date",
            (INDUSTRY_CURVE_CODE, f"{year}-01-01", f"{year + 1}-01-01"),
        )
    frame = pd.DataFrame(rows, columns=["date", "tenor", "yield_pct"])
    frame["date"] = pd.to_datetime(frame.date)
    return (
        frame.pivot(index="date", columns="tenor", values="yield_pct").sort_index()
        * 100
    )


def coupon_sample(curve, catch_up, wait_3):
    """Public fixed-rate broker bonds priced on a quote date, matched to the curve tenor."""
    rows = fetch(
        "SELECT tender_date,issuer_name,bond_type,original_tenor_years::float8,"
        "final_coupon_pct::float8,issue_amount_100m::float8 FROM public.bond_issuance"
        " WHERE placement_type='公募' AND interest_rate_type='固息'"
        " AND NOT COALESCE(has_option,false) AND NOT COALESCE(pricing_invalid_code,false)"
        " AND tender_date IS NOT NULL AND final_coupon_pct IS NOT NULL"
        " AND original_tenor_years BETWEEN 0.9 AND 10.1 ORDER BY tender_date,bond_code",
        (),
    )
    index = curve.index
    tenors = curve.columns.to_numpy(float)
    records = []
    for tender, issuer, kind, tenor, coupon, amount in rows:
        date = pd.Timestamp(tender)
        position = index.searchsorted(date)
        if position < 2 or position + 3 >= len(index) or index[position] != date:
            continue
        previous = index[position - 1]
        column = int(np.abs(tenors - tenor).argmin())
        if previous not in catch_up.index or abs(tenors[column] - tenor) > 0.26:
            continue
        records.append(
            {
                "date": date,
                "issuer": issuer,
                "kind": kind,
                "tenor": tenor,
                "amount": amount,
                "premium": coupon * 100 - curve.iloc[position - 1, column],
                "realized": curve.iloc[position, column]
                - curve.iloc[position - 1, column],
                "waited": curve.iloc[position + 3, column]
                - curve.iloc[position, column],
                "catch_up": catch_up[previous],
                "wait_3": wait_3.get(previous, np.nan),
            }
        )
    frame = pd.DataFrame(records)
    history, baseline = {}, []
    for row in frame.itertuples():
        past = history.setdefault((row.issuer, row.kind), [])
        baseline.append(np.median(past[-5:]) if len(past) >= 2 else np.nan)
        past.append(row.premium)
    frame["deviation"] = frame.premium - np.array(baseline)
    return frame.dropna(subset=["deviation", "catch_up"]).loc[
        lambda f: f.deviation.abs() < 60
    ]


def cluster_ci(frame, statistic, block=10, draws=1500, seed=0):
    """Moving-block bootstrap over consecutive pricing dates.

    Coupons priced on neighbouring days share most of their outcome window and
    forecast, so whole runs of ``block`` pricing dates are resampled together.
    """
    rng = np.random.default_rng(seed)
    groups = {date: part for date, part in frame.groupby("date")}
    dates = sorted(groups)
    starts = np.arange(max(len(dates) - block + 1, 1))
    count = int(np.ceil(len(dates) / block))
    values = []
    for _ in range(draws):
        picked = [
            groups[date]
            for start in rng.choice(starts, count)
            for date in dates[start : start + block]
        ]
        values.append(statistic(pd.concat(picked)))
    return np.nanpercentile(values, [2.5, 97.5]).round(3).tolist()


def slope(column):
    return lambda part: float(np.polyfit(part[column], part.deviation, 1)[0])


def coupon_link(sample):
    """Coupon premium over the issuer's own recent premium against the curve move."""
    return {
        "coupons": len(sample),
        "deviation_mad_bp": float(sample.deviation.abs().mean()),
        **{
            f"{column}_slope": {
                "slope": slope(column)(sample),
                "ci95": cluster_ci(sample, slope(column)),
            }
            for column in ("catch_up", "realized")
        },
        "mae_last_quote": float(sample.deviation.abs().mean()),
        "mae_with_catch_up": float((sample.deviation - sample.catch_up).abs().mean()),
    }


def coupon_signal_backtest(sample, threshold=nowcast.SIGNAL_BP):
    """Counterfactual: wait three quotes on a 暂缓 signal, else issue on the actual date.

    The saving is the move of the bond's own tenor on the curve, valid because the
    coupon moves one for one with the curve (see coupon_link).
    """
    sample = sample.dropna(subset=["wait_3"]).assign(saving=lambda f: -f.waited)

    def spread(part):
        wait = part.saving[part.wait_3 < -threshold]
        issue = part.saving[part.wait_3 > threshold]
        return float(wait.mean() - issue.mean())

    def policy(part):
        return float(np.where(part.wait_3 < -threshold, part.saving, 0.0).mean())

    wait, issue = (
        sample[sample.wait_3 < -threshold],
        sample[sample.wait_3 > threshold],
    )
    followed = np.where(sample.wait_3 < -threshold, sample.saving, 0.0)
    return {
        "issuances": len(sample),
        "wait_calls": len(wait),
        "wait_saving_bp": float(wait.saving.mean()),
        "issue_calls": len(issue),
        "issue_call_saving_from_waiting_bp": float(issue.saving.mean()),
        "spread_bp": spread(sample),
        "spread_ci95": cluster_ci(sample, spread),
        "policy_mean_saving_bp": policy(sample),
        "policy_mean_saving_ci95": cluster_ci(sample, policy),
        "always_wait_mean_saving_bp": float(sample.saving.mean()),
        "policy_interest_saved_10k_yuan": float(
            (followed / 1e4 * sample.amount * 1e8 * sample.tenor).sum() / 1e4
        ),
    }


PERIODS = {
    "2021_2026": ("2021-01-01", "2026-12-31"),
    "2023_2026": ("2023-01-01", "2026-12-31"),
    "2026": ("2026-01-01", "2026-12-31"),
}
FROZEN_CUTOFF = pd.Timestamp("2025-12-31")
FROZEN_PERIODS = {
    "train_2021_2025": ("2021-01-01", "2025-12-31"),
    "test_2026": ("2026-01-01", "2026-12-31"),
}


def tercile_edge(score, outcome, start, end):
    """Spearman, and waiting saving in the lowest score tercile minus the highest."""
    frame = pd.DataFrame({"score": score, "y": outcome}).dropna().loc[start:end]
    if len(frame) < 60:
        return None
    tercile = pd.qcut(frame.score.rank(method="first"), 3, labels=False)
    return {
        "origins": len(frame),
        "spearman": float(frame.score.corr(frame.y, method="spearman")),
        "tercile_spread_bp": float(
            (-frame.y[tercile == 0]).mean() - (-frame.y[tercile == 2]).mean()
        ),
    }


def versus_deployed(features, target, sector, bundle):
    """Same origins and outcomes; the deployed package was fitted on labels to 2025."""
    model = json.loads((bundle / "model-main.json").read_text())
    probabilities = package_probabilities(model, sector)
    deployed = probabilities.issue - probabilities.defer
    outcomes = target.assign(window_30d=window_change(sector, 30))
    forecast = nowcast.walk_forward(
        features,
        outcomes,
        FIRST_FORECAST,
        horizons={"wait_3": 3, "window_30d": 21},
    )
    result = {}
    for outcome in ("wait_3", "window_30d"):
        common = forecast[outcome].dropna().index.intersection(deployed.dropna().index)
        common = common[outcomes[outcome].reindex(common).notna()]
        result[outcome] = {
            period: {
                "catch_up_model": tercile_edge(
                    forecast[outcome].loc[common], outcomes[outcome], *span
                ),
                "deployed_package": tercile_edge(
                    deployed.loc[common], outcomes[outcome], *span
                ),
            }
            for period, span in PERIODS.items()
        }
    result["frozen_split"] = frozen_split(features, outcomes, deployed)
    return result


def frozen_split(features, outcomes, deployed):
    """Both models fitted on labels to 2025: train period in-sample, 2026 held out."""
    result = {}
    complete = features.dropna()
    for outcome, extra in (("wait_3", 3), ("window_30d", 21)):
        train = features.index[
            features.index
            <= FROZEN_CUTOFF - pd.Timedelta(days=int((extra + 1) * 1.6) + 4)
        ]
        model = nowcast.fit(features.loc[train], outcomes[outcome].loc[train])
        score = pd.Series(nowcast.predict(model, complete), index=complete.index)
        common = score.index.intersection(deployed.dropna().index)
        result[outcome] = {
            period: {
                "catch_up_model": tercile_edge(
                    score.loc[common], outcomes[outcome], *span
                ),
                "deployed_package": tercile_edge(
                    deployed.loc[common], outcomes[outcome], *span
                ),
            }
            for period, span in FROZEN_PERIODS.items()
        }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, help="timing package for the comparison")
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
    sample = coupon_sample(curve_matrix(), forecasts.catch_up, forecasts.wait_3)
    model = nowcast.fit(features, target["wait_3"])
    latest = features.iloc[[-1]]
    expected = float(nowcast.predict(model, latest)[0])
    report = {
        "accuracy": accuracy(forecasts, target),
        "catch_up_autoregressive_only": accuracy(autoregressive, target)["catch_up"],
        "calls": calls(forecasts, target),
        "coupon_link": coupon_link(sample),
        "coupon_signal_backtest": coupon_signal_backtest(sample),
        **(
            {"versus_deployed": versus_deployed(features, target, sector, args.bundle)}
            if args.bundle
            else {}
        ),
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
