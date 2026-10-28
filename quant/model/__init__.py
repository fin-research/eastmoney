"""兼容公共接口按需加载；导入子模块不再加载历史模型。"""

from importlib import import_module

_EXPORTS = {
    "BondTimingModel": ["cv", "BondTimingModel"],
    "TimeSeriesCV": ["cv", "TimeSeriesCV"],
    "CALENDAR_FEATURES": ["features", "CALENDAR_FEATURES"],
    "split_feature_names": ["features", "split_feature_names"],
    "check_ood": ["ood", "check_ood"],
    "knn_fallback_predict": ["ood", "knn_fallback_predict"],
    "predict_with_ood_check": ["ood", "predict_with_ood_check"],
    "build_market_feature_vec": ["scoring", "build_market_feature_vec"],
    "compute_company_readiness": ["scoring", "compute_company_readiness"],
    "fill_features": ["scoring", "fill_features"],
    "lookup_group_threshold": ["scoring", "lookup_group_threshold"],
    "predict_with_fillna": ["scoring", "predict_with_fillna"],
    "recommend_issue": ["scoring", "recommend_issue"],
    "score_market": ["scoring", "score_market"],
    "shap_top_drivers": ["scoring", "shap_top_drivers"],
    "tenor_bucket": ["scoring", "tenor_bucket"],
    "LGB_PARAMS": ["train", "LGB_PARAMS"],
    "build_monthly_models": ["train", "build_monthly_models"],
    "compute_group_thresholds": ["train", "compute_group_thresholds"],
    "lookup_monthly_model": ["train", "lookup_monthly_model"],
    "train_issue_horizon_models": ["train", "train_issue_horizon_models"],
    "train_issue_model": ["train", "train_issue_model"],
    "train_lgb": ["train", "train_lgb"],
    "train_market_model": ["train", "train_market_model"],
    "train_market_model_v2": ["train", "train_market_model_v2"],
}

__all__ = [
    "LGB_PARAMS",
    "train_lgb",
    "compute_group_thresholds",
    "train_issue_model",
    "train_issue_horizon_models",
    "build_monthly_models",
    "lookup_monthly_model",
    "train_market_model",
    "train_market_model_v2",
    "CALENDAR_FEATURES",
    "split_feature_names",
    "check_ood",
    "knn_fallback_predict",
    "predict_with_ood_check",
    "tenor_bucket",
    "fill_features",
    "shap_top_drivers",
    "predict_with_fillna",
    "build_market_feature_vec",
    "lookup_group_threshold",
    "recommend_issue",
    "score_market",
    "compute_company_readiness",
    "TimeSeriesCV",
    "BondTimingModel",
]


def __getattr__(name):
    if name not in _EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module, attribute = _EXPORTS[name]
    value = getattr(import_module(f".{module}", __name__), attribute)
    globals()[name] = value
    return value
