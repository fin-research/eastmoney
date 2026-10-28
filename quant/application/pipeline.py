"""Lazy application mode lookup for the CLI."""

from importlib import import_module

MODULES = {
    "_model_sample_metadata": "evaluation",
    "_coupon_inputs": "inputs",
    "_prepare_issuance_engine": "inputs",
    "_require_empty_research_directory": "curve_research",
    "run_issuance_forecast": "forecast",
    "run_curve_research": "curve_research",
    "run_timing_research": "curve_research",
    "run_conditional_research": "curve_research",
    "run_rate_research": "pricing_research",
    "run_primary_research": "pricing_research",
    "run_coupon_backtest": "evaluation",
    "run_issuance_backtest": "evaluation",
}


def __getattr__(name):
    if name not in MODULES:
        raise AttributeError(name)
    return getattr(import_module("application." + MODULES[name]), name)
