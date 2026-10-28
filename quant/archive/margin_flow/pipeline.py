"""全市场两融的标准 data -> model -> evaluation pipeline。"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

import pandas as pd
from rich import box
from rich.console import Console
from rich.table import Table

from .contracts import ModelInput, PipelineConfig, PipelineResult
from .data import build_model_inputs, load_dataset
from .evaluate import evaluate_predictions
from .market_data import FEATURE_LABELS
from .models import ForecastModel, MainRegressionModel, ThreeLayerModel, build_models

MODEL_DISPLAY_NAMES = {
    "trend_persistence": "趋势延续（baseline）",
    "timesfm": "TimesFM",
    "main_regression": "主回归（Ridge）",
    "lightgbm": "LightGBM",
    "three_layer": "三层组合",
    "timesfm_ridge_residual": "TimesFM + Ridge 残差",
    "timesfm_lightgbm_residual": "TimesFM + LightGBM 残差",
}


def _json_value(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    return value


class PipelineProgress:
    """集中管理实时输出，保持主 pipeline 只负责编排。"""

    def __init__(self, verbose: bool):
        self.verbose = verbose
        self.console = Console(
            color_system=None,
            force_terminal=False,
            soft_wrap=True,
            width=120,
        )

    def __call__(self, message: str) -> None:
        if self.verbose:
            print(message, flush=True)

    def table(self, value: Table) -> None:
        if self.verbose:
            self.console.print(value)


def _metric_text(metrics: pd.Series) -> str:
    return (
        f"方向={metrics['direction_accuracy']:.2%}, "
        f"MAE={metrics['mae']:.2f}亿元, "
        f"相对误差={metrics['relative_error_pct']:.2f}%"
    )


def _prepare_model_inputs(
    config: PipelineConfig,
    progress: PipelineProgress,
) -> tuple[dict, dict[int, list[ModelInput]]]:
    progress("全市场两融余额预测 —— 标准化模型评估 Pipeline")
    progress("\n[Step 1] 数据读取与特征构建...")
    dataset, data_metadata = load_dataset(config)
    progress(
        f"[INFO] 模型数据: {len(dataset)} 行，"
        f"{dataset.index.min():%Y-%m-%d} 至 {dataset.index.max():%Y-%m-%d}，"
        f"{len(data_metadata['feature_names'])} 个特征"
    )

    progress("\n[Step 2] 年度 Expanding Window 输入构建...")
    inputs_by_horizon = build_model_inputs(dataset, config)
    for horizon, inputs in inputs_by_horizon.items():
        validation_inputs = [
            item for item in inputs if item.evaluation_set == "validation"
        ]
        test_input = next(item for item in inputs if item.evaluation_set == "test")
        progress(
            f"[INFO] T+{horizon}: "
            f"Expanding Window，{len(validation_inputs)} 个年度验证窗口 "
            f"({validation_inputs[0].evaluation_year}-"
            f"{validation_inputs[-1].evaluation_year})，"
            f"{sum(len(item.evaluation) for item in validation_inputs)} 个验证点；"
            f"{test_input.evaluation_year} 年最终测试 "
            f"{len(test_input.evaluation)} 个点"
        )
        for model_input in inputs:
            evaluation_name = (
                "最终测试" if model_input.evaluation_set == "test" else "验证"
            )
            progress(
                f"[INFO] T+{horizon} {model_input.evaluation_year}年{evaluation_name}: "
                f"训练 {len(model_input.train)} 个样本，"
                f"评估 {len(model_input.evaluation)} 个样本"
            )
    return data_metadata, inputs_by_horizon


def _select_models(
    config: PipelineConfig,
    models: list[ForecastModel] | None,
    progress: PipelineProgress,
) -> list[ForecastModel]:
    selected = models or build_models(
        config.models,
        progress=progress,
        timesfm_per_core_batch_size=config.timesfm_per_core_batch_size,
    )
    for model in selected:
        model.progress = progress
    return selected


def _run_model_predictions(
    config: PipelineConfig,
    models: list[ForecastModel],
    inputs_by_horizon: dict[int, list[ModelInput]],
    progress: PipelineProgress,
) -> pd.DataFrame:
    progress("\n[Step 3] 模型训练与样本外预测...")
    outputs = []
    total_runs = len(models) * len(config.horizons)
    run_number = 0
    for model_position, model in enumerate(models, start=1):
        for horizon in config.horizons:
            run_number += 1
            progress(
                f"\n[Model {model_position}/{len(models)}] "
                f"{model.name} T+{horizon} "
                f"（任务 {run_number}/{total_runs}）"
            )
            output = model.predict(inputs_by_horizon[horizon]).predictions
            outputs.append(output)
            current_metrics = evaluate_predictions(output)
            for _, metric in current_metrics.iterrows():
                evaluation_name = (
                    f"{config.test_year}年最终测试"
                    if metric["evaluation_set"] == "test"
                    else "历史年度验证"
                )
                progress(
                    f"[RESULT] {model.name} T+{horizon} {evaluation_name}: "
                    f"{_metric_text(metric)}"
                )
    return pd.concat(outputs, ignore_index=True)


def _format_metric(value: float, kind: str) -> str:
    if pd.isna(value):
        return "—"
    if kind == "direction":
        return f"{value:.1%}"
    if kind == "mae":
        return f"{value:.2f}"
    return f"{value:.2f}%"


def _main_regression_summary(
    model: MainRegressionModel,
    top_n: int = 5,
) -> pd.DataFrame:
    history = model.coefficient_history
    if history.empty:
        return pd.DataFrame()

    records = []
    for horizon in sorted(history["horizon"].unique()):
        horizon_history = history[history["horizon"] == horizon]
        validation = horizon_history[horizon_history["evaluation_set"] == "validation"]
        current = horizon_history[horizon_history["evaluation_set"] == "test"]
        if current.empty:
            continue
        current_year = int(current["evaluation_year"].max())
        current = current[current["evaluation_year"] == current_year]
        current = current.assign(
            absolute_coefficient=current["coefficient_bps_per_1sd"].abs()
        ).nlargest(top_n, "absolute_coefficient")
        for _, row in current.iterrows():
            feature = row["feature"]
            current_coefficient = float(row["coefficient_bps_per_1sd"])
            feature_validation = validation[validation["feature"] == feature]
            validation_coefficients = feature_validation["coefficient_bps_per_1sd"]
            current_sign = (
                0.0
                if current_coefficient == 0
                else 1.0
                if current_coefficient > 0
                else -1.0
            )
            if validation_coefficients.empty:
                validation_median = float("nan")
                same_sign_rate = float("nan")
            else:
                validation_median = float(validation_coefficients.median())
                validation_signs = validation_coefficients.apply(
                    lambda value: 0.0 if value == 0 else 1.0 if value > 0 else -1.0
                )
                same_sign_rate = float((validation_signs == current_sign).mean())
            records.append(
                {
                    "horizon": int(horizon),
                    "feature": feature,
                    "label": FEATURE_LABELS.get(feature, feature),
                    "current_coefficient_bps_per_1sd": current_coefficient,
                    "validation_median_bps_per_1sd": validation_median,
                    "validation_same_sign_rate": same_sign_rate,
                    "current_alpha": float(row["alpha"]),
                    "current_training_cutoff_year": current_year - 1,
                }
            )
    return pd.DataFrame(records)


def _coefficient_text(value: float) -> str:
    if pd.isna(value):
        return "—"
    return f"{value:+.2f}"


def _main_regression_table(summary: pd.DataFrame, horizon: int) -> Table:
    selected = summary[summary["horizon"] == horizon]
    table = Table(
        title=f"主回归主要影响因子 · T+{horizon}",
        box=box.ROUNDED,
        expand=False,
        show_lines=False,
    )
    table.add_column("影响因子", justify="left", no_wrap=True)
    table.add_column("当前系数（bp/1SD）", justify="right")
    table.add_column("验证折中位数", justify="right")
    table.add_column("与当前同号率", justify="right")
    for _, row in selected.iterrows():
        same_sign_rate = row["validation_same_sign_rate"]
        table.add_row(
            row["label"],
            _coefficient_text(row["current_coefficient_bps_per_1sd"]),
            _coefficient_text(row["validation_median_bps_per_1sd"]),
            "—" if pd.isna(same_sign_rate) else f"{same_sign_rate:.0%}",
        )
    return table


def _print_main_regression_findings(
    models: list[ForecastModel],
    progress: PipelineProgress,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    progress("\n[Step 4] 主回归主要影响因子与标准化系数...")
    main_model = next(
        (model for model in models if isinstance(model, MainRegressionModel)),
        None,
    )
    if main_model is None:
        progress("[INFO] 本次未运行 main_regression，跳过影响因子汇报。")
        return pd.DataFrame(), pd.DataFrame()

    history = main_model.coefficient_history
    summary = _main_regression_summary(main_model)
    if summary.empty:
        progress("[INFO] 主回归没有可汇报的最终测试模型系数。")
        return history, summary

    progress(
        "[INFO] 当前系数来自最终测试模型，只使用测试年前样本拟合；"
        "单位为目标余额变化率 bp / 因子增加 1 个训练样本标准差。"
    )
    progress(
        "[INFO] 系数反映控制其他变量后的联合预测关联，不代表因果效应；"
        "同号率用于观察历史年度验证折中的方向稳定性。"
    )
    for horizon in sorted(summary["horizon"].unique()):
        progress.table(_main_regression_table(summary, int(horizon)))
    return history, summary


def _significance_stars(p_value: float) -> str:
    if pd.isna(p_value):
        return ""
    if p_value < 0.01:
        return "***"
    if p_value < 0.05:
        return "**"
    if p_value < 0.1:
        return "*"
    return ""


DIRECTION_CLASS_DISPLAY = {
    "1": "上涨（up）",
    "0": "平稳（flat）",
}


def _three_layer_coefficient_summary(
    engine: Any,
    top_n: int = 8,
) -> pd.DataFrame:
    """三层模型方向层（多元逻辑回归）最终测试模型的系数与显著性。"""
    history = engine.coefficient_history
    if history.empty:
        return pd.DataFrame()
    records = []
    for horizon in sorted(history["horizon"].unique()):
        horizon_history = history[history["horizon"] == horizon]
        current = horizon_history[horizon_history["evaluation_set"] == "test"]
        if current.empty:
            continue
        current_year = int(current["evaluation_year"].max())
        current = current[current["evaluation_year"] == current_year]
        for direction_class in sorted(current["direction_class"].unique()):
            class_frame = current[current["direction_class"] == direction_class]
            selected = class_frame.assign(
                absolute_coefficient=class_frame["standardized_coefficient"].abs()
            ).nlargest(top_n, "absolute_coefficient")
            for _, row in selected.iterrows():
                records.append(
                    {
                        "horizon": int(horizon),
                        "direction_class": direction_class,
                        "direction_name": DIRECTION_CLASS_DISPLAY.get(
                            direction_class, direction_class
                        ),
                        "feature": row["feature"],
                        "label": row["label"],
                        "standardized_coefficient": float(
                            row["standardized_coefficient"]
                        ),
                        "std_error": float(row["std_error"]),
                        "z_statistic": float(row["z_statistic"]),
                        "p_value": float(row["p_value"]),
                        "significance": _significance_stars(float(row["p_value"])),
                        "training_cutoff_year": current_year - 1,
                    }
                )
    return pd.DataFrame(records)


def _three_layer_coefficient_table(summary: pd.DataFrame, horizon: int) -> Table:
    selected = summary[summary["horizon"] == horizon]
    table = Table(
        title=f"三层模型方向层主要解释变量 · T+{horizon}（最终测试模型）",
        box=box.ROUNDED,
        expand=False,
        show_lines=False,
    )
    table.add_column("方向", justify="left", no_wrap=True)
    table.add_column("解释变量", justify="left")
    table.add_column("标准化系数", justify="right")
    table.add_column("标准误", justify="right")
    table.add_column("z 值", justify="right")
    table.add_column("p 值", justify="right")
    table.add_column("显著性", justify="left")
    for _, row in selected.iterrows():
        table.add_row(
            row["direction_name"],
            row["label"],
            _coefficient_text(row["standardized_coefficient"]),
            _coefficient_text(row["std_error"]),
            _coefficient_text(row["z_statistic"]),
            "—" if pd.isna(row["p_value"]) else f"{row['p_value']:.4f}",
            row["significance"],
        )
    return table


def _print_three_layer_findings(
    models: list[ForecastModel],
    progress: PipelineProgress,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    progress("\n[Step 4b] 三层模型方向层解释变量与显著性...")
    model = next(
        (item for item in models if isinstance(item, ThreeLayerModel)),
        None,
    )
    if model is None:
        progress("[INFO] 本次未运行 three_layer，跳过方向层系数汇报。")
        return pd.DataFrame(), pd.DataFrame()

    history = model.engine.coefficient_history
    summary = _three_layer_coefficient_summary(model.engine)
    if summary.empty:
        progress("[INFO] 三层模型没有可汇报的最终测试方向层系数。")
        return history, summary

    progress(
        "[INFO] 系数来自方向层多元逻辑回归（以\"下跌\"为基准类）的最终测试模型，"
        "只使用测试年前样本拟合；标准化系数为因子增加 1 个训练样本标准差对应的"
        "log-odds 变化。"
    )
    progress(
        "[INFO] p 值来自 Wald 检验（Fisher 信息逆估计标准误）；"
        "显著性：*** p<0.01，** p<0.05，* p<0.1。"
    )
    for horizon in sorted(summary["horizon"].unique()):
        progress.table(_three_layer_coefficient_table(summary, int(horizon)))
    return history, summary


def _comparison_table(
    metrics: pd.DataFrame,
    horizon: int,
    model_order: list[str],
    evaluation_set: str,
    test_year: int,
) -> Table:
    horizon_metrics = metrics[metrics["horizon"] == horizon]
    evaluation_metrics = horizon_metrics[
        horizon_metrics["evaluation_set"] == evaluation_set
    ]
    if evaluation_metrics.empty:
        raise ValueError(f"T+{horizon} 缺少 {evaluation_set} 指标。")

    dataset_name = (
        "验证集" if evaluation_set == "validation" else f"{test_year}年测试集"
    )
    table = Table(
        title=f"{dataset_name} · T+{horizon}",
        box=box.ROUNDED,
        expand=False,
        show_lines=False,
    )
    table.add_column("模型", justify="left", no_wrap=True)
    table.add_column("方向准确率", justify="right")
    table.add_column("MAE（亿元）", justify="right")
    table.add_column("相对误差", justify="right")
    table.add_column("样本数", justify="right")

    for model in model_order:
        model_metrics = evaluation_metrics[evaluation_metrics["model"] == model]
        if model_metrics.empty:
            raise ValueError(f"{model} T+{horizon} 缺少 {evaluation_set} 指标。")
        metric = model_metrics.iloc[0]
        table.add_row(
            MODEL_DISPLAY_NAMES.get(model, model),
            _format_metric(metric["direction_accuracy"], "direction"),
            _format_metric(metric["mae"], "mae"),
            _format_metric(metric["relative_error_pct"], "relative"),
            str(int(metric["samples"])),
        )
    return table


def _evaluate_and_print(
    predictions: pd.DataFrame,
    config: PipelineConfig,
    model_order: list[str],
    progress: PipelineProgress,
) -> pd.DataFrame:
    progress("\n[Step 5] 全模型统一评估...")
    metrics = evaluate_predictions(predictions)
    progress("\n验证集效果汇总")
    for horizon in config.horizons:
        progress.table(
            _comparison_table(
                metrics, horizon, model_order, "validation", config.test_year
            )
        )
    progress("\n测试集效果汇总")
    for horizon in config.horizons:
        progress.table(
            _comparison_table(metrics, horizon, model_order, "test", config.test_year)
        )
    return metrics


def run_pipeline(
    config: PipelineConfig | None = None,
    models: list[ForecastModel] | None = None,
    verbose: bool = True,
) -> PipelineResult:
    """运行全市场数据、多模型 walk-forward 和统一评估，不生成报告。"""
    config = config or PipelineConfig()
    progress = PipelineProgress(verbose)
    data_metadata, inputs_by_horizon = _prepare_model_inputs(config, progress)
    selected_models = _select_models(config, models, progress)
    predictions = _run_model_predictions(
        config,
        selected_models,
        inputs_by_horizon,
        progress,
    )
    model_order = [model.name for model in selected_models]
    coefficient_history, coefficient_summary = _print_main_regression_findings(
        selected_models,
        progress,
    )
    (
        three_layer_coefficient_history,
        three_layer_coefficient_summary,
    ) = _print_three_layer_findings(selected_models, progress)
    metrics = _evaluate_and_print(predictions, config, model_order, progress)

    metadata = {
        "config": _json_value(asdict(config)),
        "evaluated_models": model_order,
        "data": _json_value(data_metadata),
        "splits": {
            str(horizon): {
                "validation_years": [
                    item.evaluation_year
                    for item in inputs
                    if item.evaluation_set == "validation"
                ],
                "test_year": next(
                    item.evaluation_year
                    for item in inputs
                    if item.evaluation_set == "test"
                ),
            }
            for horizon, inputs in inputs_by_horizon.items()
        },
        "main_regression": {
            "coefficient_unit": "target_change_rate_bps_per_1_train_sd",
            "interpretation": "predictive_association_not_causal_effect",
            "history": _json_value(coefficient_history.to_dict(orient="records")),
            "top_factors": _json_value(coefficient_summary.to_dict(orient="records")),
        },
        "three_layer": {
            "direction_layer": "multinomial_logistic_regression_down_baseline",
            "coefficient_unit": "log_odds_per_1_train_sd",
            "p_value_method": "wald_test_fisher_information",
            "significance": "*** p<0.01, ** p<0.05, * p<0.1",
            "history": _json_value(
                three_layer_coefficient_history.to_dict(orient="records")
            ),
            "top_factors": _json_value(
                three_layer_coefficient_summary.to_dict(orient="records")
            ),
        },
    }
    progress("\n[完成] 全市场两融 Pipeline 运行结束。")
    return PipelineResult(
        predictions=predictions,
        metrics=metrics,
        metadata=metadata,
        three_layer_coefficients=three_layer_coefficient_history,
    )


def save_pipeline_result(
    result: PipelineResult,
    output_dir: str | Path,
    verbose: bool = True,
) -> None:
    """保存结构化预测和评估文件，不生成 Markdown、图表或业务报告。"""
    path = Path(output_dir)
    path.mkdir(parents=True, exist_ok=True)
    result.predictions.to_csv(path / "predictions.csv", index=False)
    result.metrics.to_csv(path / "metrics.csv", index=False)
    if not result.three_layer_coefficients.empty:
        result.three_layer_coefficients.to_csv(
            path / "three_layer_coefficients.csv", index=False
        )
    (path / "metadata.json").write_text(
        json.dumps(result.metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if verbose:
        PipelineProgress(verbose)(
            f"[INFO] 结果已保存至 {path.resolve()}: "
            "predictions.csv, metrics.csv, metadata.json"
            + (
                ", three_layer_coefficients.csv"
                if not result.three_layer_coefficients.empty
                else ""
            )
        )
