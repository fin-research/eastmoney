"""Raw records from the latest strictly-prior mature primary issuance batch."""

import numpy as np
import pandas as pd

PRIMARY_BATCH_COLUMNS = (
    *(
        f"primary_slot_{slot}_{field}"
        for slot in (1, 2, 3)
        for field in ("coupon_bp", "tenor")
    ),
    "primary_batch_age_days",
)


def primary_batch_features(requests, events):
    """Retain all records on the latest available day, never choose by coupon."""
    keys = ["issuer", "bond_type", "placement_type"]
    histories = dict(tuple(events.groupby(keys, sort=False)))
    output = np.full((len(requests), len(PRIMARY_BATCH_COLUMNS)), np.nan)
    for key, indices in requests.groupby(keys, sort=False).indices.items():
        history = histories.get(key)
        if history is None:
            continue
        for index in indices:
            request = requests.iloc[index]
            available = history.loc[
                history.label_available_date.lt(request.origin)
                & history.label_available_date.ge(
                    request.origin - pd.Timedelta(days=365)
                )
                & history.bond_code.ne(request.bond_code)
            ]
            if available.empty:
                continue
            batch = available.loc[
                available.label_available_date.eq(available.label_available_date.max())
            ].sort_values(["tenor", "bond_code"])
            if len(batch) > 3:
                raise ValueError(
                    "latest primary batch exceeds three records; no truncation"
                )
            output[index, : 2 * len(batch)] = (
                batch[["coupon_bp", "tenor"]].to_numpy().ravel()
            )
            output[index, -1] = (
                request.origin - batch.label_available_date.iloc[0]
            ).days
    return pd.DataFrame(output, columns=PRIMARY_BATCH_COLUMNS, index=requests.index)
