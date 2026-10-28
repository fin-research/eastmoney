"""Dispatch local applications under the shared process resource monitor."""

from datetime import datetime
import os
from pathlib import Path
import sys
from zoneinfo import ZoneInfo

from .arguments import parse_args
from . import pipeline

MODES = (
    ("curve_research", "--curve-research 不与其他模式同时使用"),
    ("timing_research", "--timing-research 不与其他模型模式同时使用"),
    ("conditional_research", "--conditional-research 不与其他模型模式同时使用"),
    ("issuance_backtest", "--issuance-backtest 不与其他模型模式同时使用"),
    ("primary_research", "--primary-research 不与其他模型运行模式同时使用"),
    ("rate_research", "--rate-research 不与 --online 同时使用"),
    ("online", ""),
)


def _terms(args, *, placement=False):
    names = ("issuer", "rating", "tenor", "bond_type")
    if placement:
        names += ("placement_type",)
    return {name: getattr(args, name) for name in names}


def _mode(args):
    if args.refresh_pricing_metadata and not args.primary_research:
        raise SystemExit("--refresh-pricing-metadata 仅与 --primary-research 使用")
    if args.event_overrides:
        raise SystemExit("统一票面回测不接受事件覆盖；请修正来源数据并生成新的输入快照")
    active = [(name, message) for name, message in MODES if getattr(args, name)]
    if len(active) > 1:
        raise SystemExit(active[0][1])
    return active[0][0] if active else "forecast"


def _curve_research(args):
    return pipeline.run_curve_research(
        args.research_output,
        args.as_of,
        args.input_snapshot,
        args.funding_history,
        args.window_days,
        _terms(args),
        args.waiting_cost_bp_day,
        args.curve_target,
    )


def _timing_research(args):
    return pipeline.run_timing_research(
        args.research_output,
        args.as_of,
        args.input_snapshot,
        _terms(args),
        args.waiting_cost_bp_day,
    )


def _conditional_research(args):
    return pipeline.run_conditional_research(
        args.research_output,
        args.as_of,
        args.input_snapshot,
    )


def _issuance_backtest(args):
    return pipeline.run_coupon_backtest(
        args.backtest_output,
        args.as_of,
        args.input_snapshot,
        args.study_protocol,
    )


def _primary_research(args):
    return pipeline.run_primary_research(
        args.research_output,
        args.as_of,
        args.refresh_pricing_metadata,
    )


def _rate_research(args):
    return pipeline.run_rate_research(args.research_output)


def _online(args):
    from .online import run_online

    return run_online(
        args.online,
        args.bundle_dir,
        args.as_of or datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat(),
        args.input_snapshot,
        terms=_terms(args, placement=True),
        days=args.window_days,
        size=args.issue_size,
        evaluation_directory=args.evaluation_dir,
        coupon_selection=args.coupon_selection,
    )


def _forecast(args):
    snapshot = pipeline.run_issuance_forecast(
        args.forecast_output,
        args.as_of,
        args.window_days,
        args.input_snapshot,
        _terms(args, placement=True),
        args.market_model,
        args.issue_size,
        args.waiting_cost_bp_day,
        args.evaluation_dir,
        args.coupon_selection,
    )
    if args.output:
        from artifacts import write_json

        write_json(args.output, snapshot)
    return snapshot


RUNNERS = {
    "curve_research": _curve_research,
    "timing_research": _timing_research,
    "conditional_research": _conditional_research,
    "issuance_backtest": _issuance_backtest,
    "primary_research": _primary_research,
    "rate_research": _rate_research,
    "online": _online,
    "forecast": _forecast,
}


def dispatch(args):
    return RUNNERS[_mode(args)](args)


def main(argv=None):
    args = parse_args(argv)
    if not os.environ.get("QUANT_BOUNDED_PROCESS"):
        from model.research_resources import bounded_command

        entry = Path(__file__).resolve().parents[1] / "main.py"
        return bounded_command(
            [
                sys.executable,
                str(entry),
                *(sys.argv[1:] if argv is None else argv),
            ]
        )
    dispatch(args)
    return 0
