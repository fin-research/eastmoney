"""可在多个两融模型之间复用的进程内 TimesFM 路径预测引擎。"""

from __future__ import annotations

from collections.abc import Callable, Sequence

import numpy as np
import pandas as pd

TimesFMForecaster = Callable[[list[np.ndarray], int], np.ndarray]
ProgressCallback = Callable[[str], None]


class TimesFMForecastEngine:
    """一次加载 TimesFM，并按预测起点缓存未来 20 日余额路径。"""

    def __init__(
        self,
        forecaster: TimesFMForecaster | None = None,
        max_context: int = 1024,
        max_horizon: int = 20,
        batch_size: int = 64,
        per_core_batch_size: int = 32,
        progress: ProgressCallback | None = None,
    ):
        if max_context < 1 or max_horizon < 1 or batch_size < 1:
            raise ValueError("TimesFM 上下文、预测期限和外层批量必须为正数。")
        if per_core_batch_size < 1:
            raise ValueError("TimesFM per_core_batch_size 必须为正数。")
        self.forecaster = forecaster
        self.max_context = max_context
        self.max_horizon = max_horizon
        self.batch_size = batch_size
        self.per_core_batch_size = per_core_batch_size
        self.progress = progress
        self._model = None
        self._path_cache: dict[pd.Timestamp, np.ndarray] = {}
        self._origin_balance_cache: dict[pd.Timestamp, float] = {}

    def _log(self, message: str) -> None:
        if self.progress is not None:
            self.progress(message)

    def _load_model(self):
        if self._model is not None:
            return self._model

        self._log("[INFO] TimesFM: 正在当前进程加载模型权重...")
        import timesfm
        import torch

        torch.set_float32_matmul_precision("high")
        model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(
            "google/timesfm-2.5-200m-pytorch"
        )
        self._log(
            f"[INFO] TimesFM: 正在编译模型，内部批量={self.per_core_batch_size}..."
        )
        model.compile(
            timesfm.ForecastConfig(
                per_core_batch_size=self.per_core_batch_size,
                max_context=self.max_context,
                max_horizon=self.max_horizon,
                normalize_inputs=True,
                use_continuous_quantile_head=True,
                force_flip_invariance=True,
                infer_is_positive=True,
                fix_quantile_crossing=True,
            )
        )
        self._model = model
        self._log("[INFO] TimesFM: 模型加载和编译完成。")
        return self._model

    def _forecast_paths(
        self,
        contexts: list[np.ndarray],
        requested_horizon: int,
    ) -> np.ndarray:
        if self.forecaster is not None:
            return np.asarray(
                self.forecaster(contexts, self.max_horizon),
                dtype=float,
            )

        model = self._load_model()
        paths = []
        total_batches = (len(contexts) + self.batch_size - 1) // self.batch_size
        self._log(
            f"[INFO] TimesFM 路径引擎 T+{requested_horizon}: "
            f"新增 {len(contexts)} 个预测起点，统一输出未来 "
            f"{self.max_horizon} 日路径；外层批量={self.batch_size}，"
            f"模型内部批量={self.per_core_batch_size}"
        )
        for batch_number, start in enumerate(
            range(0, len(contexts), self.batch_size),
            start=1,
        ):
            batch = [
                context[-self.max_context :]
                for context in contexts[start : start + self.batch_size]
            ]
            self._log(
                f"[INFO] TimesFM 路径推理批次 {batch_number}/{total_batches}: "
                f"{len(batch)} 个预测起点"
            )
            point_forecast, _ = model.forecast(
                horizon=self.max_horizon,
                inputs=batch,
            )
            paths.append(np.asarray(point_forecast, dtype=float)[:, : self.max_horizon])
        return np.vstack(paths)

    def forecast_changes(
        self,
        history: pd.DataFrame,
        origin_dates: Sequence[pd.Timestamp],
        horizon: int,
    ) -> np.ndarray:
        """预测各起点至 T+h 的余额变化额，只读取起点当日及此前余额。"""
        if horizon < 1 or horizon > self.max_horizon:
            raise ValueError(
                f"TimesFM 期限必须在 1..{self.max_horizon}，实际为 {horizon}。"
            )
        balance = history["market_margin"].astype(float).sort_index()
        normalized_dates = [pd.Timestamp(value) for value in origin_dates]
        missing_dates = [
            origin_date
            for origin_date in normalized_dates
            if origin_date not in self._path_cache
        ]
        if missing_dates:
            contexts = []
            for origin_date in missing_dates:
                context = balance.loc[:origin_date].to_numpy(dtype=float)
                if not len(context):
                    raise ValueError(
                        f"TimesFM 缺少 {origin_date:%Y-%m-%d} 之前的余额历史。"
                    )
                contexts.append(context)
                self._origin_balance_cache[origin_date] = float(context[-1])
            paths = self._forecast_paths(contexts, horizon)
            expected_shape = (len(contexts), self.max_horizon)
            if paths.shape != expected_shape:
                raise ValueError(
                    f"TimesFM 返回 {paths.shape}，预期为 {expected_shape}。"
                )
            for origin_date, path in zip(missing_dates, paths, strict=True):
                self._path_cache[origin_date] = path

        return np.asarray(
            [
                self._path_cache[origin_date][horizon - 1]
                - self._origin_balance_cache[origin_date]
                for origin_date in normalized_dates
            ],
            dtype=float,
        )

    def forecast_segment_changes(
        self,
        history: pd.DataFrame,
        origin_dates: Sequence[pd.Timestamp],
        start: int,
        end: int,
    ) -> np.ndarray:
        """预测各起点未来 (start, end] 交易日区块的余额变化额。"""
        if start < 0 or end <= start or end > self.max_horizon:
            raise ValueError(
                "TimesFM 区块必须满足 0 <= start < end <= "
                f"{self.max_horizon}，实际为 ({start}, {end}]。"
            )
        self.forecast_changes(history, origin_dates, end)
        normalized_dates = [pd.Timestamp(value) for value in origin_dates]
        return np.asarray(
            [
                self._path_cache[origin_date][end - 1]
                - (
                    self._origin_balance_cache[origin_date]
                    if start == 0
                    else self._path_cache[origin_date][start - 1]
                )
                for origin_date in normalized_dates
            ],
            dtype=float,
        )
