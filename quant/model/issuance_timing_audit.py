"""Same-origin coupon path decisions, evaluated only on a secondary curve proxy.

No synthetic daily primary coupons. Historical observed quote weekdays are a
calendar proxy; final issue terms are given retrospectively. These diagnostics
cannot establish realized issuer financing savings or authorize activation.
"""

import numpy as np
import pandas as pd

from data.issuance_industry_tenor import industry_tenor_features
from data.issuance_training import treasury_anchor


def coupon_timing_audit(panel, model, rows):
    output = []
    events = panel.events.set_index("bond_code")
    market = panel.rates.market_features
    for row in rows.loc[rows.lead_days.eq(30)].itertuples(index=False):
        origin = pd.Timestamp(row.origin)
        end = origin + pd.Timedelta(days=30)
        dates = market.index[(market.index >= origin) & (market.index <= end)]
        dates = dates[dates.dayofweek < 5]
        request = events.loc[row.bond_code].to_dict()
        requests = pd.DataFrame(
            [
                {**request, "origin": origin, "lead_days": (date - origin).days}
                for date in dates
            ]
        )
        record = {
            "bond_code": row.bond_code,
            "issuer": row.issuer,
            "origin": origin,
            "pricing_date": row.pricing_date,
            "rating": row.rating,
            "bond_type": row.bond_type,
            "tenor": row.tenor,
            "status": "missing_proxy",
            "dates": len(dates),
        }
        if not len(dates):
            output.append(record)
            continue
        features = panel.features(
            requests,
            include_weighted_primary=model.candidate.uses_weighted_primary,
            include_industry_tenor=model.candidate.uses_industry_tenor,
            include_curve_dynamics=model.candidate.uses_curve_dynamics,
            include_industry_basis=model.candidate.uses_industry_basis,
        )
        prediction = model.predict(features)
        # Realized quotes belong exclusively to this evaluator, never features.
        positions = market.index.searchsorted(dates, side="left") - 1
        realized_requests = requests.assign(origin=dates)
        proxy = industry_tenor_features(
            realized_requests,
            market.index[positions],
            treasury_anchor(market.iloc[positions], requests.tenor),
            panel.industry_nodes,
        ).industry_aaa_tenor_bp.to_numpy()
        if not np.isfinite(proxy).all():
            output.append(record)
            continue
        for waiting_cost in (0.0, 0.1, 0.25):
            elapsed = requests.lead_days.to_numpy()
            predicted_cost = prediction + elapsed * waiting_cost
            cost = proxy + elapsed * waiting_cost
            threshold = np.sort(predicted_cost)[int(np.ceil(len(dates) * 0.25)) - 1]
            selected = (
                0 if predicted_cost[0] <= threshold else int(np.argmin(predicted_cost))
            )
            fixed7 = int(np.abs(elapsed - 7).argmin())
            output.append(
                {
                    **record,
                    "status": "covered",
                    "waiting_cost_bp_day": waiting_cost,
                    "selected_date": dates[selected],
                    "selected_lead": int(elapsed[selected]),
                    "predicted_saving_bp": float(
                        predicted_cost[0] - predicted_cost[selected]
                    ),
                    "realized_saving_bp": float(cost[0] - cost[selected]),
                    "gain_vs_fixed7_bp": float(cost[fixed7] - cost[selected]),
                    "gain_vs_deadline_bp": float(cost[-1] - cost[selected]),
                    "regret_bp": float(cost[selected] - cost.min()),
                    "wrong_wait": bool(selected > 0 and cost[selected] > cost[0]),
                    "direction_error_bp": float(
                        (prediction[-1] - prediction[0]) - (proxy[-1] - proxy[0])
                    ),
                    "predicted_move_bp": float(prediction[-1] - prediction[0]),
                    "actual_proxy_move_bp": float(proxy[-1] - proxy[0]),
                }
            )
    return pd.DataFrame(output, columns=None if output else ["status"])


def clustered_mean_interval(rows, column, cluster):
    blocks = rows.groupby(cluster)[column].agg(["sum", "count"])
    if len(blocks) < 2:
        return None
    indices = np.random.default_rng(42).integers(0, len(blocks), (2000, len(blocks)))
    values = blocks["sum"].to_numpy()[indices].sum(axis=1) / blocks["count"].to_numpy()[
        indices
    ].sum(axis=1)
    return np.quantile(values, [0.025, 0.975]).tolist()


def timing_summary(rows):
    requested = rows.bond_code.nunique() if "bond_code" in rows else 0
    covered = rows.loc[rows.status.eq("covered")].copy()
    result = {
        "requested_events": requested,
        "covered_events": covered.bond_code.nunique() if len(covered) else 0,
        "proxy": "AAA sector tenor curve, observed quote weekday calendar",
        "primary_counterfactual_observed": False,
        "production_eligible": False,
        "scenarios": [],
    }
    if covered.empty:
        return result
    covered["month"] = pd.to_datetime(covered.origin).dt.to_period("M").astype(str)
    covered["year"] = pd.to_datetime(covered.origin).dt.year
    for waiting_cost, group in covered.groupby("waiting_cost_bp_day"):
        gain = group.realized_saving_bp
        tail = gain <= gain.quantile(0.05)
        result["scenarios"].append(
            {
                "waiting_cost_bp_day": float(waiting_cost),
                "events": len(group),
                "mean_gain_bp": float(gain.mean()),
                "median_gain_bp": float(gain.median()),
                "p05_gain_bp": float(gain.quantile(0.05)),
                "tail05_mean_bp": float(gain[tail].mean()),
                "wait_rate": float(group.selected_lead.gt(0).mean()),
                "wrong_wait_rate": float(group.wrong_wait.mean()),
                "mean_regret_bp": float(group.regret_bp.mean()),
                "direction_mae_bp": float(group.direction_error_bp.abs().mean()),
                "zero_change_mae_bp": float(group.actual_proxy_move_bp.abs().mean()),
                "gain_vs_fixed7_bp": float(group.gain_vs_fixed7_bp.mean()),
                "gain_vs_deadline_bp": float(group.gain_vs_deadline_bp.mean()),
                "month_cluster_interval": clustered_mean_interval(
                    group, "realized_saving_bp", "month"
                ),
                "issuer_cluster_interval": clustered_mean_interval(
                    group, "realized_saving_bp", "issuer"
                ),
                "yearly": {
                    str(year): {
                        "events": len(part),
                        "gain_bp": float(part.realized_saving_bp.mean()),
                        "regret_bp": float(part.regret_bp.mean()),
                    }
                    for year, part in group.groupby("year")
                },
                "inference": (
                    "descriptive after historical search; "
                    "no multiple-search significance claim"
                ),
            }
        )
    return result
