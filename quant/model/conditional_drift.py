"""可解释的资金/趋势/波动状态漂移，稀疏状态向同窗口无条件均值收缩。"""

from dataclasses import dataclass

import numpy as np
import pandas as pd


CONDITIONAL_FEATURES = (
    "dr007_vs_policy",
    "rate_aaa_3y_change_20",
    "rate_aaa_3y_volatility_20",
)


def market_states(features, volatility_cutoff):
    funding = features.dr007_vs_policy.to_numpy(dtype=float)
    trend = features.rate_aaa_3y_change_20.to_numpy(dtype=float)
    volatility = features.rate_aaa_3y_volatility_20.to_numpy(dtype=float)
    # Funding is in percentage points; trend and daily volatility are in bp.
    scaled_trend = trend / (np.maximum(volatility, 0.25) * np.sqrt(20))
    valid = np.isfinite(np.column_stack([funding, trend, volatility])).all(axis=1)
    funding_state = np.select([funding < -0.1, funding > 0.1], [-1, 1], default=0)
    trend_state = np.select([scaled_trend < -1, scaled_trend > 1], [-1, 1], default=0)
    vol_state = (volatility > volatility_cutoff).astype(int)
    # 18 coarse states; -1 explicitly means unknown, never a fabricated neutral state.
    states = (funding_state + 1) * 6 + (trend_state + 1) * 2 + vol_state
    return np.where(valid, states, -1)


@dataclass(frozen=True)
class ConditionalDrift:
    unconditional_mean: float
    volatility_cutoff: float
    state_means: dict
    state_counts: dict
    prior_samples: int = 120
    minimum_state_samples: int = 30

    def predict(self, features):
        states = market_states(features, self.volatility_cutoff)
        values = []
        for state in states:
            count = self.state_counts.get(int(state), 0)
            weight = (
                count / (count + self.prior_samples)
                if count >= self.minimum_state_samples
                else 0.0
            )
            mean = self.state_means.get(int(state), self.unconditional_mean)
            values.append(
                self.unconditional_mean + weight * (mean - self.unconditional_mean)
            )
        return np.asarray(values)


def fit_conditional_drift(features, target):
    """Threshold estimation and state outcomes use the caller's purged training fold only."""
    if not features.index.equals(target.index):
        raise ValueError("conditional drift feature/label index mismatch")
    valid = target.notna()
    features, target = features.loc[valid], target.loc[valid]
    if target.empty:
        raise ValueError("conditional drift needs mature training labels")
    volatility = features.rate_aaa_3y_volatility_20.dropna()
    cutoff = float(volatility.median()) if len(volatility) else 0.0
    states = market_states(features, cutoff)
    grouped = pd.DataFrame({"state": states, "target": target.to_numpy()})
    grouped = grouped.loc[grouped.state.ge(0)].groupby("state").target
    return ConditionalDrift(
        float(target.mean()), cutoff, grouped.mean().to_dict(), grouped.size().to_dict()
    )
