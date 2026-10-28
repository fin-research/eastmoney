"""
模型训练：LightGBM 基础训练、月度滚动模型、市场择时模型（P1 / P2）。

关键私有辅助：
  _prepare_daily_data — 两个市场模型共用的数据聚合+合并逻辑
  _es_refit           — early stopping 确定轮数后全量 refit 的标准流程
"""

import lightgbm as lgb
import numpy as np
import pandas as pd

from .features import split_feature_names
from .scoring import tenor_bucket

LGB_PARAMS: dict = {
    "objective": "regression",
    "metric": "rmse",
    "learning_rate": 0.05,
    "num_leaves": 31,
    "max_depth": 6,
    "min_child_samples": 20,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "reg_alpha": 0.1,
    "reg_lambda": 1.0,
    "n_estimators": 500,
    "verbose": -1,
}

ISSUE_MODEL_MIN_N_ESTIMATORS = 50

# ── 基础训练 ────────────────────────────────────────────────────────────────


def _resolve_issue_n_estimators(n_estimators: "int | None") -> "int | None":
    if n_estimators is None:
        return None
    return max(int(n_estimators), ISSUE_MODEL_MIN_N_ESTIMATORS)


def train_lgb(
    X_train: np.ndarray,
    y_train: np.ndarray,
    feature_names: list[str],
    X_val: "np.ndarray | None" = None,
    y_val: "np.ndarray | None" = None,
    threshold_pct: float = 25,
) -> tuple:
    """训练 LightGBM，可选 early stopping。返回 (model, train_med, threshold)。"""
    model = lgb.LGBMRegressor(**LGB_PARAMS)
    if X_val is not None and y_val is not None:
        model.fit(
            X_train,
            y_train,
            eval_set=[(X_val, y_val)],
            callbacks=[lgb.early_stopping(50, verbose=False)],
        )
    else:
        model.fit(X_train, y_train)

    train_preds = model.predict(X_train)
    threshold = float(np.percentile(train_preds, threshold_pct))
    train_med = pd.Series(np.nanmedian(X_train, axis=0), index=feature_names)
    return model, train_med, threshold


def compute_group_thresholds(
    model: lgb.LGBMRegressor,
    train_df: pd.DataFrame,
    feature_names: list[str],
    top_pct: float = 0.25,
) -> dict:
    """按 (bond_type, tenor_bucket) 分组计算推荐阈值。"""
    preds = model.predict(train_df[feature_names].values)
    df = train_df[["bond_type", "tenor"]].copy()
    df["_pred"] = preds
    df["_tb"] = df["tenor"].apply(tenor_bucket)

    return {
        (bt, tb): float(np.percentile(group["_pred"], top_pct * 100))
        for (bt, tb), group in df.groupby(["bond_type", "_tb"])
        if len(group) >= 10
    }


def train_issue_model(
    dataset: pd.DataFrame,
    feature_names: list[str],
    n_estimators: "int | None" = None,
) -> dict:
    """
    全量训练逐笔债券模型，返回全局/分组预测分布与阈值。

    用于当前和未来发行建议的统一口径：同一套逐笔标签、逐笔特征、
    历史预测分布和分组阈值。
    """
    train_df = dataset.dropna(subset=["y_regression"]).copy()
    effective_n_estimators = _resolve_issue_n_estimators(n_estimators)
    params = (
        {**LGB_PARAMS}
        if effective_n_estimators is None
        else {**LGB_PARAMS, "n_estimators": effective_n_estimators}
    )
    model = lgb.LGBMRegressor(**params)
    X_all = train_df[feature_names].values
    y_all = train_df["y_regression"].values
    model.fit(X_all, y_all)

    train_preds = model.predict(X_all)
    train_df["_pred"] = train_preds
    train_df["_tb"] = train_df["tenor"].apply(tenor_bucket)

    group_stats = {}
    for key, group in train_df.groupby(["bond_type", "_tb"]):
        preds = group["_pred"].values.astype(float)
        if len(preds) < 10:
            continue
        group_stats[key] = {
            "preds": preds,
            "n": int(len(preds)),
            "p25": float(np.percentile(preds, 25)),
            "p50": float(np.percentile(preds, 50)),
            "mean": float(np.mean(preds)),
        }

    feature_ranges = {
        fname: {
            "p01": float(np.percentile(X_all[:, j], 1)),
            "p99": float(np.percentile(X_all[:, j], 99)),
            "p05": float(np.percentile(X_all[:, j], 5)),
            "p95": float(np.percentile(X_all[:, j], 95)),
            "median": float(np.nanmedian(X_all[:, j])),
        }
        for j, fname in enumerate(feature_names)
    }

    return {
        "model": model,
        "train_med": pd.Series(np.nanmedian(X_all, axis=0), index=feature_names),
        "train_preds": train_preds,
        "threshold_p25": float(np.percentile(train_preds, 25)),
        "threshold_p50": float(np.percentile(train_preds, 50)),
        "train_mean": float(np.mean(train_preds)),
        "group_thresholds_p25": {k: v["p25"] for k, v in group_stats.items()},
        "group_thresholds_p50": {k: v["p50"] for k, v in group_stats.items()},
        "group_stats": group_stats,
        "feature_ranges": feature_ranges,
        "n_train": int(len(train_df)),
        "n_estimators": int(params["n_estimators"]),
    }


# ── Direct-horizon 逐笔模型 ────────────────────────────────────────────────


def _latest_asof_positions(
    index: pd.DatetimeIndex,
    dates: "pd.Series | pd.DatetimeIndex",
) -> np.ndarray:
    return index.searchsorted(pd.to_datetime(dates), side="left") - 1


def _recompute_horizon_peer_features(
    frame: pd.DataFrame,
    base_df: pd.DataFrame,
    origin_dates: pd.Series,
    lookback_days: int = 30,
) -> pd.DataFrame:
    if not {"peer_spread_median", "peer_spread_std", "peer_count"}.intersection(
        frame.columns
    ):
        return frame

    base = base_df.sort_values("issue_date")
    for index, row in frame.iterrows():
        target_date = pd.Timestamp(row["issue_date"])
        origin_date = pd.Timestamp(origin_dates.loc[index])
        mask = (
            (base["rating"] == row["rating"])
            & (base["tenor"] == row["tenor"])
            & (base["bond_type"] == row["bond_type"])
            & (base["issue_date"] < origin_date)
            & ((target_date - base["issue_date"]).dt.days <= lookback_days)
        )
        peers = base.loc[mask, "spread_to_benchmark"].dropna()
        if peers.empty:
            frame.loc[
                index, ["peer_spread_median", "peer_spread_std", "peer_count"]
            ] = np.nan
            continue
        frame.loc[index, "peer_spread_median"] = float(peers.median())
        frame.loc[index, "peer_spread_std"] = (
            float(peers.std()) if len(peers) >= 2 else 0.0
        )
        frame.loc[index, "peer_count"] = float(len(peers))
    return frame


def _build_horizon_training_frame(
    dataset: pd.DataFrame,
    feature_names: list[str],
    market_features_df: pd.DataFrame,
    horizon_days: int,
) -> pd.DataFrame:
    market_df = market_features_df.sort_index()
    market_columns = [column for column in market_df.columns if column in feature_names]
    market_feature_names, calendar_feature_names = split_feature_names(market_columns)

    train_df = dataset.dropna(subset=["y_regression", "issue_date"]).copy()
    target_dates = pd.to_datetime(train_df["issue_date"])
    origin_dates = target_dates - pd.to_timedelta(horizon_days, unit="D")
    target_positions = _latest_asof_positions(market_df.index, target_dates)
    origin_positions = _latest_asof_positions(market_df.index, origin_dates)
    valid = (target_positions >= 0) & (origin_positions >= 0)

    frame = train_df.loc[valid].copy()
    target_rows = market_df.iloc[target_positions[valid]].reset_index(drop=True)
    origin_rows = market_df.iloc[origin_positions[valid]].reset_index(drop=True)
    for column in market_feature_names:
        frame[column] = origin_rows[column].to_numpy()
    for column in calendar_feature_names:
        frame[column] = target_rows[column].to_numpy()

    frame = _recompute_horizon_peer_features(
        frame,
        train_df,
        origin_dates.loc[valid],
    )
    if "tenor_x_credit_spread" in feature_names and "credit_spread" in frame.columns:
        frame["tenor_x_credit_spread"] = frame["tenor"] * frame["credit_spread"]
    if "tenor_x_dr007_pctile" in feature_names and "dr007_pctile_60d" in frame.columns:
        frame["tenor_x_dr007_pctile"] = frame["tenor"] * frame["dr007_pctile_60d"]

    base_medians = train_df[feature_names].median(numeric_only=True)
    frame = frame.replace([np.inf, -np.inf], np.nan)
    for column in feature_names:
        if column not in frame.columns:
            frame[column] = base_medians.get(column, 0.0)
        fill_value = frame[column].median()
        if pd.isna(fill_value):
            fill_value = base_medians.get(column, 0.0)
        frame[column] = frame[column].fillna(
            0.0 if pd.isna(fill_value) else float(fill_value)
        )
    return frame


def train_issue_horizon_models(
    dataset: pd.DataFrame,
    feature_names: list[str],
    market_features_df: pd.DataFrame,
    n_estimators: "int | None" = None,
) -> dict[int, dict]:
    """按 1..14 自然日 horizon 直接训练未来发行窗口模型。"""
    models = {}
    for horizon in range(1, 15):
        horizon_df = _build_horizon_training_frame(
            dataset,
            feature_names,
            market_features_df,
            horizon,
        )
        if len(horizon_df) >= 80:
            models[horizon] = train_issue_model(
                horizon_df,
                feature_names,
                n_estimators=n_estimators,
            )
    return models


# ── 月度滚动模型 ─────────────────────────────────────────────────────────────


def build_monthly_models(
    dataset: pd.DataFrame,
    feature_names: list[str],
    start_date: "str | pd.Timestamp",
    end_date: "str | pd.Timestamp",
    min_samples: int = 50,
) -> dict:
    """按月训练扩展窗口模型（无数据泄露）。返回 {month_start: (model, train_med, threshold, group_thresholds)}。"""
    month_starts = pd.date_range(
        start=pd.Timestamp(start_date).to_period("M").to_timestamp(),
        end=pd.Timestamp(end_date),
        freq="MS",
    )
    month_models: dict = {}
    for ms in month_starts:
        train_mask = (dataset["issue_date"] < ms) & dataset["y_regression"].notna()
        train_df = dataset[train_mask]
        if len(train_df) < min_samples:
            continue
        model, train_med, threshold = train_lgb(
            train_df[feature_names].values,
            train_df["y_regression"].values,
            feature_names,
        )
        group_thresholds = compute_group_thresholds(model, train_df, feature_names)
        month_models[ms] = (model, train_med, threshold, group_thresholds)
        print(
            f"  [{ms.strftime('%Y-%m')}] 训练样本: {len(train_df):4d}  全局阈值P25: {threshold:+.2f} bp"
        )
    return month_models


def lookup_monthly_model(month_models: dict, date: pd.Timestamp) -> "tuple | None":
    """返回指定日期对应（或最近已训练）月份的模型，无则返回 None。"""
    ms = date.to_period("M").to_timestamp()
    if ms in month_models:
        return month_models[ms]
    valid = [m for m in sorted(month_models) if m <= ms]
    return month_models[valid[-1]] if valid else None


# ── 私有辅助 ─────────────────────────────────────────────────────────────────


def _prepare_daily_data(
    dataset: pd.DataFrame,
    market_features_df: pd.DataFrame,
    market_feat_names: list[str],
) -> tuple[np.ndarray, np.ndarray, pd.DataFrame]:
    """将逐笔标签按发行日聚合，与 T-1 市场特征合并。两个市场模型共用此逻辑。"""
    daily = (
        dataset.groupby("issue_date")
        .agg(y_mean=("y_regression", "mean"), n_bonds=("y_regression", "size"))
        .reset_index()
    )
    daily["feature_date"] = daily["issue_date"] - pd.Timedelta(days=1)

    mkt_reset = market_features_df.reset_index()
    mkt_reset.columns = ["feature_date"] + market_feat_names

    daily_merged = pd.merge_asof(
        daily.sort_values("feature_date"),
        mkt_reset,
        on="feature_date",
        direction="backward",
    )
    daily_merged = daily_merged.dropna(subset=["y_mean"])
    for col in market_feat_names:
        daily_merged[col] = daily_merged[col].fillna(daily_merged[col].median())

    return (
        daily_merged[market_feat_names].values,
        daily_merged["y_mean"].values,
        daily_merged,
    )


def _es_refit(
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_val: np.ndarray,
    y_val: np.ndarray,
    X_all: np.ndarray,
    y_all: np.ndarray,
    params: dict,
    patience: int = 50,
    min_n: int = 100,
) -> tuple[lgb.LGBMRegressor, int, dict]:
    """
    早停确定最优迭代轮数，再用全量数据 refit。

    返回 (model_refit, best_n, diag)
      diag 含 val_preds（ES 模型的 OOS 预测）供诊断使用。
    """
    es_model = lgb.LGBMRegressor(**params)
    es_model.fit(
        X_train,
        y_train,
        eval_set=[(X_val, y_val)],
        callbacks=[lgb.early_stopping(patience, verbose=False)],
    )
    best_n = es_model.best_iteration_ or params.get("n_estimators", 500)
    warned = best_n < min_n
    best_n = max(best_n, min_n)

    val_preds = es_model.predict(X_val)
    train_preds = es_model.predict(X_train)
    diag = {
        "best_n": best_n,
        "orig_n": es_model.best_iteration_,
        "warned": warned,
        "val_preds": val_preds,
        "val_ic": float(np.corrcoef(val_preds, y_val)[0, 1]) if len(y_val) > 2 else 0.0,
        "val_rmse": float(np.sqrt(np.mean((val_preds - y_val) ** 2))),
        "train_ic": float(np.corrcoef(train_preds, y_train)[0, 1])
        if len(y_train) > 2
        else 0.0,
    }

    model = lgb.LGBMRegressor(**{**params, "n_estimators": best_n})
    model.fit(X_all, y_all)
    return model, best_n, diag


# ── AR(1) 市场特征预测 ───────────────────────────────────────────────────────


# ── 市场择时模型 P1 ──────────────────────────────────────────────────────────


def train_market_model(
    dataset: pd.DataFrame,
    market_features_df: pd.DataFrame,
    market_feat_names: list[str],
    val_ratio: float = 0.2,
    n_estimators: "int | None" = None,
) -> tuple:
    """
    训练纯市场维度择时模型（P1）。

    n_estimators: 由 TSCV 中位数提供时直接全量训练（推荐），
                  None 时走内部 early stopping + refit 流程。
    返回: (model, train_med, threshold_p25, threshold_p50, train_preds, daily_merged)
    """
    X_all, y_all, daily_merged = _prepare_daily_data(
        dataset, market_features_df, market_feat_names
    )

    if n_estimators is not None:
        model = lgb.LGBMRegressor(**{**LGB_PARAMS, "n_estimators": n_estimators})
        model.fit(X_all, y_all)
        print(
            f"[train_market_model] 全量训练: {len(X_all)} 天 | 迭代(TSCV中位数): {n_estimators} | 无 early stopping"
        )
    else:
        split = int(len(X_all) * (1 - val_ratio))
        model, best_n, diag = _es_refit(
            X_all[:split],
            y_all[:split],
            X_all[split:],
            y_all[split:],
            X_all,
            y_all,
            LGB_PARAMS,
            patience=50,
            min_n=100,
        )
        warn = (
            f" ⚠ 早停过激(原={diag['orig_n']})，已使用保底100轮"
            if diag["warned"]
            else ""
        )
        print(
            f"[train_market_model] train={split}, val={len(X_all) - split}, refit=全量{len(X_all)} | "
            f"迭代: {best_n}{warn} | IC: train={diag['train_ic']:.3f}, val={diag['val_ic']:.3f} | "
            f"RMSE: val={diag['val_rmse']:.2f} bp"
        )

    train_preds = model.predict(X_all)
    threshold_p25 = float(np.percentile(train_preds, 25))
    threshold_p50 = float(np.percentile(train_preds, 50))
    train_med = pd.Series(np.nanmedian(X_all, axis=0), index=market_feat_names)
    return model, train_med, threshold_p25, threshold_p50, train_preds, daily_merged


# ── 市场/日历分离模型 P2 ─────────────────────────────────────────────────────


def train_market_model_v2(
    dataset: pd.DataFrame,
    market_features_df: pd.DataFrame,
    market_feat_names: list[str],
    val_ratio: float = 0.2,
) -> dict:
    """
    P2：日历/市场分离建模。y = f(市场特征) + g(日历特征) + ε

    阶段 A — 市场模型：拟合 y，得到市场基准预测
    阶段 B — 日历残差模型：拟合残差，捕捉周内/月内/季末效应
    两阶段均使用 _es_refit 保证不被 regime shift 误触早停。
    """
    X_all, y_all, daily_merged = _prepare_daily_data(
        dataset, market_features_df, market_feat_names
    )

    mkt_feat_names, cal_feat_names = split_feature_names(market_feat_names)
    mkt_indices = [market_feat_names.index(f) for f in mkt_feat_names]
    cal_indices = [market_feat_names.index(f) for f in cal_feat_names]
    X_mkt, X_cal = X_all[:, mkt_indices], X_all[:, cal_indices]

    split = int(len(X_all) * (1 - val_ratio))
    y_train, y_val = y_all[:split], y_all[split:]

    # 阶段 A
    market_model, best_n_mkt, diag_mkt = _es_refit(
        X_mkt[:split],
        y_train,
        X_mkt[split:],
        y_val,
        X_mkt,
        y_all,
        LGB_PARAMS,
        patience=50,
        min_n=100,
    )

    # 阶段 B（残差基于 refit 市场模型计算，诊断用 ES 模型的 OOS 预测）
    mkt_pred_all = market_model.predict(X_mkt)
    residuals_all = y_all - mkt_pred_all
    cal_params = {**LGB_PARAMS, "num_leaves": 15, "max_depth": 4, "n_estimators": 200}
    calendar_model, best_n_cal, diag_cal = _es_refit(
        X_cal[:split],
        residuals_all[:split],
        X_cal[split:],
        residuals_all[split:],
        X_cal,
        residuals_all,
        cal_params,
        patience=30,
        min_n=50,
    )

    cal_pred_all = calendar_model.predict(X_cal)
    train_preds = mkt_pred_all + cal_pred_all
    threshold_p25 = float(np.percentile(train_preds, 25))
    threshold_p50 = float(np.percentile(train_preds, 50))
    train_med = pd.Series(np.nanmedian(X_all, axis=0), index=market_feat_names)

    feature_ranges = {
        fname: {
            "p01": float(np.percentile(X_all[:, j], 1)),
            "p99": float(np.percentile(X_all[:, j], 99)),
            "p05": float(np.percentile(X_all[:, j], 5)),
            "p95": float(np.percentile(X_all[:, j], 95)),
            "median": float(np.nanmedian(X_all[:, j])),
        }
        for j, fname in enumerate(market_feat_names)
    }

    # 诊断（全部使用 ES 模型的 OOS 预测，保证真实性）
    combined_val = diag_mkt["val_preds"] + diag_cal["val_preds"]
    combined_val_ic = (
        float(np.corrcoef(combined_val, y_val)[0, 1]) if len(y_val) > 2 else 0.0
    )
    combined_val_rmse = float(np.sqrt(np.mean((combined_val - y_val) ** 2)))
    cal_contribution_pct = float(
        np.abs(cal_pred_all).mean()
        / (np.abs(mkt_pred_all).mean() + np.abs(cal_pred_all).mean() + 1e-8)
        * 100
    )
    mkt_warn = " ⚠ 早停过激" if diag_mkt["warned"] else ""
    cal_warn = " ⚠ 早停过激" if diag_cal["warned"] else ""
    print(
        f"[train_market_model_v2] train={split}, val={len(X_all) - split}, refit=全量{len(X_mkt)}\n"
        f"  阶段A(市场): 迭代={best_n_mkt}{mkt_warn} | IC: train={diag_mkt['train_ic']:.3f}, val={diag_mkt['val_ic']:.3f} | RMSE: {diag_mkt['val_rmse']:.2f} bp\n"
        f"  阶段B(日历): 迭代={best_n_cal}{cal_warn} | IC(val残差): {diag_cal['val_ic']:.3f}\n"
        f"  合并: val IC={combined_val_ic:.3f}, val RMSE={combined_val_rmse:.2f} bp | 日历贡献: {cal_contribution_pct:.1f}%"
    )

    return {
        "market_model": market_model,
        "calendar_model": calendar_model,
        "train_med": train_med,
        "threshold_p25": threshold_p25,
        "threshold_p50": threshold_p50,
        "train_preds": train_preds,
        "daily_merged": daily_merged,
        "market_feat_names_only": mkt_feat_names,
        "calendar_feat_names_only": cal_feat_names,
        "market_feat_indices": mkt_indices,
        "calendar_feat_indices": cal_indices,
        "train_X_mkt": X_mkt,
        "train_y": y_all,
        "feature_ranges": feature_ranges,
    }
