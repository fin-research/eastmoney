"""One conditional-mean coupon model for every issuer, term and horizon."""

from dataclasses import asdict, dataclass

import lightgbm as lgb
import numpy as np
import pandas as pd
from threadpoolctl import threadpool_limits

from data.issuance_training import CATEGORIES
from data.issuance_primary_features import (
    INDUSTRY_BASIS_COLUMNS,
    WEIGHTED_PRIMARY_COLUMNS,
)
from data.issuance_industry_tenor import INDUSTRY_TENOR_COLUMNS
from .export import _tree
from .window_linear import WindowRidge
from data.issuance_curve_dynamics import CURVE_COLUMNS
from data.coupon_quotes import QUOTE_COLUMNS, STATIC_QUOTE_COLUMNS
from data.coupon_raw_nodes import NODE_FEATURES, NODE_NUMERIC

SPARSE_LEADS = (0, 1, 3, 7, 14, 21, 30, 45, 60, 75, 90)
SPARSE_DAY_COUNTS = {
    lead: sum(
        min(SPARSE_LEADS, key=lambda item: (abs(day - item), item)) == lead
        for day in range(91)
    )
    for lead in SPARSE_LEADS
}

# Profiles 0/1 preserve the frozen original search. Profiles 2/3 are the
# pre-registered six-configuration C-stage search on the selected structure.
LGB_PROFILES = (
    dict(
        num_leaves=7,
        max_depth=3,
        min_child_samples=160,
        min_child_weight=8.0,
        reg_lambda=10.0,
    ),
    dict(
        num_leaves=15,
        max_depth=4,
        min_child_samples=240,
        min_child_weight=8.0,
        reg_lambda=30.0,
    ),
    dict(
        num_leaves=7,
        max_depth=3,
        min_child_samples=20,
        min_child_weight=4.0,
        reg_lambda=10.0,
    ),
    dict(
        num_leaves=15,
        max_depth=4,
        min_child_samples=20,
        min_child_weight=8.0,
        reg_lambda=30.0,
    ),
    dict(
        num_leaves=7,
        max_depth=3,
        min_child_samples=20,
        min_child_weight=4.0,
        reg_lambda=10.0,
        objective="regression_l1",
    ),
    dict(
        num_leaves=7,
        max_depth=3,
        min_child_samples=20,
        min_child_weight=4.0,
        reg_lambda=10.0,
        objective="huber",
        alpha=10.0,
    ),
)
RIDGE_ALPHAS = (10.0, 100.0, 30.0, 300.0)


def _event_lead_weights(rows, policy):
    if policy == "uniform":
        raw = np.ones(len(rows))
    elif policy == "front30":
        leads = rows.lead_days.to_numpy()
        masses = np.where(leads <= 30, 0.7, np.where(leads <= 60, 0.2, 0.1))
        buckets = np.where(leads <= 30, 0, np.where(leads <= 60, 1, 2))
        frame = rows[["bond_code"]].copy()
        frame["bucket"] = buckets
        counts = frame.groupby(["bond_code", "bucket"]).bond_code.transform("size")
        raw = masses / counts.to_numpy()
    elif policy == "sparse_grid":
        raw = rows.lead_days.map(SPARSE_DAY_COUNTS).to_numpy(dtype=float)
    else:
        raise ValueError("unknown lead weighting policy")
    frame = rows[["bond_code"]].copy()
    frame["raw"] = raw
    total = frame.groupby("bond_code").raw.transform("sum").to_numpy()
    return raw / total


@dataclass(frozen=True)
class CouponCandidate:
    kind: str
    target: str
    years: int
    profile: int = 0
    feature_set: str = "legacy"
    lead_policy: str = "uniform"
    market_change: str = "none"

    @property
    def estimand(self):
        if self.kind == "lgb" and self.profile == 4:
            return "conditional_median"
        if self.kind == "lgb" and self.profile == 5:
            return "huber_center"
        return "conditional_mean"

    @property
    def uses_weighted_primary(self):
        return self.feature_set in (
            "weighted_primary",
            "combined",
            "combined_no_issuer",
            "industry_basis",
        )

    @property
    def uses_industry_tenor(self):
        return self.feature_set in (
            "industry_tenor",
            "combined",
            "combined_no_issuer",
            "industry_basis",
        )

    @property
    def uses_industry_basis(self):
        return self.feature_set == "industry_basis"

    @property
    def uses_curve_dynamics(self):
        return self.market_change in ("tenor", "tenor_shape")

    @property
    def uses_quote_history(self):
        return self.feature_set in (
            "quote_static",
            "quote_history",
            "quote_pca",
            "quote_product",
            "quote_primary_batch",
        )

    @property
    def quote_columns(self):
        if self.feature_set in (
            "quote_history",
            "quote_product",
            "quote_primary_batch",
        ):
            return QUOTE_COLUMNS
        if self.feature_set == "quote_pca":
            from .curve_projection import PC_COLUMNS

            return (*STATIC_QUOTE_COLUMNS, *PC_COLUMNS)
        return STATIC_QUOTE_COLUMNS

    @property
    def primary_batch_columns(self):
        from data.coupon_primary import PRIMARY_BATCH_COLUMNS

        return (
            PRIMARY_BATCH_COLUMNS if self.feature_set == "quote_primary_batch" else ()
        )

    @property
    def active_categories(self):
        return tuple(
            name
            for name in CATEGORIES
            if name != "issuer" or self.feature_set != "combined_no_issuer"
        )

    @property
    def name(self):
        name = f"{self.kind}_{self.target}_{self.years}y_{self.profile}"
        if self.feature_set != "legacy":
            name += f"_{self.feature_set}"
        if self.lead_policy != "uniform":
            name += f"_{self.lead_policy}"
        if self.market_change != "none":
            name += f"_{self.market_change}"
        return name


def coupon_candidates():
    # Exactly 24 predefined configurations, no adaptive enlargement of search.
    return [
        CouponCandidate(kind, target, years, profile)
        for target in ("coupon", "excess")
        for years in (2, 3, 5)
        for kind, profile in (("ridge", 0), ("ridge", 1), ("lgb", 0), ("lgb", 1))
    ]


def coupon_anchor(features, candidate):
    """Fixed known-at-origin offset; every target is restored to actual coupon bp.

    The AAA industry curve is a sector reference, not an issuer/rating matched
    quote. Categories still estimate subordinated, rating and placement gaps.
    Missing/out-of-range nodes explicitly fall back to the government anchor.
    """
    if candidate.target == "coupon":
        return np.zeros(len(features))
    treasury = features.known_treasury_bp.to_numpy(dtype=float)
    if candidate.target == "excess":
        return treasury
    if candidate.target in ("industry_excess", "pricing_excess"):
        if not candidate.uses_industry_tenor:
            raise ValueError("industry target requires industry tenor features")
        reference = features.industry_aaa_tenor_bp.to_numpy(dtype=float)
        available = features.industry_aaa_available.eq(1).to_numpy()
        return np.where(available & np.isfinite(reference), reference, treasury)
    if candidate.target in ("primary_residual", "industry_basis_residual"):
        if not candidate.uses_weighted_primary:
            raise ValueError("primary target requires weighted primary features")
        premium = (
            features.issuer_shrunk_premium_bp.fillna(features.peer_premium_mean_bp)
            .fillna(0)
            .to_numpy(dtype=float)
        )
        fallback = treasury + premium
        if candidate.target == "primary_residual":
            return fallback
        if not candidate.uses_industry_basis:
            raise ValueError("industry basis target requires industry basis features")
        basis = features.issuer_shrunk_industry_basis_bp.to_numpy(dtype=float)
        industry = features.industry_aaa_tenor_bp.to_numpy(dtype=float)
        valid = (
            features.industry_aaa_available.eq(1).to_numpy()
            & np.isfinite(basis)
            & np.isfinite(industry)
        )
        return np.where(valid, industry + basis, fallback)
    raise ValueError("unknown coupon target")


def tree_parameters(candidate):
    return {
        "learning_rate": 0.04,
        "n_estimators": 200,
        "n_jobs": 1,
        "random_state": 42,
        "verbosity": -1,
        "deterministic": True,
        "force_col_wise": True,
        **(
            {"use_missing": True, "zero_as_missing": False}
            if candidate.feature_set == "raw_nodes"
            else {}
        ),
        "objective": "regression",
        **LGB_PROFILES[candidate.profile],
    }


def _validate_raw_nodes(candidate, train):
    if candidate != CouponCandidate("lgb", "coupon", 0, 2, "raw_nodes"):
        raise ValueError("raw nodes require the fixed direct tree candidate")
    if set(train) != set(NODE_FEATURES) or train.columns.has_duplicates:
        raise ValueError("raw node inputs differ from the explicit source columns")


class CouponModel:
    def __init__(self, candidate):
        self.candidate = candidate
        self.categories = {}

    def encode(self, features):
        derived = {}
        if self.candidate.feature_set == "quote_product":
            from .coupon_product import PRODUCT_QUOTE, product_quote_feature

            derived[PRODUCT_QUOTE] = product_quote_feature(features, self.product_quote)
        if self.candidate.feature_set == "quote_pca":
            from .curve_projection import project_curve

            features = project_curve(features, self.curve_projection)
        if self.candidate.uses_quote_history:
            for lead in (1, 14, 30):
                name = f"quote_h{lead}"
                derived[name] = features.lead_days.eq(lead).astype(float)
                for column in self.candidate.quote_columns:
                    interaction = f"{name}_{column}"
                    if interaction in self.numeric:
                        derived[interaction] = features[column].where(
                            features.lead_days.eq(lead), 0.0
                        )
        features = pd.concat(
            [features, pd.DataFrame(derived, index=features.index)], axis=1
        )
        result = features.reindex(columns=self.numeric).astype(float).copy()
        category_columns = {}
        for name in self.candidate.active_categories:
            mapping = self.categories[name]
            codes = features[name].map(mapping).fillna(-1).astype(int)
            if self.candidate.kind == "lgb":
                category_columns[name] = codes
            else:
                for category, index in mapping.items():
                    category_columns[f"{name}__{index}"] = codes.eq(index).astype(float)
        return pd.concat(
            [result, pd.DataFrame(category_columns, index=result.index)], axis=1
        )

    def training_mask(
        self, requests, cutoff, excluded_issuers=(), *, window_start=None
    ):
        if self.candidate.kind == "mlp":
            raise ValueError("frozen MLP must be restored without refitting")
        cutoff = pd.Timestamp(cutoff)
        start = (
            (
                requests.pricing_date.min()
                if self.candidate.years == 0
                else cutoff - pd.DateOffset(years=self.candidate.years)
            )
            if window_start is None
            else pd.Timestamp(window_start)
        )
        if start >= cutoff:
            raise ValueError("training window must start before cutoff")
        if self.candidate.lead_policy not in ("uniform", "front30", "sparse_grid"):
            raise ValueError("unknown lead weighting policy")
        mask = (
            requests.label_available_date.lt(cutoff)
            & requests.origin.lt(cutoff)
            & requests.pricing_date.ge(start)
            & ~requests.issuer.isin(excluded_issuers)
        )
        if self.candidate.lead_policy == "sparse_grid":
            mask &= requests.lead_days.isin(SPARSE_LEADS)
        if self.candidate.target == "pricing_excess":
            mask &= requests.pricing_reference_covered
        return mask

    def _validate_feature_groups(self, train):
        if self.candidate.feature_set == "raw_nodes":
            _validate_raw_nodes(self.candidate, train)
            return
        if self.candidate.uses_curve_dynamics and not set(CURVE_COLUMNS).issubset(
            train
        ):
            raise ValueError("target tenor curve feature columns missing")
        if self.candidate.feature_set not in (
            "legacy",
            "weighted_primary",
            "industry_tenor",
            "combined",
            "combined_no_issuer",
            "industry_basis",
            "quote_static",
            "quote_history",
            "quote_pca",
            "quote_product",
            "quote_primary_batch",
        ):
            raise ValueError("unknown coupon feature set")
        if self.candidate.uses_quote_history and not set(QUOTE_COLUMNS).issubset(train):
            raise ValueError("raw coupon quote history missing")
        if not set(self.candidate.primary_batch_columns).issubset(train):
            raise ValueError("raw primary batch records missing")
        if self.candidate.uses_weighted_primary and not set(
            WEIGHTED_PRIMARY_COLUMNS
        ).issubset(train):
            raise ValueError("weighted primary features missing")
        if self.candidate.uses_industry_tenor and not set(
            INDUSTRY_TENOR_COLUMNS
        ).issubset(train):
            raise ValueError("industry tenor features missing")
        if self.candidate.uses_industry_basis and not set(
            INDUSTRY_BASIS_COLUMNS
        ).issubset(train):
            raise ValueError("industry basis features missing")
        if (
            self.candidate.uses_industry_tenor
            and self.candidate.years != 0
            and not train.industry_aaa_available.any()
        ):
            raise ValueError("industry tenor candidate has no dated AAA nodes")

    def _numeric_columns(self, train):
        if self.candidate.feature_set == "raw_nodes":
            return list(NODE_NUMERIC)
        self.numeric = [
            name
            for name in train
            if name not in CATEGORIES
            and (
                name not in CURVE_COLUMNS
                or self.candidate.market_change in ("tenor", "tenor_shape")
            )
            and (
                name != "market_known_zero" or self.candidate.target == "pricing_excess"
            )
            and (
                self.candidate.uses_weighted_primary
                or name not in WEIGHTED_PRIMARY_COLUMNS
            )
            and (
                self.candidate.uses_industry_tenor or name not in INDUSTRY_TENOR_COLUMNS
            )
            and (
                self.candidate.uses_industry_basis or name not in INDUSTRY_BASIS_COLUMNS
            )
            and (self.candidate.uses_quote_history or name not in QUOTE_COLUMNS)
        ]
        if self.candidate.uses_quote_history:
            quote_columns = self.candidate.quote_columns
            self.numeric = ["tenor", "issue_size", "known_treasury_bp", *quote_columns]
            for lead in (1, 14, 30):
                name = f"quote_h{lead}"
                self.numeric.append(name)
                for column in quote_columns:
                    interaction = f"{name}_{column}"
                    self.numeric.append(interaction)
            if self.candidate.feature_set == "quote_product":
                from .coupon_product import PRODUCT_QUOTE, fit_product_quote

                self.numeric.append(PRODUCT_QUOTE)
                self.product_quote = fit_product_quote(train)
        self.numeric.extend(self.candidate.primary_batch_columns)
        return self.numeric

    @threadpool_limits.wrap(limits=1)
    def fit(
        self,
        features,
        requests,
        cutoff,
        excluded_issuers=(),
        *,
        market_panel=None,
        window_start=None,
    ):
        cutoff = pd.Timestamp(cutoff)
        mask = self.training_mask(
            requests, cutoff, excluded_issuers, window_start=window_start
        )
        rows = requests.loc[mask]
        if rows.bond_code.nunique() < 40:
            raise ValueError("fewer than 40 mature real issuance events")
        train = features.loc[mask].copy()
        self._validate_feature_groups(train)
        self.numeric = self._numeric_columns(train)
        self.categories = {
            name: {
                value: index for index, value in enumerate(sorted(train[name].unique()))
            }
            for name in CATEGORIES
        }
        self._prepare_curve_projection(features, market_panel, cutoff)
        matrix = self.encode(train)
        separated = self.candidate.target == "pricing_excess"
        if separated:
            self._prepare_premium_matrix(matrix, market_panel)
        self.feature_names = list(matrix)
        weights = _event_lead_weights(rows, self.candidate.lead_policy)
        target = rows.coupon_bp.to_numpy() - (
            rows.pricing_reference_bp.to_numpy()
            if separated
            else coupon_anchor(train, self.candidate)
        )
        if self.candidate.kind == "ridge":
            self.estimator = WindowRidge.fit(
                matrix, target, weights, RIDGE_ALPHAS[self.candidate.profile]
            )
        else:
            self.estimator = lgb.LGBMRegressor(**tree_parameters(self.candidate))
            self.estimator.fit(
                matrix,
                target,
                sample_weight=weights,
                categorical_feature=list(self.candidate.active_categories),
            )
        self.audit = {
            "training_as_of": cutoff.date().isoformat(),
            "training_label_end": rows.label_available_date.max().date().isoformat(),
            "events": rows.bond_code.nunique(),
            "rows": len(rows),
            "issuers": rows.issuer.nunique(),
            "event_weight": 1.0,
            "weight_sum": float(weights.sum()),
            "lead_weight_sum": {
                str(lead): float(value)
                for lead, value in rows.assign(weight=weights)
                .groupby("lead_days")
                .weight.sum()
                .items()
            },
            "training_start": rows.pricing_date.min().date().isoformat(),
            **(
                {"training_window_start": pd.Timestamp(window_start).date().isoformat()}
                if window_start is not None
                else {}
            ),
            "excluded_issuers": list(excluded_issuers),
            "estimand": self.candidate.estimand,
            "loss": self.estimator.get_params()["objective"]
            if self.candidate.kind == "lgb"
            else "weighted_l2",
            "huber_delta_bp": 10.0
            if self.candidate.estimand == "huber_center"
            else None,
            "ridge_alpha": RIDGE_ALPHAS[self.candidate.profile]
            if self.candidate.kind == "ridge"
            else None,
            "industry_basis_fallback_rows": int(train.industry_basis_fallback.sum())
            if self.candidate.uses_industry_basis
            else None,
        }
        if self.candidate.feature_set == "quote_pca":
            self.audit["curve_projection"] = self.curve_projection["audit"]
        if separated:
            from .issuance_market_change import fit_market_change

            self.market_layer = fit_market_change(
                market_panel, cutoff, self.candidate.market_change
            )
            self.anchor_reference = {
                name: float(train[name].median())
                for name in ("known_treasury_bp", "industry_aaa_minus_treasury_bp")
            }
            self.audit["market_layer"] = self.market_layer["audit"]
        return self

    def _prepare_curve_projection(self, features, panel, cutoff):
        if self.candidate.feature_set != "quote_pca":
            return
        from .curve_projection import CURVE_COLUMNS, fit_curve_projection

        if panel is None or not set(CURVE_COLUMNS).issubset(features):
            raise ValueError("curve PCA requires the dated market panel and raw curves")
        self.curve_projection = fit_curve_projection(
            panel, cutoff, self.candidate.years
        )

    def _prepare_premium_matrix(self, matrix, market_panel):
        if market_panel is None or self.candidate.market_change not in (
            "zero",
            "ridge",
            "centered",
            "lgb",
            "lgb_centered",
            "balanced",
            "balanced_half",
            "tenor",
            "tenor_shape",
        ):
            raise ValueError("separated coupon requires a registered market layer")
        for name in (
            *CURVE_COLUMNS,
            "lead_days",
            "pricing_weekday",
            "pricing_month",
            "pricing_month_end",
            "market_known_zero",
        ):
            if name in matrix:
                matrix[name] = 0.0

    def predict(self, features):
        prediction = self.estimator.predict(self.encode(features))
        if hasattr(self, "market_layer"):
            from .issuance_market_change import market_change

            prediction += market_change(self.market_layer, features)
        return prediction + coupon_anchor(features, self.candidate)

    def contributions(self, features):
        matrix = self.encode(features)
        if self.candidate.kind == "lgb":
            phi = self.estimator.booster_.predict(matrix, pred_contrib=True)
        elif self.candidate.kind == "mlp":
            phi = self.estimator.contributions(matrix)
        else:
            values = self.estimator.transformed(matrix) * self.estimator.coefficients
            phi = np.column_stack(
                (values, np.full(len(values), self.estimator.intercept))
            )
        phi[:, -1] += coupon_anchor(features, self.candidate)
        if hasattr(self, "market_layer"):
            from .issuance_market_change import market_contributions

            components, base = market_contributions(self.market_layer, features)
            for name, values in components.items():
                phi[:, self.feature_names.index(name)] += values
            phi[:, -1] += base
            treasury = features.known_treasury_bp.to_numpy()
            spread = coupon_anchor(features, self.candidate) - treasury
            for name, values in (
                ("known_treasury_bp", treasury),
                ("industry_aaa_minus_treasury_bp", spread),
            ):
                change = values - self.anchor_reference[name]
                phi[:, self.feature_names.index(name)] += change
                phi[:, -1] -= change
        return phi

    def export(self):
        value = {
            "feature_version": "issuance-coupon",
            "candidate": asdict(self.candidate),
            "numeric": self.numeric,
            "categories": self.categories,
            "feature_names": self.feature_names,
            "audit": self.audit,
        }
        if hasattr(self, "curve_projection"):
            value["curve_projection"] = self.curve_projection
        if hasattr(self, "product_quote"):
            value["product_quote"] = self.product_quote
        if hasattr(self, "market_layer"):
            value["market_layer"] = self.market_layer
            value["anchor_reference"] = self.anchor_reference
        if self.candidate.kind == "mlp":
            value["mlp"] = self.estimator.state
        elif self.candidate.kind == "lgb":
            value["trees"] = [
                _tree(t["tree_structure"])
                for t in self.estimator.booster_.dump_model()["tree_info"]
            ]
        else:
            value["linear"] = {
                name: (
                    getattr(self.estimator, name).tolist()
                    if name != "intercept"
                    else float(self.estimator.intercept)
                )
                for name in ("fill", "center", "scale", "coefficients", "intercept")
            }
        return value
