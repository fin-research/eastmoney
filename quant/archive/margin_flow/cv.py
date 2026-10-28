"""两融模型时序验证切分。"""

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .contracts import EvaluationSet


@dataclass(frozen=True)
class YearlySplit:
    """一个自然年评估窗口及其此前全部训练样本。"""

    evaluation_set: EvaluationSet
    evaluation_year: int
    train_indices: np.ndarray
    evaluation_indices: np.ndarray


class ExpandingWindowCV:
    """按自然年切分，最后单独保留指定年份作为一次性测试集。"""

    def __init__(
        self,
        test_year: int,
        initial_train_years: int = 2,
        min_train_samples: int = 120,
        min_evaluation_samples: int = 20,
    ):
        if initial_train_years < 1:
            raise ValueError("initial_train_years 必须至少为 1。")
        self.initial_train_years = initial_train_years
        self.test_year = test_year
        self.min_train_samples = min_train_samples
        self.min_evaluation_samples = min_evaluation_samples

    def split(self, dates: pd.Index | pd.Series) -> list[YearlySplit]:
        date_series = pd.Series(pd.to_datetime(dates)).reset_index(drop=True)
        years = sorted(int(year) for year in date_series.dt.year.unique())
        historical_years = [year for year in years if year < self.test_year]
        if len(historical_years) <= self.initial_train_years:
            raise ValueError(
                "测试年前的完整历史年份不足: "
                f"需要超过 {self.initial_train_years} 年，实际 {historical_years}"
            )

        splits = [
            self._build_split(date_series, "validation", year)
            for year in historical_years[self.initial_train_years :]
        ]
        splits = [split for split in splits if split is not None]
        test_split = self._build_split(date_series, "test", self.test_year)
        if test_split is None:
            raise ValueError(f"{self.test_year} 年测试样本不足。")
        splits.append(test_split)
        return splits

    def _build_split(
        self,
        dates: pd.Series,
        evaluation_set: EvaluationSet,
        evaluation_year: int,
    ) -> YearlySplit | None:
        year_start = pd.Timestamp(evaluation_year, 1, 1)
        next_year_start = pd.Timestamp(evaluation_year + 1, 1, 1)
        train_indices = np.where(dates < year_start)[0]
        evaluation_indices = np.where(
            (dates >= year_start) & (dates < next_year_start)
        )[0]
        if (
            len(train_indices) < self.min_train_samples
            or len(evaluation_indices) < self.min_evaluation_samples
        ):
            return None
        return YearlySplit(
            evaluation_set=evaluation_set,
            evaluation_year=evaluation_year,
            train_indices=train_indices,
            evaluation_indices=evaluation_indices,
        )
