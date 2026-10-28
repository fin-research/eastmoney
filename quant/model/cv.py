"""
交叉验证与评估：扩展窗口时序 CV、基线/LightGBM 训练包装、业务价值评估。
"""

import numpy as np
import pandas as pd
import shap
from sklearn.linear_model import Lasso
from sklearn.metrics import mean_squared_error
from sklearn.preprocessing import StandardScaler

from .train import LGB_PARAMS, train_lgb
from .scoring import shap_top_drivers


class TimeSeriesCV:
    """扩展窗口时序交叉验证（至少保留 24 个月做初始训练集）。"""

    def __init__(self, n_splits: int = 10, val_months: int = 6):
        self.n_splits = n_splits
        self.val_months = val_months

    def split(self, dates: pd.Series) -> list[tuple[np.ndarray, np.ndarray]]:
        """返回 [(train_idx, val_idx), ...] 列表。"""
        sorted_dates = dates.sort_values()
        min_date = sorted_dates.min()
        max_date = sorted_dates.max()

        splits = []
        for i in range(self.n_splits):
            val_start = min_date + pd.DateOffset(months=24 + i * self.val_months)
            val_end = val_start + pd.DateOffset(months=self.val_months)
            if val_end > max_date:
                break

            train_idx = np.where(dates < val_start)[0]
            val_idx = np.where((dates >= val_start) & (dates < val_end))[0]
            if len(train_idx) == 0 or len(val_idx) == 0:
                continue

            splits.append((train_idx, val_idx))
            print(
                f"  Fold {len(splits)}: "
                f"Train [{dates.iloc[train_idx].min().strftime('%Y-%m')} ~ "
                f"{dates.iloc[train_idx].max().strftime('%Y-%m')}] ({len(train_idx)}), "
                f"Val [{val_start.strftime('%Y-%m')} ~ "
                f"{val_end.strftime('%Y-%m')}] ({len(val_idx)})"
            )
        return splits


class BondTimingModel:
    """债券融资择时模型：封装基线训练、LightGBM 训练和业务价值评估。"""

    def __init__(self, feature_names: list[str]):
        self.feature_names = feature_names
        self.models: dict = {}

    def train_baseline(
        self, X_train, y_train, X_val, y_val, verbose: bool = True
    ) -> dict:
        """Lasso 基线（alpha=0.01/0.1/1.0），返回各模型的 RMSE/IC/特征数。"""
        scaler = StandardScaler()
        X_tr = scaler.fit_transform(X_train)
        X_va = scaler.transform(X_val)

        results = {}
        for alpha in [0.01, 0.1, 1.0]:
            m = Lasso(alpha=alpha, max_iter=10000)
            m.fit(X_tr, y_train)
            pred = m.predict(X_va)
            results[f"Lasso_a{alpha}"] = {
                "rmse": float(np.sqrt(mean_squared_error(y_val, pred))),
                "ic": float(np.corrcoef(pred, y_val)[0, 1]) if len(y_val) > 2 else 0.0,
                "n_features": int(np.sum(np.abs(m.coef_) > 1e-6)),
            }

        if verbose:
            print("\n[基线模型结果]")
            for name, res in results.items():
                print(
                    f"  {name}: RMSE={res['rmse']:.3f}, IC={res['ic']:.3f}, Selected Features={res['n_features']}"
                )
        return results

    def train_lightgbm(
        self, X_train, y_train, X_val, y_val, verbose: bool = True
    ) -> tuple:
        """LightGBM（含 early stopping），返回 (model, val_preds, metrics)。"""
        model, _, _ = train_lgb(
            X_train,
            y_train,
            self.feature_names,
            X_val,
            y_val,
        )
        pred = model.predict(X_val)
        rmse = float(np.sqrt(np.mean((pred - y_val) ** 2)))
        ic = float(np.corrcoef(pred, y_val)[0, 1]) if len(y_val) > 2 else 0.0
        best_iter = (
            model.best_iteration_
            if hasattr(model, "best_iteration_") and model.best_iteration_
            else LGB_PARAMS["n_estimators"]
        )
        if verbose:
            print(
                f"\n[LightGBM 结果] RMSE={rmse:.3f}, IC={ic:.3f}, best_iter={best_iter}"
            )
        self.models["lightgbm"] = model
        return model, pred, {"rmse": rmse, "ic": ic, "best_iter": best_iter}

    def explain_prediction(
        self, X: pd.DataFrame, model=None, verbose: bool = True
    ) -> np.ndarray:
        """用 SHAP 解释预测，返回 shap_values 矩阵（shape: n_samples × n_features）。"""
        model = model or self.models.get("lightgbm")
        explainer = shap.TreeExplainer(model)
        shap_values = explainer.shap_values(X)
        if verbose:
            top = shap_top_drivers(model, X.values[0], list(X.columns), top_n=5)
            print("\n[SHAP 解释] 样本 0 的 Top-5 驱动因子:")
            for d in top:
                direction = "↑推高成本" if d["shap"] > 0 else "↓降低成本"
                print(
                    f"  {d['feature']:30s}: SHAP={d['shap']:+.3f} ({direction}), 值={d['value']:.4f}"
                )
        return shap_values

    @staticmethod
    def evaluate_timing_value(
        predictions: np.ndarray,
        actuals: np.ndarray,
        top_pct: float = 0.25,
    ) -> dict:
        """评估择时模型业务价值：成本节约、胜率、IC、分组单调性。"""
        threshold = np.percentile(predictions, top_pct * 100)
        recommended = actuals[predictions <= threshold]
        cost_saving = actuals.mean() - recommended.mean()

        n_groups = 5
        group_means = []
        for q in range(n_groups):
            lo = np.percentile(predictions, q * 100 / n_groups)
            hi = np.percentile(predictions, (q + 1) * 100 / n_groups)
            mask = (predictions >= lo) & (predictions <= hi)
            if mask.sum() > 0:
                group_means.append(actuals[mask].mean())

        return {
            "cost_saving_bp": cost_saving,
            "recommended_mean_bp": recommended.mean(),
            "baseline_mean_bp": actuals.mean(),
            "win_rate": float((recommended < 0).mean())
            if len(recommended) > 0
            else 0.0,
            "ic": float(np.corrcoef(predictions, actuals)[0, 1])
            if len(predictions) > 2
            else 0.0,
            "group_means": group_means,
            "monotonic": all(
                group_means[i] <= group_means[i + 1]
                for i in range(len(group_means) - 1)
            ),
            "n_recommended": len(recommended),
            "n_total": len(predictions),
        }
