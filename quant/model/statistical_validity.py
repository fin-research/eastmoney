"""Paired, dependence-aware research tests with explicit multiple-comparison control."""

import numpy as np
import pandas as pd


def paired_block_test(gains, *, block_size=31, repetitions=4999, confidence=0.95):
    """H0: mean gain <= 0; positive gain means lower loss/cost than baseline.

    Circular moving-block resampling preserves equal endpoint weights and local
    dependence under a stationary approximation. At least eight blocks are
    required; repetitions cannot replace independent information. Centered
    bootstrap gives a one-sided null p-value; percentile CI is descriptive.
    Neither this nor Holm reverses prior reuse of a historical test period.
    """
    values = np.asarray(gains, dtype=float)
    if values.ndim != 1 or not np.isfinite(values).all():
        raise ValueError("paired test requires complete finite common observations")
    if block_size < 1 or repetitions < 99 or not 0 < confidence < 1:
        raise ValueError("invalid block bootstrap specification")
    n = len(values)
    result = {
        "samples": n,
        "block_size": block_size,
        "approximate_blocks": n // block_size,
        "gain_bp": float(values.mean()) if n else np.nan,
        "low95_bp": np.nan,
        "high95_bp": np.nan,
        "p_one_sided": np.nan,
        "status": "insufficient_blocks",
    }
    if n < 8 * block_size:
        return result
    rng = np.random.default_rng(20260921)
    # Batch to keep high-resolution familywise p-values from allocating B x n
    # matrices. A 500-test family cannot reject at 5% with only 4999 replicates.
    means = np.empty(repetitions)
    for offset in range(0, repetitions, 512):
        count = min(512, repetitions - offset)
        starts = rng.integers(0, n, size=(count, int(np.ceil(n / block_size))))
        indices = ((starts[:, :, None] + np.arange(block_size)) % n).reshape(count, -1)[
            :, :n
        ]
        means[offset : offset + count] = values[indices].mean(axis=1)
    null = means - values.mean()
    result.update(
        low95_bp=float(np.quantile(means, (1 - confidence) / 2)),
        high95_bp=float(np.quantile(means, (1 + confidence) / 2)),
        confidence_level=confidence,
        p_one_sided=float((1 + (null >= values.mean()).sum()) / (repetitions + 1)),
        status="historical_circular_block_bootstrap",
    )
    return result


def holm_adjust(p_values):
    """Holm family-wise adjustment; untestable hypotheses retain their family slot."""
    values = np.asarray(p_values, dtype=float)
    if ((values[np.isfinite(values)] < 0) | (values[np.isfinite(values)] > 1)).any():
        raise ValueError("p-values must lie in [0, 1]")
    order = np.argsort(np.where(np.isfinite(values), values, 1.0))
    corrected = np.full(len(values), np.nan)
    running = 0.0
    for position, index in enumerate(order):
        if np.isfinite(values[index]):
            running = max(running, min(1.0, values[index] * (len(values) - position)))
            corrected[index] = running
    return corrected


def adjust_test_family(records):
    frame = pd.DataFrame(records)
    frame["p_holm"] = holm_adjust(frame.p_one_sided)
    frame["significant_95"] = frame.p_holm.lt(0.05) & frame.low95_bp.gt(0)
    frame["family_size"] = len(frame)
    frame["confirmation"] = "historical_research_only; previously observed data"
    return frame


def market_validity(predictions):
    """One prespecified horizon (30); no picking the best among 31 horizons."""
    frame = predictions.loc[predictions.horizon.eq(30)].copy()
    frame["period"] = np.where(
        frame.origin.dt.year < 2026, "development", "observed_reference"
    )
    reports = []
    for period, group in frame.groupby("period"):
        if group.groupby("origin").change_bp.nunique(dropna=False).ne(1).any():
            raise ValueError("inconsistent paired market targets")
        wide = group.pivot(
            index="origin", columns="candidate", values="prediction_bp"
        ).sort_index()
        actual = (
            group.drop_duplicates("origin")
            .set_index("origin")
            .change_bp.reindex(wide.index)
        )
        losses = wide.sub(actual, axis=0).abs()
        _require_baselines(wide)
        records = []
        for candidate in wide.columns:
            for baseline in ("random_walk", "historical_drift", "lgb_anchor_drift"):
                if candidate == baseline:
                    continue
                result = paired_block_test(losses[baseline] - losses[candidate])
                records.append(
                    {
                        "period": period,
                        "candidate": candidate,
                        "baseline": baseline,
                        **result,
                    }
                )
        reports.append(adjust_test_family(records))
    return pd.concat(reports, ignore_index=True)


def coupon_validity(paths):
    """Average the 30 origins and same-day tranches before any resampling."""
    frame = paths.loc[
        paths.status.eq("estimated") & paths.date_basis.eq("issue_date")
    ].copy()
    frame["loss"] = frame.error_bp.abs()
    identity = ["issuer", "pricing_date", "bond_code", "as_of"]
    wide = frame.pivot(index=identity, columns="candidate", values="loss")
    _require_baselines(wide)
    if wide.isna().any().any():
        raise ValueError("coupon inference requires identical candidate coverage")
    events = (
        wide.groupby(["issuer", "pricing_date"]).mean().sort_index(level="pricing_date")
    )
    records = []
    for candidate in events.columns:
        for baseline in ("random_walk", "historical_drift", "lgb_anchor_drift"):
            if candidate != baseline:
                records.append(
                    {
                        "candidate": candidate,
                        "baseline": baseline,
                        **paired_block_test(
                            events[baseline] - events[candidate], block_size=3
                        ),
                    }
                )
    return adjust_test_family(records)


def policy_validity(policy):
    """Use a fixed chronological non-overlap schedule, then block adjacent windows."""
    if policy.duplicated(["candidate", "origin"]).any():
        raise ValueError("duplicate policy origins")
    counts = policy.groupby("origin").candidate.nunique()
    if counts.ne(policy.candidate.nunique()).any():
        raise ValueError("policy candidates must cover identical origins")
    if policy.groupby("origin").deadline.nunique().ne(1).any():
        raise ValueError("policy candidates must share deadlines")
    records = []
    for candidate, group in policy.groupby("candidate"):
        group = group.sort_values("origin")
        selected, end = [], pd.Timestamp.min
        for index, row in group.iterrows():
            if row.origin > end:
                selected.append(index)
                end = row.deadline
        independent = group.loc[selected]
        for baseline, column in (
            ("immediate", "saving_vs_immediate_bp"),
            ("deadline", "saving_vs_deadline_bp"),
        ):
            records.append(
                {
                    "candidate": candidate,
                    "baseline": baseline,
                    **paired_block_test(independent[column], block_size=3),
                }
            )
    return adjust_test_family(records)


def _require_baselines(wide):
    if not {"random_walk", "historical_drift", "lgb_anchor_drift"} <= set(wide.columns):
        raise ValueError("statistical comparison requires all registered baselines")
