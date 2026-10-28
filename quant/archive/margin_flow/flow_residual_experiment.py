"""运行资金流 A/B/C/D 消融及 T+20 目标重构实验。"""

from __future__ import annotations

import argparse
import json
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

from .contracts import ModelInput, PipelineConfig, PipelineResult
from .data import build_model_inputs, load_dataset
from .evaluate import evaluate_predictions
from .flow_residual import build_ablation_models
from .models import (
    LightGBMModel,
    MainRegressionModel,
    TimesFMModel,
    TrendPersistenceModel,
)
from .pipeline import run_pipeline, save_pipeline_result
from .timesfm_engine import TimesFMForecastEngine

INCUMBENT_BY_HORIZON = {
    1: "main_regression",
    5: "timesfm",
    20: "timesfm",
}
STATE_LABELS = ("下行", "震荡", "上行")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="TimesFM 残差 A/B/C/D 消融与 T+20 目标重构统一评估",
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
        "--output-dir",
        type=Path,
        help="可选输出目录；保存三组实验及诊断 CSV/JSON",
    )
    return parser.parse_args()


def _yearly_metrics(predictions: pd.DataFrame) -> pd.DataFrame:
    frames = []
    for (_, evaluation_year), group in predictions.groupby(
        ["evaluation_set", "evaluation_year"],
        sort=False,
    ):
        metrics = evaluate_predictions(group)
        metrics.insert(3, "evaluation_year", int(evaluation_year))
        frames.append(metrics)
    return pd.concat(frames, ignore_index=True)


def _market_state_by_date(dataset: pd.DataFrame) -> pd.Series:
    returns = dataset["market_ret_20d"].astype(float)
    state = pd.Series("震荡", index=dataset.index, dtype="object")
    state.loc[returns > 0.01] = "上行"
    state.loc[returns < -0.01] = "下行"
    state.loc[returns.isna()] = np.nan
    return state


def _state_metrics(
    predictions: pd.DataFrame,
    dataset: pd.DataFrame,
) -> pd.DataFrame:
    state = _market_state_by_date(dataset).rename("market_state")
    enriched = predictions.merge(
        state,
        left_on="origin_date",
        right_index=True,
        how="left",
        validate="many_to_one",
    ).dropna(subset=["market_state"])
    frames = []
    for market_state, group in enriched.groupby("market_state", sort=False):
        metrics = evaluate_predictions(group)
        metrics.insert(3, "market_state", market_state)
        frames.append(metrics)
    result = pd.concat(frames, ignore_index=True)
    order = pd.Categorical(
        result["market_state"],
        categories=STATE_LABELS,
        ordered=True,
    )
    return (
        result.assign(_state_order=order)
        .sort_values(["horizon", "model", "evaluation_set", "_state_order"])
        .drop(columns="_state_order")
        .reset_index(drop=True)
    )


def _acceptance_table(
    metrics: pd.DataFrame,
    yearly: pd.DataFrame,
    candidate_models: list[str],
    incumbent_by_horizon: dict[int, str],
) -> pd.DataFrame:
    records = []
    validation = metrics[metrics["evaluation_set"] == "validation"]
    yearly_validation = yearly[yearly["evaluation_set"] == "validation"]
    for candidate in candidate_models:
        candidate_metrics = validation[validation["model"] == candidate]
        for _, candidate_metric in candidate_metrics.iterrows():
            horizon = int(candidate_metric["horizon"])
            incumbent = incumbent_by_horizon[horizon]
            incumbent_metric = validation[
                (validation["model"] == incumbent) & (validation["horizon"] == horizon)
            ].iloc[0]
            candidate_years = yearly_validation[
                (yearly_validation["model"] == candidate)
                & (yearly_validation["horizon"] == horizon)
            ][["evaluation_year", "mae"]].rename(columns={"mae": "candidate_year_mae"})
            incumbent_years = yearly_validation[
                (yearly_validation["model"] == incumbent)
                & (yearly_validation["horizon"] == horizon)
            ][["evaluation_year", "mae"]].rename(columns={"mae": "incumbent_year_mae"})
            annual = candidate_years.merge(
                incumbent_years,
                on="evaluation_year",
                validate="one_to_one",
            )
            mae_improvement = 1 - float(
                candidate_metric["mae"] / incumbent_metric["mae"]
            )
            direction_change = float(
                candidate_metric["direction_accuracy"]
                - incumbent_metric["direction_accuracy"]
            )
            improved_years = int(
                (annual["candidate_year_mae"] < annual["incumbent_year_mae"]).sum()
            )
            worst_year_ratio = float(
                annual["candidate_year_mae"].max() / annual["incumbent_year_mae"].max()
            )
            enough_years = len(annual) >= 4 and improved_years >= 3
            passes = (
                mae_improvement >= 0.05
                and enough_years
                and worst_year_ratio <= 1.05
                and direction_change >= -0.02
            )
            records.append(
                {
                    "model": candidate,
                    "horizon": horizon,
                    "incumbent": incumbent,
                    "validation_mae": float(candidate_metric["mae"]),
                    "incumbent_mae": float(incumbent_metric["mae"]),
                    "mae_improvement_pct": mae_improvement * 100,
                    "improved_years": improved_years,
                    "evaluated_years": int(len(annual)),
                    "worst_year_mae_ratio": worst_year_ratio,
                    "direction_change_pp": direction_change * 100,
                    "passes_acceptance": passes,
                }
            )
    return pd.DataFrame(records).sort_values(
        ["horizon", "mae_improvement_pct"],
        ascending=[True, False],
    )


def _friday_inputs(inputs: list[ModelInput]) -> list[ModelInput]:
    weekly = []
    for item in inputs:
        train = item.train.loc[item.train.index.weekday == 4].copy()
        evaluation = item.evaluation.loc[item.evaluation.index.weekday == 4].copy()
        if train.empty or evaluation.empty:
            raise ValueError(f"T+20 {item.evaluation_year} 年缺少周五训练或评估样本。")
        weekly_input = ModelInput(
            fold=item.fold,
            evaluation_set=item.evaluation_set,
            evaluation_year=item.evaluation_year,
            horizon=item.horizon,
            train=train,
            evaluation=evaluation,
            history=item.history,
            feature_names=item.feature_names,
        )
        weekly_input.validate()
        weekly.append(weekly_input)
    return weekly


def _predict_models(
    models,
    inputs: list[ModelInput],
) -> pd.DataFrame:
    outputs = []
    for position, model in enumerate(models, start=1):
        print(
            f"\n[Experiment Model {position}/{len(models)}] {model.name}",
            flush=True,
        )
        model.progress = lambda message: print(message, flush=True)
        outputs.append(model.predict(inputs).predictions)
    return pd.concat(outputs, ignore_index=True)


def _diagnostics(
    result: PipelineResult,
    dataset: pd.DataFrame,
    candidate_models: list[str],
    incumbent_by_horizon: dict[int, str],
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    yearly = _yearly_metrics(result.predictions)
    state = _state_metrics(result.predictions, dataset)
    acceptance = _acceptance_table(
        result.metrics,
        yearly,
        candidate_models,
        incumbent_by_horizon,
    )
    return yearly, state, acceptance


def _save_experiment(
    output_dir: Path,
    name: str,
    result: PipelineResult,
    yearly: pd.DataFrame,
    state: pd.DataFrame,
    acceptance: pd.DataFrame,
) -> None:
    experiment_dir = output_dir / name
    save_pipeline_result(result, experiment_dir)
    yearly.to_csv(experiment_dir / "yearly_metrics.csv", index=False)
    state.to_csv(experiment_dir / "state_metrics.csv", index=False)
    acceptance.to_csv(experiment_dir / "acceptance.csv", index=False)


def main() -> None:
    args = _parse_args()
    config = PipelineConfig(
        initial_train_years=args.initial_train_years,
        test_year=args.test_year,
        timesfm_per_core_batch_size=args.timesfm_per_core_batch_size,
    )
    engine = TimesFMForecastEngine(
        per_core_batch_size=args.timesfm_per_core_batch_size,
    )

    direct_candidates = build_ablation_models(engine)
    direct_models = [
        TrendPersistenceModel(),
        TimesFMModel(engine=engine),
        MainRegressionModel(),
        LightGBMModel(),
        *direct_candidates,
    ]
    direct_result = run_pipeline(config=config, models=direct_models)
    dataset, data_metadata = load_dataset(config)
    direct_yearly, direct_state, direct_acceptance = _diagnostics(
        direct_result,
        dataset,
        [model.name for model in direct_candidates],
        INCUMBENT_BY_HORIZON,
    )

    t20_config = PipelineConfig(
        initial_train_years=args.initial_train_years,
        test_year=args.test_year,
        timesfm_per_core_batch_size=args.timesfm_per_core_batch_size,
        horizons=(20,),
    )
    block_candidates = build_ablation_models(
        engine,
        target_mode="t20_blocks",
        name_prefix="t20_blocks",
    )
    block_result = run_pipeline(
        config=t20_config,
        models=[TimesFMModel(engine=engine), *block_candidates],
    )
    block_yearly, block_state, block_acceptance = _diagnostics(
        block_result,
        dataset,
        [model.name for model in block_candidates],
        {20: "timesfm"},
    )

    daily_t20_inputs = build_model_inputs(dataset, t20_config)[20]
    weekly_inputs = _friday_inputs(daily_t20_inputs)
    weekly_candidates = build_ablation_models(
        engine,
        name_prefix="t20_weekly",
        cv_gap=4,
    )
    weekly_models = [TimesFMModel(engine=engine), *weekly_candidates]
    weekly_predictions = _predict_models(weekly_models, weekly_inputs)
    weekly_result = PipelineResult(
        predictions=weekly_predictions,
        metrics=evaluate_predictions(weekly_predictions),
        metadata={
            "experiment": "t20_weekly_friday",
            "weekly_origin_rule": "仅保留实际星期五预测起点",
            "ridge_cv_gap_weeks": 4,
            "evaluated_models": [model.name for model in weekly_models],
            "data": {
                "model_rows": data_metadata["model_rows"],
                "model_start": str(data_metadata["model_start"].date()),
                "model_end": str(data_metadata["model_end"].date()),
                "feature_names": data_metadata["feature_names"],
                "flow_decomposition_feature_names": data_metadata[
                    "flow_decomposition_feature_names"
                ],
                "financing_repayment_source": data_metadata[
                    "financing_repayment_source"
                ],
            },
        },
    )
    weekly_yearly, weekly_state, weekly_acceptance = _diagnostics(
        weekly_result,
        dataset,
        [model.name for model in weekly_candidates],
        {20: "timesfm"},
    )

    print("\n[RESULT] A/B/C/D 直接目标验收", flush=True)
    print(direct_acceptance.to_string(index=False), flush=True)
    print("\n[RESULT] T+20 四段目标验收", flush=True)
    print(block_acceptance.to_string(index=False), flush=True)
    print("\n[RESULT] T+20 周五样本验收", flush=True)
    print(weekly_acceptance.to_string(index=False), flush=True)

    if args.output_dir:
        args.output_dir.mkdir(parents=True, exist_ok=True)
        _save_experiment(
            args.output_dir,
            "direct_ablation",
            direct_result,
            direct_yearly,
            direct_state,
            direct_acceptance,
        )
        _save_experiment(
            args.output_dir,
            "t20_blocks",
            block_result,
            block_yearly,
            block_state,
            block_acceptance,
        )
        _save_experiment(
            args.output_dir,
            "t20_weekly",
            weekly_result,
            weekly_yearly,
            weekly_state,
            weekly_acceptance,
        )
        summary = {
            "direct_passes": int(direct_acceptance["passes_acceptance"].sum()),
            "t20_blocks_passes": int(block_acceptance["passes_acceptance"].sum()),
            "t20_weekly_passes": int(weekly_acceptance["passes_acceptance"].sum()),
            "selection_uses_2026_test": False,
            "market_state_rule": {
                "下行": "origin market_ret_20d < -1%",
                "震荡": "-1% <= origin market_ret_20d <= 1%",
                "上行": "origin market_ret_20d > 1%",
            },
        }
        (args.output_dir / "experiment_summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


if __name__ == "__main__":
    main()
