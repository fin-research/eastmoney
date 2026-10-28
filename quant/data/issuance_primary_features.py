"""Point-in-time, target-tenor primary coupon history for the shared model."""

import numpy as np
import pandas as pd


WEIGHTED_PRIMARY_COLUMNS = (
    "issuer_weighted_premium_bp",
    "issuer_weighted_latest_bp",
    "issuer_weighted_age_days",
    "issuer_weighted_neff",
    "peer_weighted_premium_bp",
    "peer_weighted_latest_bp",
    "peer_weighted_age_days",
    "peer_weighted_neff",
    "issuer_shrunk_premium_bp",
)
INDUSTRY_BASIS_COLUMNS = (
    "issuer_industry_basis_bp",
    "issuer_industry_basis_latest_bp",
    "issuer_industry_basis_age_days",
    "issuer_industry_basis_neff",
    "peer_industry_basis_bp",
    "peer_industry_basis_latest_bp",
    "peer_industry_basis_age_days",
    "peer_industry_basis_neff",
    "issuer_shrunk_industry_basis_bp",
    "issuer_industry_basis_observations",
    "peer_industry_basis_observations",
    "industry_basis_fallback",
)


def _weighted_group(requests, events, keys):
    """Mean, latest, age and effective count, with one event per observation."""
    result = np.full((len(requests), 4), np.nan)
    histories = {
        key if isinstance(key, tuple) else (key,): group
        for key, group in events.groupby(list(keys), sort=False, dropna=False)
    }
    for key, positions in requests.groupby(list(keys), sort=False).indices.items():
        key = key if isinstance(key, tuple) else (key,)
        history = histories.get(key)
        if history is None:
            continue
        history = history.sort_values(["label_available_date", "bond_code"])
        dates = history.label_available_date.to_numpy("datetime64[ns]")
        premium = history.history_premium_bp.to_numpy(dtype=float)
        tenor = history.tenor.to_numpy(dtype=float)
        positions = np.asarray(positions)
        for chunk in np.array_split(positions, max(1, (len(positions) + 255) // 256)):
            queries = requests.iloc[chunk]
            origins = queries.origin.to_numpy("datetime64[ns]")
            age = (origins[:, None] - dates[None, :]) / np.timedelta64(1, "D")
            distance = np.abs(queries.tenor.to_numpy(dtype=float)[:, None] - tenor)
            eligible = (age > 0) & (age <= 730)
            weights = np.exp(-np.log(2) * np.maximum(age, 0) / 90 - distance / 2)
            weights *= eligible
            total = weights.sum(axis=1)
            effective = np.divide(
                total**2,
                (weights**2).sum(axis=1),
                out=np.full(len(chunk), np.nan),
                where=total > 0,
            )
            result[chunk, 0] = np.divide(
                weights @ premium,
                total,
                out=np.full(len(chunk), np.nan),
                where=total > 0,
            )
            result[chunk, 3] = effective
            right = dates.searchsorted(origins, side="left")
            left = dates.searchsorted(origins - np.timedelta64(730, "D"), side="left")
            has = right > left
            result[chunk[has], 1] = premium[right[has] - 1]
            result[chunk[has], 2] = age[np.flatnonzero(has), right[has] - 1]
    return result


def weighted_primary_features(requests, events):
    """730-day half-life/tenor weighting with issuer-to-peer shrinkage."""
    own = _weighted_group(requests, events, ("issuer", "bond_type", "placement_type"))
    peer = _weighted_group(requests, events, ("rating", "bond_type", "placement_type"))
    shrink = own[:, 3] / (own[:, 3] + 5)
    blended = np.where(
        np.isfinite(own[:, 0]) & np.isfinite(peer[:, 0]),
        shrink * own[:, 0] + (1 - shrink) * peer[:, 0],
        np.where(np.isfinite(own[:, 0]), own[:, 0], peer[:, 0]),
    )
    values = np.column_stack((own, peer, blended))
    return pd.DataFrame(values, columns=WEIGHTED_PRIMARY_COLUMNS, index=requests.index)


def _mature_counts(requests, events, keys):
    result = np.zeros(len(requests))
    histories = dict(tuple(events.groupby(list(keys), sort=False)))
    for key, indices in requests.groupby(list(keys), sort=False).indices.items():
        history = histories.get(key)
        if history is None:
            continue
        dates = history.label_available_date.sort_values().to_numpy("datetime64[ns]")
        origins = requests.iloc[indices].origin.to_numpy("datetime64[ns]")
        result[indices] = dates.searchsorted(origins, side="left") - dates.searchsorted(
            origins - np.timedelta64(730, "D"), side="left"
        )
    return result


def industry_primary_features(requests, covered_events, current_industry):
    """Only curve-covered mature events enter industry-relative basis history.

    Missing historical curves never become government-relative observations.
    Missing current curve or all basis history means an explicit whole-row
    fallback to the existing government plus primary quote anchor.
    """
    result = weighted_primary_features(requests, covered_events)
    result.columns = INDUSTRY_BASIS_COLUMNS[:9]
    for prefix, keys in (
        ("issuer", ("issuer", "bond_type", "placement_type")),
        ("peer", ("rating", "bond_type", "placement_type")),
    ):
        result[f"{prefix}_industry_basis_observations"] = _mature_counts(
            requests, covered_events, keys
        )
    result["industry_basis_fallback"] = (
        ~np.isfinite(current_industry)
        | ~np.isfinite(result.issuer_shrunk_industry_basis_bp)
    ).astype(float)
    return result
