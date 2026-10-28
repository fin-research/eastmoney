"""One learned product contrast interacting with the current sector quote."""

PRODUCT_QUOTE = "product_sector_quote"
SECTOR_QUOTE = "sector_quote_lag_0_bp"


def fit_product_quote(train):
    levels = sorted(train.bond_type.unique())
    observed = train[SECTOR_QUOTE].dropna()
    if len(levels) != 2 or observed.empty:
        raise ValueError("product interaction requires two products and sector quotes")
    return {
        "contrast": {level: index - 0.5 for index, level in enumerate(levels)},
        "sector_mean_bp": float(observed.mean()),
    }


def product_quote_feature(features, state):
    contrast = features.bond_type.map(state["contrast"]).fillna(0.0)
    quote = features[SECTOR_QUOTE].astype(float)
    return (contrast * (quote - state["sector_mean_bp"])).where(contrast.ne(0), 0.0)
