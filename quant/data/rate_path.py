"""Past multi-market quote paths for timing research; no forecast corrections."""

import numpy as np
import pandas as pd

PATH_SOURCES = ("GOV_1Y", "GOV_3Y", "GOV_10Y", "CDB_3Y", "CDB_10Y", "AAA_3Y")
PATH_LAGS = tuple(range(1, 21))


def rate_path_features(frame, dates):
    """EOD history relative to that close, in bp, on the supplied quote clock.

    Missing quotes remain missing. The caller must shift the complete bundle
    once to obtain opening information. Nothing here predicts a reversal or
    imposes a direction on the downstream learned cost model.
    """
    raw = frame.reindex(index=dates, columns=PATH_SOURCES).replace(0, np.nan)
    return pd.DataFrame(
        {
            f"path_{name.lower()}_lag_{lag}_bp": (raw[name].shift(lag) - raw[name])
            * 100
            for name in PATH_SOURCES
            for lag in PATH_LAGS
        },
        index=dates,
    )
