"""全市场两融 pipeline 的标准数据入口。"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from data.data import DATA_FILE

from .contracts import ModelInput, PipelineConfig
from .cv import ExpandingWindowCV
from .market_data import (
    build_market_margin_daily_dataset,
    resolve_economic_feature_names,
)


def load_dataset(config: PipelineConfig) -> tuple[pd.DataFrame, dict]:
    """读取并构造全市场 T+1/T+5/T+20 日频数据集。"""
    path: str | Path = config.data_path or DATA_FILE
    dataset, metadata = build_market_margin_daily_dataset(
        path=path,
        model_start=config.model_start,
        additional_feature_groups=config.additional_feature_groups,
    )
    return dataset, metadata


def build_model_inputs(
    dataset: pd.DataFrame,
    config: PipelineConfig,
) -> dict[int, list[ModelInput]]:
    """构造按年 expanding 验证和当年一次性测试输入。"""
    result: dict[int, list[ModelInput]] = {}
    feature_names = resolve_economic_feature_names(config.additional_feature_groups)
    for horizon in config.horizons:
        target_pct = f"target_pct_t{horizon}"
        target_date = f"target_date_t{horizon}"
        frame = dataset.dropna(subset=[target_pct, target_date]).sort_index()
        cv = ExpandingWindowCV(
            initial_train_years=config.initial_train_years,
            test_year=config.test_year,
            min_train_samples=300,
            min_evaluation_samples=20,
        )
        splits = cv.split(frame.index)
        if not splits:
            raise ValueError(f"T+{horizon} 数据不足以构造年度 expanding window。")

        horizon_inputs = []
        for fold, split in enumerate(splits, start=1):
            evaluation = frame.iloc[split.evaluation_indices].copy()
            train = frame.iloc[split.train_indices]
            train = train[train[target_date] < evaluation.index.min()].copy()
            history = dataset.loc[: evaluation.index.max()].sort_index().copy()
            model_input = ModelInput(
                fold=fold,
                evaluation_set=split.evaluation_set,
                evaluation_year=split.evaluation_year,
                horizon=horizon,
                train=train,
                evaluation=evaluation,
                history=history,
                feature_names=feature_names,
            )
            model_input.validate()
            horizon_inputs.append(model_input)
        validation_inputs = [
            item for item in horizon_inputs if item.evaluation_set == "validation"
        ]
        test_inputs = [item for item in horizon_inputs if item.evaluation_set == "test"]
        if not validation_inputs or len(test_inputs) != 1:
            raise ValueError(
                f"T+{horizon} 必须包含至少一个年度验证窗口和一个最终测试集。"
            )
        result[horizon] = horizon_inputs
    return result
