"""连接市场利率变化与发行人溢价，所有预测仅使用决策日以前的信息。"""

import numpy as np
import pandas as pd

from data.issuance_calendar import IssuanceCalendar
from data.rate_data import horizon_labels, purged_training_index, calendar_training_data
from .primary_pricing import (
    primary_history_statistics,
    coupon_predictions,
    PRIMARY_SELECTED_CANDIDATE,
)
from .rate_forecast import (
    RATE_CANDIDATES,
    ISSUANCE_CHALLENGERS,
    candidate_features,
    fit_rate_candidate,
    predict_rate_candidate,
    candidate_training_index,
)


class IssuanceForecaster:
    def __init__(self, rates, primary_history, market_model="lgb_anchor_drift"):
        self.rates = rates
        self.history = primary_history
        self.candidate = next(
            c for c in RATE_CANDIDATES + ISSUANCE_CHALLENGERS if c.name == market_model
        )
        self.labels = {}
        self.market_cache = {}
        self.primary_cache = {}
        self.fit_cache = {}
        self.calendar_features = {}

    def _labels(self, horizon):
        if horizon not in self.labels:
            if self.candidate.calendar_clock:
                features, labels = calendar_training_data(self.rates, int(horizon))
                self.calendar_features[horizon] = features
                self.labels[horizon] = labels
            else:
                self.labels[horizon] = horizon_labels(
                    self.rates, "AAA_3Y", int(horizon)
                )
        return self.labels[horizon]

    def fit_date(self, as_of):
        return as_of.replace(day=1) if self.candidate.monthly_fit else as_of

    def context(self, as_of, terms):
        key = (
            as_of,
            terms["issuer"],
            terms["rating"],
            terms["tenor"],
            terms["bond_type"],
        )
        if key not in self.primary_cache:
            stats = primary_history_statistics(self.history, terms, as_of)
            self.primary_cache[key] = stats
        return self.primary_cache[key]

    def market_prediction(self, as_of, origin, target):
        if self.candidate.calendar_clock:
            origin = as_of
        horizon = int((target - origin).days)
        key = (as_of, origin, horizon)
        if key in self.market_cache:
            return self.market_cache[key]
        labels = self._labels(horizon)
        fit_h = (
            min(horizon, self.candidate.anchor_horizon)
            if self.candidate.anchor_horizon is not None
            else horizon
        )
        fit_labels = self._labels(fit_h)
        fit_date = self.fit_date(as_of)
        train = candidate_training_index(fit_labels, fit_date, self.candidate)
        source = self.rates.levels_bp.index[self.rates.levels_bp.index < as_of][-1]
        X = self.rates.market_features.loc[[source]].copy()
        X["decision_weekday"] = origin.weekday()
        X["decision_month_end"] = origin.days_in_month - origin.day
        columns = candidate_features(
            self.rates.features, "AAA_3Y", self.candidate.feature_set
        )
        fit_key = (fit_date, fit_h)
        if fit_key not in self.fit_cache:
            self.fit_cache[fit_key] = fit_rate_candidate(
                self.candidate,
                (
                    self.calendar_features[fit_h]
                    if self.candidate.calendar_clock
                    else self.rates.features
                ).loc[train, columns],
                fit_labels.loc[train, "change_bp"],
            )
        prediction = float(
            predict_rate_candidate(self.fit_cache[fit_key], X[columns], self.candidate)[
                0
            ]
        )
        if self.candidate.drift_extension:
            # Frozen trees, but drift is recomputed from the live mature history,
            # matching the deployed runtime rather than freezing both by accident.
            shared = purged_training_index(fit_labels, as_of).intersection(
                purged_training_index(labels, as_of)
            )
            prediction += float(
                (
                    labels.loc[shared, "change_bp"]
                    - fit_labels.loc[shared, "change_bp"]
                ).mean()
            )
        result = {
            "market_change_bp": prediction,
            "market_volatility_bp": float(
                self.rates.market_features.loc[source, "rate_aaa_3y_volatility_20"]
            ),
            "market_source_date": source,
            "market_train_label_end": fit_labels.loc[train, "label_end"].max(),
            "market_training_samples": len(train),
            "effective_horizon": horizon,
        }
        self.market_cache[key] = result
        return result

    def explain(self, as_of, origin, target, terms):
        """TreeSHAP解释预测变化层；市场锚、一级溢价和期限漂移显式计入基准。"""
        as_of, origin, target = map(pd.Timestamp, (as_of, origin, target))
        if self.candidate.calendar_clock:
            origin = as_of
        result = self.predict_one(as_of, origin, target, terms)
        horizon = result["effective_horizon"]
        fit_h = (
            min(horizon, self.candidate.anchor_horizon)
            if self.candidate.anchor_horizon is not None
            else horizon
        )
        model = self.fit_cache[(self.fit_date(as_of), fit_h)]
        if self.candidate.kind != "lgb":
            return {"method": "not_applicable", "features": []}
        columns = candidate_features(
            self.rates.features, "AAA_3Y", self.candidate.feature_set
        )
        source = result["market_source_date"]
        X = self.rates.market_features.loc[[source]].copy()
        X["decision_weekday"] = origin.weekday()
        X["decision_month_end"] = origin.days_in_month - origin.day
        values = model.booster_.predict(X[columns], pred_contrib=True)[0]
        values = np.asarray(values) * self.candidate.shrinkage
        tree_prediction = float(values.sum())
        drift = result["market_change_bp"] - tree_prediction
        market = float(self.rates.levels_bp.loc[source, "AAA_3Y"])
        base = market + result["issuer_premium_bp"] + drift + float(values[-1])
        prediction = result["coupon_percent"] * 100
        if not np.isclose(base + values[:-1].sum(), prediction, atol=1e-8):
            raise ValueError("coupon TreeSHAP additivity failed")
        return {
            "method": "tree_path_dependent",
            "unit": "bp",
            "base_coupon_bp": base,
            "prediction_coupon_bp": prediction,
            "market_anchor_bp": market,
            "issuer_premium_bp": result["issuer_premium_bp"],
            "horizon_drift_bp": drift,
            "tree_expected_change_bp": float(values[-1]),
            "features": [
                {
                    "feature": name,
                    "value": float(X.iloc[0][name]),
                    "shap_bp": float(value),
                }
                for name, value in zip(columns, values[:-1], strict=True)
            ],
        }

    def predict_one(self, as_of, origin, target, terms):
        terms = {key: terms[key] for key in ("issuer", "rating", "tenor", "bond_type")}
        as_of, origin, target = map(pd.Timestamp, (as_of, origin, target))
        if self.candidate.calendar_clock:
            origin = as_of
        if not as_of <= origin <= target or not 0 <= (target - as_of).days <= 30:
            raise ValueError(
                "forecast dates must be within the as-of 0..30 calendar-day window"
            )
        market = self.market_prediction(as_of, origin, target)
        base = float(self.rates.levels_bp.loc[market["market_source_date"], "AAA_3Y"])
        stats = self.context(as_of, terms)
        coupon_now = coupon_predictions(stats, base)[PRIMARY_SELECTED_CANDIDATE]
        return {
            "as_of": as_of,
            "forecast_origin": origin,
            "date": target,
            "lead_days": (target - as_of).days,
            **terms,
            **market,
            "market_level_percent": (base + market["market_change_bp"]) / 100,
            "issuer_premium_bp": coupon_now - base,
            "coupon_percent": (coupon_now + market["market_change_bp"]) / 100,
            "own_observations": stats["own_n"],
            "peer_observations": stats["peer_n"],
            "primary_history_latest_date": stats["history_latest_date"],
            "status": "estimated"
            if np.isfinite(coupon_now)
            else "insufficient_primary_history",
        }

    def product_scenarios(self, as_of, first, terms):
        """Estimate four financing terms at the same first issuance date."""
        rows = []
        for tenor, bond_type in (
            (3, "证券公司债"),
            (5, "证券公司债"),
            (3, "证券公司次级债"),
            (5, "证券公司次级债"),
        ):
            scenario = self.predict_one(
                as_of,
                first.forecast_origin,
                first.date,
                {**terms, "tenor": tenor, "bond_type": bond_type},
            )
            rows.append(
                {
                    "tenor": tenor,
                    "bond_type": bond_type,
                    "coupon_percent": scenario["coupon_percent"]
                    if np.isfinite(scenario["coupon_percent"])
                    else None,
                    "own_observations": scenario["own_observations"],
                    "peer_observations": scenario["peer_observations"],
                }
            )
        return rows

    def window(self, as_of, days, terms):
        if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= 30:
            raise ValueError("window days must be an integer from 1 to 30")
        as_of = pd.Timestamp(as_of).normalize()
        calendar = IssuanceCalendar()
        dates = calendar.issuance_dates(as_of, as_of + pd.Timedelta(days=days))
        quote_dates = calendar.quote_dates(as_of, as_of + pd.Timedelta(days=days))
        source = self.rates.levels_bp.index[self.rates.levels_bp.index < as_of][-1]
        expected = calendar.previous_quote_day(as_of)
        if source < expected:
            raise ValueError(
                f"market data stale: latest {source.date()}, expected {expected.date()}"
            )
        if dates.empty:
            return pd.DataFrame(), {
                "status": "no_issuance_day",
                "calendar": calendar.specification,
            }
        rows = [self.predict_one(as_of, quote_dates[0], date, terms) for date in dates]
        return pd.DataFrame(rows), {
            "status": "forecast_available",
            "calendar": calendar.specification,
            "expected_quote_date": str(expected.date()),
            "market_source_date": str(source.date()),
        }

    def market_path(self, as_of, days):
        as_of = pd.Timestamp(as_of).normalize()
        calendar = IssuanceCalendar()
        dates = pd.date_range(as_of, as_of + pd.Timedelta(days=days))
        quote_dates = calendar.quote_dates(as_of, dates[-1])
        source = self.rates.levels_bp.index[self.rates.levels_bp.index < as_of][-1]
        base = float(self.rates.levels_bp.loc[source, "AAA_3Y"])
        level, quote_date = base / 100, source
        rows = []
        for date in dates:
            active = calendar.is_quote_workday(date)
            if active:
                prediction = self.market_prediction(as_of, quote_dates[0], date)
                level = (base + prediction["market_change_bp"]) / 100
                quote_date = date
            rows.append(
                {
                    "date": date,
                    "market_level_percent": level,
                    "quote_day": active,
                    "issuance_day": calendar.is_issuance_day(date),
                    "value_date": quote_date,
                    "status": "forecast" if active else "closed_carry",
                }
            )
        return rows
