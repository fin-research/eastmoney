"""Unlabelled curve PCA fitted only on complete pre-cutoff quote windows."""

from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA

from data.feature_engineering import FeatureBuildContext, build_feature_bundle

CURVE_COLUMNS = tuple(
    f"sector_{tenor}_quote_lag_{lag}_bp"
    for tenor in (1, 3, 5, 7, 10)
    for lag in range(20)
)
PC_COLUMNS = tuple(f"curve_pc_{i}" for i in range(3))


def fit_curve_projection(panel, cutoff, years):
    dates = panel.rates.market_features.index
    frame = build_feature_bundle(
        ("coupon_quote_history",),
        FeatureBuildContext(
            data_path=Path("."),
            date_index=dates,
            source_frames={"industry_nodes": panel.industry_nodes},
        ),
    ).combined.reindex(columns=CURVE_COLUMNS)
    start = cutoff - pd.DateOffset(years=years)
    left = dates.searchsorted(start, side="left") + 19
    right = dates.searchsorted(cutoff, side="left")
    frame = frame.iloc[left:right]
    complete = frame.loc[np.isfinite(frame).all(axis=1)]
    if len(complete) < 3:
        raise ValueError("curve projection requires three complete pre-cutoff windows")
    values = complete.to_numpy()
    if np.linalg.matrix_rank(values - values.mean(axis=0)) < 3:
        raise ValueError("curve projection cannot identify three components")
    pca = PCA(n_components=3, svd_solver="full").fit(values)
    return {
        "columns": list(CURVE_COLUMNS),
        "mean": pca.mean_.tolist(),
        "components": pca.components_.tolist(),
        "audit": {
            "cutoff": cutoff.date().isoformat(),
            "window_start": start.date().isoformat(),
            "complete_windows": len(complete),
            "eligible_windows": len(frame),
            "first_endpoint": complete.index.min().date().isoformat(),
            "last_endpoint": complete.index.max().date().isoformat(),
            "variance_ratio": pca.explained_variance_ratio_.tolist(),
            "weighting": "one equal-weight complete quote window per date",
            "preprocessing": "bp means only; no variance scaling or imputation",
        },
    }


def project_curve(features, state):
    values = features.reindex(columns=state["columns"]).to_numpy(dtype=float)
    scores = (values - np.asarray(state["mean"])) @ np.asarray(state["components"]).T
    scores[~np.isfinite(values).all(axis=1)] = np.nan
    return pd.concat(
        [features, pd.DataFrame(scores, columns=PC_COLUMNS, index=features.index)],
        axis=1,
    )


def curve_forecast_data(panel):
    """Use the shared raw quote bundle and existing natural-day label semantics."""
    from .issuance_market_change import market_labels

    dates = panel.rates.market_features.index
    raw = build_feature_bundle(
        ("coupon_quote_history",),
        FeatureBuildContext(
            data_path=Path("."),
            date_index=dates,
            source_frames={"industry_nodes": panel.industry_nodes},
        ),
    ).combined.reindex(columns=CURVE_COLUMNS)
    current = raw[[f"sector_{t}_quote_lag_0_bp" for t in (1, 3, 5, 7, 10)]]
    targets = {}
    label_ends = []
    for horizon in (1, 14, 30):
        _, labels = market_labels(panel, horizon)
        assert len(labels) == len(dates) * 5
        ending_dates = pd.DatetimeIndex(labels.label_end.iloc[::5])
        values = current.reindex(ending_dates).to_numpy().copy()
        deadlines = pd.DatetimeIndex(labels.deadline.iloc[::5])
        values[deadlines > dates[-1]] = np.nan
        for index, tenor in enumerate((1, 3, 5, 7, 10)):
            targets[f"h{horizon}_t{tenor}"] = values[:, index]
        label_ends.append(labels.label_end.iloc[::5].to_numpy())
    meta = pd.DataFrame(
        {
            "origin": dates + pd.Timedelta(days=1),
            "source_date": dates,
            "oldest_input_date": pd.Series(dates).shift(19).to_numpy(),
            "label_end": pd.DataFrame(np.column_stack(label_ends))
            .max(axis=1)
            .to_numpy(),
            "deadline": dates + pd.Timedelta(days=31),
        },
        index=dates,
    )
    return raw, pd.DataFrame(targets, index=dates), meta


def fit_curve_forecast(features, targets, meta, cutoff):
    """Fit one fixed PLS2 model, with all fifteen targets matured before cutoff."""
    import warnings
    from sklearn.cross_decomposition import PLSRegression
    from sklearn.exceptions import ConvergenceWarning

    cutoff = pd.Timestamp(cutoff)
    start = cutoff - pd.DateOffset(years=3)
    mask = (
        meta.oldest_input_date.ge(start)
        & meta.deadline.lt(cutoff)
        & meta.label_end.lt(cutoff)
        & np.isfinite(features).all(axis=1)
        & np.isfinite(targets).all(axis=1)
    )
    x, y = features.loc[mask].to_numpy(), targets.loc[mask].to_numpy()
    if len(x) < 3 or np.linalg.matrix_rank(x - x.mean(axis=0)) < 3:
        raise ValueError(
            "curve forecast requires three identifiable complete components"
        )
    with warnings.catch_warnings():
        warnings.simplefilter("error", ConvergenceWarning)
        model = PLSRegression(n_components=3, scale=False, max_iter=500, tol=1e-6).fit(
            x, y
        )
    if len(model.n_iter_) != 3:
        raise ValueError("curve forecast did not identify all three components")
    # PLS predict centers X; intercept_ is the fitted Y mean.
    state = {
        "columns": list(features),
        "targets": list(targets),
        "x_mean": x.mean(axis=0).tolist(),
        "coef": model.coef_.tolist(),
        "y_mean": model.intercept_.tolist(),
        "audit": {
            "cutoff": cutoff.date().isoformat(),
            "window_start": start.date().isoformat(),
            "complete_origins": len(x),
            "first_input_date": meta.loc[mask, "oldest_input_date"]
            .min()
            .date()
            .isoformat(),
            "last_origin": meta.loc[mask, "origin"].max().date().isoformat(),
            "last_deadline": meta.loc[mask, "deadline"].max().date().isoformat(),
            "last_label_date": meta.loc[mask, "label_end"].max().date().isoformat(),
            "components": 3,
            "scale": False,
            "iterations": model.n_iter_,
        },
    }
    np.testing.assert_allclose(
        predict_curve_forecast(features.loc[mask], state), model.predict(x), atol=1e-9
    )
    return state


def predict_curve_forecast(features, state):
    values = features.reindex(columns=state["columns"]).to_numpy(dtype=float)
    result = (values - np.asarray(state["x_mean"])) @ np.asarray(
        state["coef"]
    ).T + np.asarray(state["y_mean"])
    result[~np.isfinite(values).all(axis=1)] = np.nan
    return result
