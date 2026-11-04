"""Direction-free 30-day range for the issue-now versus wait decision.

The label is the one used by the timing study: the mean of the quotes in the
30 calendar days after decision day T minus the quote on T, in bp. Positive
means issuing now beats the later average. Direction is not forecast: the
drift is zero and the spread comes from recent daily volatility, scaled by the
historical ratio of the label to that volatility.
"""

import numpy as np
import pandas as pd

HORIZON_DAYS = 30
HALF_LIFE = 20
MIN_QUOTES = 60
MIN_LABELS = 250
MAX_LABELS = 750
MATERIAL_BP = 5.0
BAND_LEVELS = (0.5, 0.8)


def daily_scale(levels_bp):
    """EWMA daily change volatility, bp. Value at i uses quotes up to i only."""
    changes = levels_bp.diff()
    return np.sqrt((changes**2).ewm(halflife=HALF_LIFE, min_periods=MIN_QUOTES).mean())


def window_change(levels_bp, horizon=HORIZON_DAYS):
    """Label per origin quote i: decision day T is quote i+1, A = mean(T, T+h] - T.

    Origins whose window reaches beyond the last quote stay NaN.
    """
    dates = levels_bp.index
    values = levels_bp.to_numpy(float)
    result = np.full(len(values), np.nan)
    for i in range(len(values) - 2):
        end = dates[i + 1] + pd.Timedelta(days=horizon)
        if end > dates[-1]:
            break
        stop = dates.searchsorted(end, side="right")
        if stop > i + 2:
            result[i] = values[i + 2 : stop].mean() - values[i + 1]
    return pd.Series(result, index=dates, name="change_bp")


def range_forecast(levels_bp, *, material_bp=MATERIAL_BP):
    """Range for the day after the last quote, from quotes up to that quote.

    Only labels whose windows ended on or before the last quote are used, so a
    forecast never depends on quotes it could not have seen.
    """
    levels_bp = levels_bp.dropna().sort_index()
    if levels_bp.index.has_duplicates or (levels_bp <= 0).any():
        raise ValueError("Quotes must be unique and positive")
    scale = daily_scale(levels_bp)
    labels = window_change(levels_bp)
    ratio = (labels / scale).abs().dropna().iloc[-MAX_LABELS:]
    if len(ratio) < MIN_LABELS or not np.isfinite(scale.iloc[-1]):
        raise ValueError("Not enough history for a volatility range")
    sigma = float(scale.iloc[-1])
    bands = {}
    for level in BAND_LEVELS:
        half = sigma * float(ratio.quantile(level))
        bands[f"{round(level * 100)}"] = [-half, half]
    material = float((ratio * sigma > material_bp).mean())
    return {
        "source_date": str(levels_bp.index[-1].date()),
        "daily_sigma_bp": sigma,
        "label_count": int(len(ratio)),
        "material_bp": material_bp,
        "bands_bp": bands,
        "p_material_move": material,
        "p_issue_now_better": material / 2,
        "p_waiting_better": material / 2,
    }
