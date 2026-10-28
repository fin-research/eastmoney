"""全市场两融模型的统一输入、输出与 pipeline 契约。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Literal

import pandas as pd

EvaluationSet = Literal["validation", "test"]

PRODUCTION_FEATURE_GROUPS = ("margin_equity", "margin_behavior")

MODEL_OUTPUT_COLUMNS = (
    "model",
    "input_scope",
    "fold",
    "evaluation_set",
    "evaluation_year",
    "horizon",
    "origin_date",
    "target_date",
    "origin_balance",
    "actual_change",
    "predicted_change",
)


@dataclass(frozen=True)
class ModelInput:
    """单个期限、单个年度 expanding-window split 的标准模型输入。"""

    fold: int
    evaluation_set: EvaluationSet
    evaluation_year: int
    horizon: int
    train: pd.DataFrame
    evaluation: pd.DataFrame
    history: pd.DataFrame
    feature_names: tuple[str, ...]

    @property
    def target_pct_column(self) -> str:
        return f"target_pct_t{self.horizon}"

    @property
    def target_amount_column(self) -> str:
        return f"target_amount_t{self.horizon}"

    @property
    def target_date_column(self) -> str:
        return f"target_date_t{self.horizon}"

    def validate(self) -> None:
        required = {
            "market_margin",
            self.target_pct_column,
            self.target_amount_column,
            self.target_date_column,
        }
        missing_train = required - set(self.train.columns)
        missing_evaluation = required - set(self.evaluation.columns)
        missing_features = set(self.feature_names) - set(self.train.columns)
        if missing_train or missing_evaluation or missing_features:
            raise ValueError(
                "模型输入缺少字段: "
                f"train={sorted(missing_train)}, "
                f"evaluation={sorted(missing_evaluation)}, "
                f"features={sorted(missing_features)}"
            )
        if self.train.empty or self.evaluation.empty:
            raise ValueError("模型训练集和评估集均不能为空。")
        if self.evaluation_set not in {"validation", "test"}:
            raise ValueError(f"未知评估集类型: {self.evaluation_set}")
        evaluation_years = set(self.evaluation.index.year)
        if evaluation_years != {self.evaluation_year}:
            raise ValueError(
                "评估样本必须全部属于 evaluation_year: "
                f"expected={self.evaluation_year}, actual={sorted(evaluation_years)}"
            )
        if self.train[self.target_date_column].max() >= self.evaluation.index.min():
            raise ValueError("训练标签终点必须严格早于评估集起点。")
        if not self.history.index.is_monotonic_increasing:
            raise ValueError("历史余额序列必须按日期升序排列。")


@dataclass(frozen=True)
class ModelOutput:
    """所有模型共用的逐样本预测输出。"""

    predictions: pd.DataFrame

    def __post_init__(self) -> None:
        actual = tuple(self.predictions.columns)
        if actual != MODEL_OUTPUT_COLUMNS:
            raise ValueError(
                "模型输出字段不符合统一契约: "
                f"expected={MODEL_OUTPUT_COLUMNS}, actual={actual}"
            )


@dataclass(frozen=True)
class PipelineConfig:
    """全市场两融评估 pipeline 的运行参数。"""

    data_path: Path | None = None
    model_start: str = "2019-01-01"
    horizons: tuple[int, ...] = (1, 5, 20)
    initial_train_years: int = 2
    test_year: int = field(default_factory=lambda: date.today().year)
    timesfm_per_core_batch_size: int = 32
    additional_feature_groups: tuple[str, ...] = PRODUCTION_FEATURE_GROUPS
    models: tuple[str, ...] = (
        "trend_persistence",
        "timesfm",
        "main_regression",
        "lightgbm",
        "three_layer",
    )


@dataclass(frozen=True)
class PipelineResult:
    """数据、样本外预测和标准化评估的统一 pipeline 输出。"""

    predictions: pd.DataFrame
    metrics: pd.DataFrame
    metadata: dict[str, Any] = field(default_factory=dict)
    three_layer_coefficients: pd.DataFrame = field(default_factory=pd.DataFrame)
