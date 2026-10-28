"""评估融资行为与两融专用权益特征对三层方案的增量。

本模块同时运行原三层方案和特征增强方案，共用标准年度 Expanding Window、
冻结测试与生产升级门槛。生产 Ridge/LightGBM 同步使用当前 54 特征口径。
"""

from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

from data import MARGIN_EQUITY_FEATURES

from .contracts import PRODUCTION_FEATURE_GROUPS, PipelineConfig
from .market_data import MARGIN_BEHAVIOR_FEATURES
from .models import build_models
from .pipeline import run_pipeline, save_pipeline_result
from .state_direction_quantile_experiment import (
    SCHEME_BASE_FEATURES,
    SCHEME_COMPONENTS,
    assess_production_upgrade,
    build_scheme_models,
    evaluate_scheme_diagnostics,
)

ENHANCED_PREFIX = "scheme_fe"
ENHANCED_COMPONENTS = tuple(
    f"{ENHANCED_PREFIX}_{component.removeprefix('scheme_')}"
    for component in SCHEME_COMPONENTS
)
ENHANCED_FEATURES = tuple(
    dict.fromkeys(
        SCHEME_BASE_FEATURES + MARGIN_EQUITY_FEATURES + MARGIN_BEHAVIOR_FEATURES
    )
)


def _build_production_models(skip_timesfm: bool):
    names = ["trend_persistence", "main_regression", "lightgbm", "three_layer"]
    if not skip_timesfm:
        names.insert(1, "timesfm")
    return build_models(names)


def compare_feature_increment(metrics: pd.DataFrame) -> pd.DataFrame:
    """比较同一三层组件加入补充特征前后的指标变化。"""
    records = []
    for base_name, enhanced_name in zip(
        SCHEME_COMPONENTS,
        ENHANCED_COMPONENTS,
        strict=True,
    ):
        for evaluation_set in ("validation", "test"):
            for horizon in (1, 5, 20):
                selected = metrics[
                    (metrics["evaluation_set"] == evaluation_set)
                    & (metrics["horizon"] == horizon)
                ]
                base = selected[selected["model"] == base_name]
                enhanced = selected[selected["model"] == enhanced_name]
                if base.empty or enhanced.empty:
                    continue
                base_row = base.iloc[0]
                enhanced_row = enhanced.iloc[0]
                records.append(
                    {
                        "evaluation_set": evaluation_set,
                        "horizon": horizon,
                        "component": base_name.removeprefix("scheme_"),
                        "base_mae": float(base_row["mae"]),
                        "enhanced_mae": float(enhanced_row["mae"]),
                        "mae_improvement_pct": float(
                            (1 - enhanced_row["mae"] / base_row["mae"]) * 100
                        ),
                        "direction_change_pp": float(
                            (
                                enhanced_row["direction_accuracy"]
                                - base_row["direction_accuracy"]
                            )
                            * 100
                        ),
                        "relative_error_change_pct": float(
                            enhanced_row["relative_error_pct"]
                            - base_row["relative_error_pct"]
                        ),
                    }
                )
    return pd.DataFrame(records)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="比较两融三层方案加入融资行为和权益扩展特征前后的效果",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="保存标准结果、特征增量和升级判定的目录",
    )
    parser.add_argument(
        "--skip-timesfm",
        action="store_true",
        help="仅供快速诊断；正式升级比较不得跳过 TimesFM",
    )
    return parser.parse_args()


def cli() -> None:
    args = _parse_args()
    models = _build_production_models(args.skip_timesfm)
    base_models = build_scheme_models()
    enhanced_models = build_scheme_models(
        base_features=ENHANCED_FEATURES,
        name_prefix=ENHANCED_PREFIX,
    )
    models.extend(base_models)
    models.extend(enhanced_models)
    config = PipelineConfig(
        models=tuple(model.name for model in models),
        additional_feature_groups=PRODUCTION_FEATURE_GROUPS,
    )
    result = run_pipeline(config=config, models=models)
    save_pipeline_result(result, args.output_dir)

    feature_increment = compare_feature_increment(result.metrics)
    upgrade = assess_production_upgrade(
        result.predictions,
        challenger_names=SCHEME_COMPONENTS + ENHANCED_COMPONENTS,
    )
    base_diagnostics = base_models[0].engine.diagnostics
    enhanced_diagnostics = enhanced_models[0].engine.diagnostics
    enhanced_regime, enhanced_interval = evaluate_scheme_diagnostics(
        enhanced_diagnostics
    )
    feature_increment.to_csv(args.output_dir / "feature_increment.csv", index=False)
    upgrade.to_csv(args.output_dir / "scheme_upgrade_assessment.csv", index=False)
    base_diagnostics.to_csv(args.output_dir / "base_diagnostics.csv", index=False)
    enhanced_diagnostics.to_csv(
        args.output_dir / "enhanced_diagnostics.csv", index=False
    )
    enhanced_regime.to_csv(args.output_dir / "enhanced_regime_metrics.csv", index=False)
    enhanced_interval.to_csv(
        args.output_dir / "enhanced_interval_metrics.csv", index=False
    )
    print("[RESULT] 补充特征相对原三层方案的增量", flush=True)
    print(feature_increment.to_string(index=False), flush=True)
    print("[RESULT] 生产升级判定", flush=True)
    print(upgrade.to_string(index=False), flush=True)


if __name__ == "__main__":
    cli()
