"""One real-coupon event panel; every feature is known before its origin."""

from dataclasses import dataclass, replace

import numpy as np
import pandas as pd

from .online_inputs import build_issuance_market, build_online_issuance, source_frame
from .issuance_eligibility import issuance_kind_audit
from .issuance_sample_scope import scoped_coupon_inputs
from .issuance_industry_tenor import industry_tenor_features, prepare_industry_nodes
from .issuance_primary_features import (
    industry_primary_features,
    weighted_primary_features,
)

CATEGORIES = ("issuer", "rating", "bond_type", "placement_type")
HORIZONS = (7, 14, 30, 60, 90)
UNKNOWN = "未知"


def pricing_events(inputs):
    raw = pd.DataFrame(inputs["datasets"]["bond_issuance"])
    if raw.bond_code.duplicated().any():
        raise ValueError("duplicate issuance identifiers")
    ledger = issuance_kind_audit(raw)
    rows = raw.rename(
        columns={
            "issuer_name": "issuer",
            "original_tenor_years": "tenor",
            "issue_amount_100m": "issue_size",
            "tender_date": "pricing_date",
            "final_coupon_pct": "coupon",
        }
    ).copy()
    text = rows.pricing_date.astype("string")
    rows["pricing_date"] = pd.to_datetime(
        text.where(text.str.fullmatch(r"\d{4}-\d{2}-\d{2}", na=False)), errors="coerce"
    )
    rows["issue_date"] = pd.to_datetime(rows.issue_date, errors="coerce")
    for name in ("coupon", "tenor", "issue_size"):
        rows[name] = pd.to_numeric(rows[name], errors="coerce")
    eligible = (
        rows.bond_code.str.endswith((".SH", ".SZ"))
        & rows.interest_rate_type.eq("固息")
        & rows.tenor.between(1, 10)
        & rows.bond_type.isin(("证券公司债", "证券公司次级债"))
    )
    dated = rows.pricing_date.notna() & rows.pricing_date.le(rows.issue_date)
    valid = (
        eligible
        & dated
        & rows.coupon.gt(0)
        & rows.coupon.lt(30)
        & ledger.issuance_kind.eq("new_coupon")
    )
    rows["label_available_date"] = rows[["pricing_date", "issue_date"]].max(axis=1)
    valid &= rows.label_available_date.lt(pd.Timestamp(inputs["as_of_date"]))
    # Only issuance-time rating, never the latest issuer rating snapshot.
    detail = source_frame("issue", inputs["datasets"]["issue"], require_spread=False)
    ratings = (
        detail.drop_duplicates("bond_code", keep="last")
        .set_index("bond_code")
        .issuance_rating
    )
    rows["rating"] = rows.bond_code.map(ratings)
    rows = rows.loc[valid].copy()
    for name in CATEGORIES:
        rows[name] = rows[name].fillna(UNKNOWN).replace("", UNKNOWN).astype(str)
    rows["coupon_bp"] = rows.coupon * 100
    audit = {
        "raw_events": len(raw),
        "eligible_events": int(eligible.sum()),
        "excluded_pricing_date": int((eligible & ~dated).sum()),
        "excluded_fixed_coupon_reopening": int(
            (eligible & ledger.issuance_kind.eq("fixed_coupon_reopening")).sum()
        ),
        "quarantined_reopening": int(
            (eligible & ledger.issuance_kind.eq("unverified_reopening")).sum()
        ),
        "event_eligibility": ledger.loc[~ledger.issuance_kind.eq("new_coupon")].to_dict(
            orient="records"
        ),
        "usable_events": len(rows),
        "issuers": rows.issuer.nunique(),
        "unknown_placement": int(rows.placement_type.eq(UNKNOWN).sum()),
        "unknown_rating": int(rows.rating.eq(UNKNOWN).sum()),
        "scope": "conditional on stated final terms; historical announcement vintages unavailable",
    }
    return rows.sort_values(["label_available_date", "bond_code"]).reset_index(
        drop=True
    ), audit


def expand_pricing_requests(events, dates, horizons):
    """Expand real events without constructing a market quote or label reference."""
    horizons = tuple(horizons)
    rows = events.loc[events.index.repeat(len(horizons))].reset_index(drop=True)
    rows["lead_days"] = np.tile(horizons, len(events))
    rows["origin"] = rows.pricing_date - pd.to_timedelta(rows.lead_days, unit="D")
    return rows.loc[rows.origin.gt(dates[0])].reset_index(drop=True)


def known_market_change_zero(dates, sources, targets):
    positions = dates.searchsorted(targets, side="left") - 1
    known = positions == sources
    future = targets > dates[-1]
    if future.any():
        from .issuance_calendar import IssuanceCalendar

        calendar = IssuanceCalendar()
        for i in np.flatnonzero(future):
            known[i] = calendar.previous_quote_day(targets[i]) == dates[sources[i]]
    return known.astype(float)


def treasury_anchor(features, tenor):
    tenor = np.asarray(tenor, dtype=float)
    one = features.rate_gov_1y_level.to_numpy() * 100
    three = features.rate_gov_3y_level.to_numpy() * 100
    ten = features.rate_gov_10y_level.to_numpy() * 100
    return np.where(
        tenor <= 3,
        one + (three - one) * (tenor - 1) / 2,
        three + (ten - three) * (tenor - 3) / 7,
    )


def _history_features(requests, events, keys):
    """365-day prefix sums by issuer/product; no repeated full-history scans."""
    output = np.full((len(requests), 3), np.nan)
    output[:, 0] = 0
    groups = events.groupby(list(keys), sort=False, dropna=False)
    histories = {
        key if isinstance(key, tuple) else (key,): frame for key, frame in groups
    }
    for key, indices in requests.groupby(list(keys), sort=False).indices.items():
        key = key if isinstance(key, tuple) else (key,)
        history = histories.get(key)
        if history is None:
            continue
        days = history.label_available_date.to_numpy("datetime64[ns]")
        values = history.history_premium_bp.to_numpy()
        dates = requests.iloc[indices].origin.to_numpy("datetime64[ns]")
        right = days.searchsorted(dates, side="left")
        left = days.searchsorted(dates - np.timedelta64(365, "D"), side="left")
        prefix = np.r_[0.0, np.cumsum(values)]
        count = right - left
        output[indices, 0] = count
        output[indices, 1] = np.divide(
            prefix[right] - prefix[left],
            count,
            out=np.full(len(count), np.nan),
            where=count > 0,
        )
        has = count > 0
        output[np.asarray(indices)[has], 2] = values[right[has] - 1]
    return output


@dataclass
class IssuancePanel:
    rates: object
    events: pd.DataFrame
    audit: dict
    secondary: pd.DataFrame | None = None
    incumbent_history: pd.DataFrame | None = None
    industry_nodes: pd.DataFrame | None = None

    def with_label_cutoff(self, cutoff):
        """Freeze all coupon-derived histories; market observations remain dated."""
        cutoff = pd.Timestamp(cutoff)
        history = self.incumbent_history
        if history is not None:
            history = history.loc[history.label_available_date.lt(cutoff)].copy()
        return replace(
            self,
            events=self.events.loc[self.events.label_available_date.lt(cutoff)].copy(),
            incumbent_history=history,
            audit={**self.audit, "training_label_cutoff": cutoff.date().isoformat()},
        )

    @classmethod
    def from_inputs(cls, inputs):
        inputs, scope_audit = scoped_coupon_inputs(inputs)
        rates = build_issuance_market(inputs)
        events, audit = pricing_events(inputs)
        audit.update(scope_audit)
        positions = (
            rates.market_features.index.searchsorted(events.pricing_date, side="left")
            - 1
        )
        events = events.loc[positions >= 0].copy()
        features = rates.market_features.iloc[positions[positions >= 0]]
        events["history_premium_bp"] = events.coupon_bp.to_numpy() - treasury_anchor(
            features, events.tenor
        )
        audit["usable_events"] = len(events)
        audit["issuers_before_market_alignment"] = audit["issuers"]
        audit["issuers"] = events.issuer.nunique()
        secondary = pd.DataFrame(inputs["datasets"].get("issuer_daily", []))
        if not secondary.empty:
            secondary["date"] = pd.to_datetime(secondary.date)
            positions = (
                rates.market_features.index.searchsorted(secondary.date, side="right")
                - 1
            )
            secondary = secondary.loc[positions >= 0].copy()
            market = rates.market_features.iloc[positions[positions >= 0]]
            secondary["spread_bp"] = pd.to_numeric(
                secondary.yield_percent
            ) * 100 - treasury_anchor(market, secondary.tenor_years)
            secondary.loc[~secondary.tenor_years.between(1, 10), "spread_bp"] = np.nan
            secondary = secondary.sort_values("date")
        audit["secondary_rows"] = len(secondary)
        audit["secondary_scope"] = (
            "balance weighted reported observations; not a synthetic coupon label"
        )
        _, incumbent_history, _ = build_online_issuance(inputs)
        excluded_codes = {row["bond_code"] for row in audit["event_eligibility"]}
        incumbent_history = incumbent_history.loc[
            ~incumbent_history.bond_code.isin(excluded_codes)
        ].copy()
        incumbent_history["peer_residual_bp"] = np.nan
        nodes = prepare_industry_nodes(inputs["datasets"].get("industry_nodes", []))
        audit["industry_aaa_node_rows"] = 0 if nodes is None else len(nodes)
        panel = cls(
            rates,
            events.reset_index(drop=True),
            audit,
            secondary,
            incumbent_history,
            nodes,
        )
        cutoff = inputs.get("training_label_cutoff")
        return panel.with_label_cutoff(cutoff) if cutoff else panel

    def features(
        self,
        requests,
        *,
        include_weighted_primary=False,
        include_industry_tenor=False,
        include_industry_basis=False,
        include_curve_dynamics=False,
        include_quote_history=False,
        include_primary_batch=False,
    ):
        requests = requests.reset_index(drop=True).copy()
        dates = self.rates.market_features.index
        indices = dates.searchsorted(pd.DatetimeIndex(requests.origin), side="left") - 1
        if (indices < 0).any():
            raise ValueError("forecast origin precedes available market history")
        result = self.rates.market_features.iloc[indices].reset_index(drop=True).copy()
        for name in CATEGORIES:
            result[name] = requests[name].fillna(UNKNOWN).astype(str)
        for name in ("tenor", "issue_size", "lead_days"):
            result[name] = requests[name].to_numpy(dtype=float)
        target = pd.DatetimeIndex(requests.origin) + pd.to_timedelta(
            requests.lead_days, unit="D"
        )
        target = pd.DatetimeIndex(target)
        result["pricing_weekday"] = target.dayofweek
        result["pricing_month"] = target.month
        result["pricing_month_end"] = target.days_in_month - target.day
        result["market_known_zero"] = known_market_change_zero(dates, indices, target)
        result["known_treasury_bp"] = treasury_anchor(result, requests.tenor)
        own = _history_features(
            requests, self.events, ("issuer", "bond_type", "placement_type")
        )
        peer = _history_features(
            requests, self.events, ("rating", "bond_type", "placement_type")
        )
        for prefix, values in (("issuer", own), ("peer", peer)):
            for index, suffix in enumerate(
                ("observations", "premium_mean_bp", "premium_latest_bp")
            ):
                result[f"{prefix}_{suffix}"] = values[:, index]
        result = pd.concat([result, self.secondary_features(requests)], axis=1)
        if include_weighted_primary:
            result = pd.concat(
                [result, weighted_primary_features(requests, self.events)], axis=1
            )
        if include_industry_tenor:
            result = pd.concat(
                [
                    result,
                    industry_tenor_features(
                        requests,
                        dates[indices],
                        result.known_treasury_bp.to_numpy(),
                        self.industry_nodes,
                    ),
                ],
                axis=1,
            )
        if include_industry_basis:
            result = self._with_industry_basis(
                result,
                requests,
                dates,
                include_industry_tenor,
                include_weighted_primary,
            )
        result = self._quote_features(
            result, requests, dates, include_curve_dynamics, include_quote_history
        )
        if include_primary_batch:
            from .coupon_primary import primary_batch_features

            result = pd.concat(
                [result, primary_batch_features(requests, self.events)], axis=1
            )
        return result.replace([np.inf, -np.inf], np.nan)

    def _quote_features(self, result, requests, dates, dynamics, history):
        from .issuance_curve_dynamics import curve_features
        from .coupon_quotes import coupon_quote_features

        frames = [result]
        if dynamics:
            frames.append(curve_features(requests, dates, self.industry_nodes))
        if history:
            frames.append(
                coupon_quote_features(
                    requests, dates, self.industry_nodes, self.secondary
                )
            )
        return pd.concat(frames, axis=1)

    def _with_industry_basis(
        self, result, requests, dates, include_industry_tenor, include_weighted_primary
    ):
        if not include_industry_tenor or not include_weighted_primary:
            raise ValueError(
                "industry basis requires tenor and fallback primary features"
            )
        positions = dates.searchsorted(self.events.pricing_date, side="left") - 1
        event_requests = self.events.assign(origin=self.events.pricing_date)
        references = industry_tenor_features(
            event_requests,
            dates[positions],
            treasury_anchor(
                self.rates.market_features.iloc[positions], self.events.tenor
            ),
            self.industry_nodes,
        ).industry_aaa_tenor_bp
        covered = self.events.loc[np.isfinite(references)].copy()
        covered["history_premium_bp"] = (
            covered.coupon_bp - references.loc[covered.index]
        )
        self.audit["industry_basis_covered_history_events"] = len(covered)
        self.audit["industry_basis_missing_history_events"] = len(self.events) - len(
            covered
        )
        result = pd.concat(
            [
                result,
                industry_primary_features(
                    requests,
                    covered,
                    result.industry_aaa_tenor_bp.to_numpy(),
                ),
            ],
            axis=1,
        )
        return result

    def secondary_features(self, requests):
        columns = [
            "issuer_secondary_spread_bp",
            "issuer_secondary_change_20",
            "issuer_secondary_age_days",
            "issuer_secondary_observations",
            "issuer_secondary_missing",
        ]
        result = pd.DataFrame(np.nan, index=requests.index, columns=columns)
        if self.secondary is None or self.secondary.empty:
            return result
        keys = ["issuer", "bond_type", "placement_type"]
        groups = dict(tuple(self.secondary.groupby(keys, sort=False)))
        for key, indices in requests.groupby(keys, sort=False).indices.items():
            history = groups.get(key)
            if history is None:
                continue
            dates = pd.DatetimeIndex(requests.iloc[indices].origin)
            positions = history.date.searchsorted(dates, side="left") - 1
            exists = positions >= 0
            chosen = history.iloc[positions[exists]]
            age = (dates[exists] - pd.DatetimeIndex(chosen.date)).days
            spread = chosen.spread_bp.to_numpy().copy()
            spread[age > 7] = np.nan
            changes = (
                history.spread_bp.diff(20).iloc[positions[exists]].to_numpy().copy()
            )
            changes[age > 7] = np.nan
            result.loc[np.asarray(indices)[exists], columns] = np.column_stack(
                (spread, changes, age, chosen.observations, chosen.missing_observations)
            )
        return result

    def requests(self, horizons=range(91)):
        """A real coupon is repeated across origins, never synthetic daily labels."""
        horizons = tuple(horizons)
        events = self.events.copy()
        dates = self.rates.market_features.index
        positions = dates.searchsorted(events.pricing_date, side="left") - 1
        known = treasury_anchor(
            self.rates.market_features.iloc[positions], events.tenor
        )
        reference = industry_tenor_features(
            events.assign(origin=events.pricing_date),
            dates[positions],
            known,
            self.industry_nodes,
        ).industry_aaa_tenor_bp.to_numpy()
        # This realized reference is part of the label, never a model feature.
        events["pricing_reference_bp"] = np.where(
            np.isfinite(reference), reference, known
        )
        events["pricing_reference_covered"] = np.isfinite(reference)
        return expand_pricing_requests(events, dates, horizons)
