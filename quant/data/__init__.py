"""兼容公共接口按需加载；导入子模块不再加载历史模型。"""

from importlib import import_module
from pathlib import Path

DATA_DIR = Path(__file__).parent

_EXPORTS = {
    "Path": ["pathlib", "Path"],
    "BondDataBuilder": ["data", "BondDataBuilder"],
    "FeatureEngineer": ["data", "FeatureEngineer"],
    "compute_peer_stats": ["data", "compute_peer_stats"],
    "load_subject_spread_features": ["data", "load_subject_spread_features"],
    "EQUITY_FIELD_SPECS": ["equity", "EQUITY_FIELD_SPECS"],
    "MARGIN_EQUITY_FEATURES": ["equity", "MARGIN_EQUITY_FEATURES"],
    "build_equity_features": ["equity", "build_equity_features"],
    "build_margin_equity_features": ["equity", "build_margin_equity_features"],
    "load_equity_features": ["equity", "load_equity_features"],
    "load_equity_market_data": ["equity", "load_equity_market_data"],
    "load_margin_equity_features": ["equity", "load_margin_equity_features"],
    "BOND_MARKET_FEATURE_GROUPS": ["feature_engineering", "BOND_MARKET_FEATURE_GROUPS"],
    "FEATURE_GROUP_REGISTRY": ["feature_engineering", "FEATURE_GROUP_REGISTRY"],
    "MARGIN_BASE_SOURCE_GROUPS": ["feature_engineering", "MARGIN_BASE_SOURCE_GROUPS"],
    "MARGIN_MARKET_FEATURE_GROUPS": [
        "feature_engineering",
        "MARGIN_MARKET_FEATURE_GROUPS",
    ],
    "MARGIN_OPTIONAL_SOURCE_GROUPS": [
        "feature_engineering",
        "MARGIN_OPTIONAL_SOURCE_GROUPS",
    ],
    "FeatureBuildContext": ["feature_engineering", "FeatureBuildContext"],
    "FeatureBundle": ["feature_engineering", "FeatureBundle"],
    "FeatureGroupSpec": ["feature_engineering", "FeatureGroupSpec"],
    "build_bond_issue_features": ["feature_engineering", "build_bond_issue_features"],
    "build_calendar_features": ["feature_engineering", "build_calendar_features"],
    "build_feature_bundle": ["feature_engineering", "build_feature_bundle"],
    "build_funding_features": ["feature_engineering", "build_funding_features"],
    "build_macro_features": ["feature_engineering", "build_macro_features"],
    "build_peer_features": ["feature_engineering", "build_peer_features"],
    "build_primary_bond_features": [
        "feature_engineering",
        "build_primary_bond_features",
    ],
    "build_proprietary_features": ["feature_engineering", "build_proprietary_features"],
    "build_secondary_bond_features": [
        "feature_engineering",
        "build_secondary_bond_features",
    ],
}

__all__ = [
    "DATA_DIR",
    "BondDataBuilder",
    "BOND_MARKET_FEATURE_GROUPS",
    "EQUITY_FIELD_SPECS",
    "FEATURE_GROUP_REGISTRY",
    "FeatureEngineer",
    "FeatureBuildContext",
    "FeatureBundle",
    "FeatureGroupSpec",
    "MARGIN_MARKET_FEATURE_GROUPS",
    "MARGIN_BASE_SOURCE_GROUPS",
    "MARGIN_EQUITY_FEATURES",
    "MARGIN_OPTIONAL_SOURCE_GROUPS",
    "build_bond_issue_features",
    "build_calendar_features",
    "build_equity_features",
    "build_margin_equity_features",
    "build_feature_bundle",
    "build_funding_features",
    "build_macro_features",
    "build_peer_features",
    "build_primary_bond_features",
    "build_proprietary_features",
    "build_secondary_bond_features",
    "compute_peer_stats",
    "load_equity_features",
    "load_equity_market_data",
    "load_margin_equity_features",
    "load_subject_spread_features",
]


def __getattr__(name):
    if name not in _EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module, attribute = _EXPORTS[name]
    value = getattr(import_module(f".{module}", __name__), attribute)
    globals()[name] = value
    return value
