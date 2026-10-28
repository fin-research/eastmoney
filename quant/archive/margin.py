"""全市场两融余额 T+1/T+5/T+20 预测评估 CLI。"""

from __future__ import annotations

import argparse
from datetime import date
from pathlib import Path

from archive.margin_flow import (
    PRODUCTION_FEATURE_GROUPS,
    PipelineConfig,
    run_pipeline,
    save_pipeline_result,
)
from archive.margin_flow.market_data import MARGIN_OPTIONAL_FEATURE_GROUPS
from archive.margin_flow.models import MODEL_REGISTRY


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="全市场两融余额多期限模型评估",
    )
    parser.add_argument(
        "--models",
        nargs="+",
        choices=tuple(MODEL_REGISTRY),
        default=list(MODEL_REGISTRY),
        help="要评估的模型，默认运行五类生产模型",
    )
    parser.add_argument(
        "--initial-train-years",
        type=int,
        default=2,
        help="首次年度验证前的初始训练年数，默认 2",
    )
    parser.add_argument(
        "--test-year",
        type=int,
        default=date.today().year,
        help="一次性最终测试年份，默认今年",
    )
    parser.add_argument(
        "--timesfm-per-core-batch-size",
        type=int,
        default=32,
        help="TimesFM 内部每次推理的序列数，默认 32",
    )
    parser.add_argument(
        "--additional-feature-groups",
        nargs="+",
        choices=MARGIN_OPTIONAL_FEATURE_GROUPS,
        default=[],
        help=(
            "在生产默认 margin_equity、margin_behavior 之外追加特征组；当前支持 macro"
        ),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="可选输出目录；保存 predictions.csv、metrics.csv、metadata.json",
    )
    return parser.parse_args()


def cli() -> None:
    args = _parse_args()
    config = PipelineConfig(
        models=tuple(args.models),
        initial_train_years=args.initial_train_years,
        test_year=args.test_year,
        timesfm_per_core_batch_size=args.timesfm_per_core_batch_size,
        additional_feature_groups=tuple(
            dict.fromkeys(
                PRODUCTION_FEATURE_GROUPS + tuple(args.additional_feature_groups)
            )
        ),
    )
    result = run_pipeline(config)
    if args.output_dir:
        save_pipeline_result(result, args.output_dir)


if __name__ == "__main__":
    cli()
