"""最终票面多期限检验与同发行人重复发行的联合成本误差。"""

import numpy as np
import pandas as pd


def historical_sessions(rates, start, end):
    # 历史报价日索引含调休工作日；市场预测时钟不等于交易所发行时钟。
    dates = rates.levels_bp.index
    return dates[(dates >= start) & (dates <= end)]


def evaluate_issuance_forecasts(
    engine, dataset, horizons=tuple(range(31)), start="2022-01-01"
):
    records = []
    for horizon in horizons:
        for bond in dataset.itertuples():
            as_of = bond.decision_date - pd.Timedelta(days=horizon)
            if as_of < pd.Timestamp(start):
                continue
            # Pricing can occur on a makeup quote day. Use observed sessions,
            # not weekdays, to decide whether its market target is available.
            dates = historical_sessions(engine.rates, as_of, bond.decision_date)
            if dates.empty or dates[-1] != bond.decision_date:
                continue
            result = engine.predict_one(
                as_of, dates[0], bond.decision_date, bond._asdict()
            )
            records.append(
                {
                    **result,
                    "bond_code": bond.bond_code,
                    "actual_coupon_bp": bond.coupon_bp,
                    "actual_market_bp": bond.anchor_market_bp,
                    "label_available_date": bond.label_available_date,
                }
            )
        print(f"[issuance] validated lead={horizon}", flush=True)
    result = pd.DataFrame(records)
    result["error_bp"] = result.actual_coupon_bp - result.coupon_percent * 100
    result["market_error_bp"] = (
        result.actual_market_bp - result.market_level_percent * 100
    )
    result["premium_error_bp"] = result.error_bp - result.market_error_bp
    return result


def issuance_pair_errors(engine, dataset):
    records = []
    keys = ["issuer", "rating", "tenor", "bond_type"]
    grouped = dataset.groupby(keys + ["decision_date"], as_index=False).agg(
        coupon_bp=("coupon_bp", "median"),
        label_available_date=("label_available_date", "max"),
    )
    for _, group in grouped.groupby(keys):
        group = group.sort_values("decision_date")
        for index in range(1, len(group)):
            first, last = group.iloc[index - 1], group.iloc[index]
            gap = int((last.decision_date - first.decision_date).days)
            if gap > 30 or first.decision_date < pd.Timestamp("2022-01-01"):
                continue
            dates = historical_sessions(
                engine.rates, first.decision_date, last.decision_date
            )
            if (
                dates.empty
                or dates[0] != first.decision_date
                or dates[-1] != last.decision_date
            ):
                continue
            now = engine.predict_one(
                first.decision_date, first.decision_date, first.decision_date, first
            )
            future = engine.predict_one(
                first.decision_date, first.decision_date, last.decision_date, first
            )
            predicted_saving = (now["coupon_percent"] - future["coupon_percent"]) * 100
            actual_saving = float(first.coupon_bp - last.coupon_bp)
            records.append(
                {
                    **{key: first[key] for key in keys},
                    "origin": first.decision_date,
                    "lead_days": gap,
                    "label_available_date": max(
                        first.label_available_date, last.label_available_date
                    ),
                    "prediction_saving_bp": predicted_saving,
                    "actual_saving_bp": actual_saving,
                    "saving_error_bp": actual_saving - predicted_saving,
                }
            )
    columns = keys + [
        "origin",
        "lead_days",
        "label_available_date",
        "prediction_saving_bp",
        "actual_saving_bp",
        "saving_error_bp",
    ]
    return pd.DataFrame(records, columns=columns)


def calibrate_coupon_window(window, validation, as_of, *, volatility_scaled=False):
    keys = ["rating", "tenor", "bond_type", "lead_days"]
    reference = (
        validation.loc[validation.error_bp.notna()]
        .groupby(keys + ["issuer", "as_of", "date"], as_index=False)
        .agg(
            error_bp=("error_bp", "median"),
            premium_error_bp=("premium_error_bp", "median"),
            market_error_bp=("market_error_bp", "median"),
            market_volatility_bp=("market_volatility_bp", "median"),
            label_available_date=("label_available_date", "max"),
        )
    )
    pools = {
        key: group.sort_values("label_available_date")
        for key, group in reference.groupby(keys)
    }
    rows = []
    for row in window.to_dict(orient="records"):
        cutoff = pd.Timestamp(row["as_of"] if as_of is None else as_of)
        whole = pools.get(tuple(row[key] for key in keys), reference.iloc[:0])
        end = whole.label_available_date.searchsorted(cutoff, side="left")
        pool = whole.iloc[:end].loc[lambda frame: frame.as_of.lt(cutoff)].tail(252)
        errors = pool.error_bp
        if volatility_scaled:
            scale = max(
                row["market_volatility_bp"], 0.25
            ) / pool.market_volatility_bp.clip(lower=0.25)
            errors = pool.premium_error_bp + pool.market_error_bp * scale
        errors = errors.dropna()
        if len(errors) >= 30:
            low, high = np.quantile(errors, [0.05, 0.95])
        else:
            low = high = np.nan
        rows.append(
            {
                **row,
                "coupon_low_percent": row["coupon_percent"] + low / 100,
                "coupon_high_percent": row["coupon_percent"] + high / 100,
                "interval_samples": len(errors),
                "calibration_latest_label": pool.label_available_date.max(),
            }
        )
    return pd.DataFrame(rows)


def issuance_validation_metrics(predictions):
    frame = predictions.loc[predictions.status.eq("estimated")].copy()
    frame["year"] = frame.as_of.dt.year
    frame["ae"] = frame.error_bp.abs()
    frame["within_5bp"] = frame["ae"].le(5)
    frame["squared_error"] = frame.error_bp**2
    frame["flat_market_error"] = (
        frame.actual_coupon_bp - (frame.coupon_percent * 100 - frame.market_change_bp)
    ).abs()
    result = (
        frame.groupby(["lead_days", "year"])
        .agg(
            samples=("bond_code", "size"),
            mae_bp=("ae", "mean"),
            hit_rate_5bp=("within_5bp", "mean"),
            mse=("squared_error", "mean"),
            flat_market_mae_bp=("flat_market_error", "mean"),
        )
        .reset_index()
    )
    result["rmse_bp"] = np.sqrt(result.pop("mse"))
    result["mae_skill_vs_flat_market"] = 1 - result.mae_bp / result.flat_market_mae_bp
    return result


def issuance_validation_summary(predictions):
    """Shared local/online validation contract; 2026 is an observed reference."""
    return {
        "sample_count": len(predictions),
        "prediction_start": str(predictions.as_of.min().date()),
        "prediction_end": str(predictions.as_of.max().date()),
        "status": "2026 previously observed research reference",
        "metrics": issuance_validation_metrics(predictions).to_dict(orient="records"),
    }
