# ============================================================
# 回测
# ============================================================

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from data import FeatureEngineer, compute_peer_stats
from model import (
    build_market_feature_vec,
    build_monthly_models,
    compute_company_readiness,
    fill_features,
    lookup_group_threshold,
    lookup_monthly_model,
    predict_with_fillna,
    shap_top_drivers,
    train_lgb,
)


def _issuer_bonds(
    dataset: pd.DataFrame, issuer_name: str, start_date: str
) -> pd.DataFrame:
    """返回指定发行人在起始日后的债券，统一两个回测入口的筛选口径。"""
    return (
        dataset[
            (dataset["issuer"] == issuer_name)
            & (dataset["issue_date"] >= pd.Timestamp(start_date))
        ]
        .sort_values("issue_date")
        .copy()
    )


@dataclass
class _HistoricalBondScorer:
    """严格使用发行日前数据完成单笔历史发行评分。"""

    dataset: pd.DataFrame
    fe: FeatureEngineer
    threshold_pct: float
    proprietary_features: pd.DataFrame | None = None

    def score(self, bond: pd.Series) -> dict | None:
        issue_date = bond["issue_date"]
        train_df = self.dataset[self.dataset["issue_date"] < issue_date].dropna(
            subset=["y_regression"]
        )
        if len(train_df) < 50:
            print(f"  [{issue_date.date()}] 训练样本不足（{len(train_df)}），跳过")
            return None

        model, train_med, threshold = train_lgb(
            train_df[self.fe.feature_names].values,
            train_df["y_regression"].values,
            self.fe.feature_names,
            threshold_pct=self.threshold_pct,
        )
        y_pred, pred_good = predict_with_fillna(
            model,
            train_med,
            threshold,
            bond[self.fe.feature_names],
            self.fe.feature_names,
        )
        x_filled = fill_features(
            bond[self.fe.feature_names], train_med, self.fe.feature_names
        )
        drivers = shap_top_drivers(model, x_filled, self.fe.feature_names, top_n=3)
        top3 = [f"{item['feature']}({item['shap']:+.2f})" for item in drivers]

        y_actual = bond["y_regression"]
        actual_good = (
            bool(bond["y_classification"] == 1) if pd.notna(y_actual) else None
        )
        readiness_label = self._readiness_label(issue_date)
        self._print_score(
            bond,
            y_actual,
            y_pred,
            actual_good,
            pred_good,
            threshold,
            readiness_label,
        )
        return {
            "issue_date": issue_date.date(),
            "tenor": bond["tenor"],
            "rating": bond["rating"],
            "issue_size(亿)": bond["issue_size"],
            "spread(bp)": bond["spread_to_benchmark"],
            "y_actual(bp)": round(y_actual, 2) if pd.notna(y_actual) else None,
            "y_pred(bp)": round(y_pred, 2),
            "实际择时": (
                "✓ 优于中位数"
                if actual_good
                else ("✗ 劣于中位数" if actual_good is False else "—（无可比债）")
            ),
            "模型信号": "✓ 建议发行" if pred_good else "✗ 建议等待",
            "判断正确": (pred_good == actual_good if actual_good is not None else None),
            "公司就绪度": readiness_label,
            "训练样本数": len(train_df),
            "Top3驱动因子": " | ".join(top3),
        }

    def _readiness_label(self, issue_date: pd.Timestamp) -> str:
        if self.proprietary_features is None:
            return "数据不足"
        readiness = compute_company_readiness(
            self.proprietary_features, target_date=issue_date
        )
        return readiness.get("readiness_label", "数据不足")

    @staticmethod
    def _print_score(
        bond: pd.Series,
        y_actual: float,
        y_pred: float,
        actual_good: bool | None,
        pred_good: bool,
        threshold: float,
        readiness_label: str,
    ) -> None:
        status = (
            "✓"
            if (actual_good is not None and pred_good == actual_good)
            else ("✗" if actual_good is not None else "?")
        )
        rec_tag = "模型推荐" if pred_good else f"模型等待(>{threshold:+.1f}bp)"
        actual_tag = (
            "实际优" if actual_good else "实际劣" if actual_good is False else "无标签"
        )
        print(
            f"  [{bond['issue_date'].date()}] {bond['tenor']:.0f}Y  "
            f"spread={bond['spread_to_benchmark']:.1f}bp  "
            f"y_actual={y_actual:+.1f}bp  y_pred={y_pred:+.1f}bp  "
            f"{actual_tag}/{rec_tag}  {status}  公司{readiness_label}"
        )


def _print_historical_backtest_summary(
    result: pd.DataFrame, start_date: str
) -> pd.DataFrame:
    labeled = result[result["判断正确"].notna()]
    if labeled.empty:
        return labeled

    accuracy = labeled["判断正确"].mean()
    actual_good_rate = result["实际择时"].str.startswith("✓").mean()
    recommended = labeled[labeled["模型信号"] == "✓ 建议发行"]
    recommended_success = recommended["实际择时"].str.startswith("✓").mean()
    print(f"\n{'=' * 60}")
    print(
        f"回测汇总（{start_date} 至今，共 {len(result)} 笔，{len(labeled)} 笔有标签）"
    )
    print(f"{'=' * 60}")
    print(f"  实际择时成功率:         {actual_good_rate:.1%}（基准 50%）")
    print(f"  模型判断准确率:         {accuracy:.1%}")
    print(f"  模型推荐窗口实际成功率: {recommended_success:.1%}")

    if not recommended.empty:
        avg_actual = labeled["y_actual(bp)"].dropna().astype(float).mean()
        avg_recommended = recommended["y_actual(bp)"].dropna().astype(float).mean()
        print(f"  全部发行均值利差偏离:   {avg_actual:+.2f} bp")
        print(
            f"  模型推荐发行均值利差偏离: {avg_recommended:+.2f} bp（负值=优于中位数）"
        )
    return labeled


def _print_readiness_cross_tab(
    labeled: pd.DataFrame, proprietary_features: pd.DataFrame | None
) -> None:
    if proprietary_features is None or labeled.empty:
        return
    print(f"\n{'=' * 60}")
    print("  公司就绪度 × 择时结果 交叉分析")
    print(f"{'=' * 60}")
    for label in ["偏紧", "适中", "宽裕", "数据不足"]:
        subset = labeled[labeled["公司就绪度"] == label]
        if subset.empty:
            continue
        actual = subset["y_actual(bp)"].dropna().astype(float)
        print(
            f"  【{label}】{len(subset)} 笔  "
            f"平均利差偏离: {actual.mean():+.2f} bp  "
            f"择时胜率: {(actual < 0).mean():.0%}"
        )


def backtest_efunds_timing(
    dataset: pd.DataFrame,
    fe: FeatureEngineer,
    start_date: str = "2024-01-01",
    issuer_name: str = "东方财富证券股份有限公司",
    threshold_pct: float = 25,
) -> pd.DataFrame:
    """
    逐笔回测东方财富证券债券发行择时效果。

    对每笔发行，严格用发行日前的数据训练模型，预测当次发行的
    利差偏离（相对同期可比债中位数），并与实际结果对比。
    无未来数据泄露。

    参数：
        dataset: 含特征和标签的完整数据集（由 merge_all_features + build_label 输出）
        fe: FeatureEngineer 实例（提供 feature_names）
        start_date: 回测起始日期
        issuer_name: 发行人名称
        train_window_months: 训练窗口长度（月），0=使用全部历史数据（扩展窗口）
        threshold_pct: 推荐阈值百分位数（默认 25），值越大推荐越宽松

    返回：
        DataFrame，每行一笔发行，含预测结果与实际结果对比
    """
    ef_bonds = _issuer_bonds(dataset, issuer_name, start_date)

    if ef_bonds.empty:
        print(f"[WARN] 未找到 {issuer_name} 在 {start_date} 之后的发行记录")
        return pd.DataFrame()

    print(f"[INFO] 找到 {len(ef_bonds)} 笔 {issuer_name} 发行记录（{start_date} 至今）")
    print(
        f"[INFO] 其中有标签（可比债 >= 3 笔）: {ef_bonds['y_regression'].notna().sum()} 笔"
    )

    proprietary_features = getattr(fe, "proprietary_features_", None)
    scorer = _HistoricalBondScorer(dataset, fe, threshold_pct, proprietary_features)
    records = []
    for _, bond in ef_bonds.iterrows():
        record = scorer.score(bond)
        if record is not None:
            records.append(record)

    result = pd.DataFrame(records)
    labeled = _print_historical_backtest_summary(result, start_date)
    _print_readiness_cross_tab(labeled, proprietary_features)
    return result


@dataclass
class _DailyBacktestScorer:
    """封装逐日回测所需模型、特征和可比债缓存。"""

    dataset: pd.DataFrame
    fe: FeatureEngineer
    month_models: dict
    peer_cache: dict[tuple, float] = field(default_factory=dict)

    @property
    def all_trading_days(self) -> pd.DatetimeIndex:
        return self.fe.all_market_features_.index

    def peer_median(self, eval_date, tenor, rating, bond_type) -> float:
        key = (eval_date, tenor, rating, bond_type)
        if key not in self.peer_cache:
            stats = compute_peer_stats(
                self.dataset,
                eval_date,
                tenor,
                rating,
                bond_type,
            )
            self.peer_cache[key] = stats["median"] if stats is not None else np.nan
        return self.peer_cache[key]

    def score_date(self, eval_date, tenor, rating, bond_type):
        """返回 ``(预测偏离, 可比债中位数, 反事实利差, 是否推荐)``。"""
        info = lookup_monthly_model(self.month_models, eval_date)
        if info is None:
            return None
        model, train_med, global_threshold, group_thresholds = info

        idx = self.all_trading_days.searchsorted(eval_date, side="left") - 1
        if idx < 0:
            return None
        market_features = self.fe.all_market_features_.iloc[idx]

        peer_med = self.peer_median(eval_date, tenor, rating, bond_type)
        if np.isnan(peer_med):
            return None

        x_vec = build_market_feature_vec(
            market_features,
            tenor,
            peer_med,
            train_med,
            self.fe.feature_names,
            is_subordinated=float(bond_type == "证券公司次级债"),
        )
        threshold = lookup_group_threshold(
            group_thresholds, global_threshold, bond_type, tenor
        )
        y_pred = float(model.predict(x_vec.reshape(1, -1))[0])
        return y_pred, peer_med, peer_med + y_pred, y_pred <= threshold


def _build_daily_signals(
    scorer: _DailyBacktestScorer,
    profiles: pd.DataFrame,
    start_date: str,
) -> pd.DataFrame:
    rows = []
    eval_days = scorer.all_trading_days[
        scorer.all_trading_days >= pd.Timestamp(start_date)
    ]
    for eval_date in eval_days:
        for _, profile in profiles.iterrows():
            score = scorer.score_date(
                eval_date,
                profile["tenor"],
                profile["rating"],
                profile["bond_type"],
            )
            if score is None:
                continue
            y_pred, peer_med, counterfactual_spread, is_recommended = score
            rows.append(
                {
                    "date": eval_date,
                    "tenor": profile["tenor"],
                    "rating": profile["rating"],
                    "bond_type": profile["bond_type"],
                    "peer_median(bp)": peer_med,
                    "y_pred(bp)": y_pred,
                    "cf_spread(bp)": counterfactual_spread,
                    "is_recommended": is_recommended,
                }
            )
    return pd.DataFrame(rows)


def _score_market_bonds(
    bonds: pd.DataFrame,
    fe: FeatureEngineer,
    month_models: dict,
) -> pd.DataFrame:
    """用每笔发行时可用的月度模型给全市场验证债券打分。"""
    rows = []
    for _, bond in bonds.iterrows():
        issue_date = bond["issue_date"]
        info = lookup_monthly_model(month_models, issue_date)
        if info is None:
            continue
        model, train_med, global_threshold, _ = info
        y_pred, is_recommended = predict_with_fillna(
            model,
            train_med,
            global_threshold,
            bond[fe.feature_names],
            fe.feature_names,
        )
        rows.append(
            {
                "issue_date": issue_date,
                "issuer": bond.get("issuer", ""),
                "tenor": bond["tenor"],
                "rating": bond["rating"],
                "bond_type": bond["bond_type"],
                "spread(bp)": bond["spread_to_benchmark"],
                "y_pred(bp)": y_pred,
                "y_actual(bp)": bond["y_regression"],
                "y_classification": int(bond["y_classification"]),
                "is_recommended": is_recommended,
            }
        )
    return pd.DataFrame(rows)


def _counterfactual_bond_result(
    bond: pd.Series,
    scorer: _DailyBacktestScorer,
    planning_window_days: int,
) -> dict | None:
    issue_date = bond["issue_date"]
    tenor = bond["tenor"]
    rating = bond["rating"]
    bond_type = bond["bond_type"]
    actual_spread = bond["spread_to_benchmark"]
    issue_size = bond["issue_size"]

    window_start = issue_date - pd.Timedelta(days=planning_window_days)
    window_days = scorer.all_trading_days[
        (scorer.all_trading_days >= window_start)
        & (scorer.all_trading_days <= issue_date)
    ]
    scores = []
    for eval_date in window_days:
        score = scorer.score_date(eval_date, tenor, rating, bond_type)
        if score is not None:
            scores.append((eval_date, *score))

    if not scores:
        print(f"  [{issue_date.date()}] {tenor:.0f}Y 窗口内无有效可比债，跳过")
        return None

    scores.sort(key=lambda item: item[3])
    best_date, best_y_pred, best_peer_med, best_spread, _ = scores[0]
    actual_row = next((item for item in scores if item[0] == issue_date), None)
    actual_y_pred = actual_row[1] if actual_row else np.nan
    savings_bp = actual_spread - best_spread
    savings_wan_year = savings_bp * issue_size

    print(
        f"  [{issue_date.date()}] {tenor:.0f}Y {issue_size:.0f}亿  "
        f"actual={actual_spread:.1f}bp  best={best_date.date()}  "
        f"cf={best_spread:.1f}bp  savings={savings_bp:+.1f}bp  "
        f"{savings_wan_year:+.0f}万/年"
    )
    return {
        "issue_date": issue_date.date(),
        "tenor(Y)": tenor,
        "rating": rating,
        "issue_size(亿)": issue_size,
        "actual_spread(bp)": actual_spread,
        "actual_y_pred(bp)": (
            round(actual_y_pred, 2) if pd.notna(actual_y_pred) else None
        ),
        "best_date": best_date.date(),
        "best_y_pred(bp)": round(best_y_pred, 2),
        "peer_median@best(bp)": round(best_peer_med, 2),
        "cf_spread(bp)": round(best_spread, 2),
        "savings_bp": round(savings_bp, 2),
        "savings_万元/年": round(savings_wan_year, 1),
        "savings_万元(存续期)": round(savings_wan_year * tenor, 1),
    }


def _evaluate_counterfactual_bonds(
    bonds: pd.DataFrame,
    scorer: _DailyBacktestScorer,
    planning_window_days: int,
) -> pd.DataFrame:
    rows = []
    for _, bond in bonds.iterrows():
        result = _counterfactual_bond_result(bond, scorer, planning_window_days)
        if result is not None:
            rows.append(result)
    return pd.DataFrame(rows)


def _print_daily_signal_summary(signals: pd.DataFrame) -> None:
    if signals.empty:
        return
    day_rec = signals.groupby("date")["is_recommended"].any()
    n_total_days = len(day_rec)
    n_rec_days = int(day_rec.sum())
    rec_mask = signals["is_recommended"]
    rec_cf_mean = signals.loc[rec_mask, "cf_spread(bp)"].mean()
    all_cf_mean = signals["cf_spread(bp)"].mean()
    print("\n  [1] 逐日发行信号（基于东财主要品种）")
    print(f"      评估交易日:             {n_total_days} 天")
    print(
        f"      模型推荐发行日:         {n_rec_days} 天（{n_rec_days / n_total_days:.1%}）"
    )
    print(f"      推荐日预期发行利差均值: {rec_cf_mean:.1f} bp")
    print(f"      全部日预期发行利差均值: {all_cf_mean:.1f} bp")
    print(f"      推荐日比全部均值低:     {all_cf_mean - rec_cf_mean:.1f} bp")


def _print_market_validation_summary(scored: pd.DataFrame) -> None:
    if scored.empty:
        return
    n_all = len(scored)
    n_rec = int(scored["is_recommended"].sum())
    n_no = n_all - n_rec
    wr_all = scored["y_classification"].mean()
    wr_rec = (
        scored.loc[scored["is_recommended"], "y_classification"].mean()
        if n_rec
        else np.nan
    )
    wr_no = (
        scored.loc[~scored["is_recommended"], "y_classification"].mean()
        if n_no
        else np.nan
    )
    avg_dev_all = scored["y_actual(bp)"].mean()
    avg_dev_rec = (
        scored.loc[scored["is_recommended"], "y_actual(bp)"].mean() if n_rec else np.nan
    )
    print(f"\n  [2] 胜率验证（全市场 {n_all} 笔实际发行）")
    print(f"      全市场基准胜率:         {wr_all:.1%}（{n_all} 笔）")
    print(f"      模型推荐发行胜率:       {wr_rec:.1%}（{n_rec} 笔）")
    print(f"      模型不推荐发行胜率:     {wr_no:.1%}（{n_no} 笔）")
    print(
        f"      全部发行平均利差偏离:   {avg_dev_all:+.2f} bp（相对同期可比债中位数）"
    )
    print(f"      推荐发行平均利差偏离:   {avg_dev_rec:+.2f} bp（负值=优于市场中位数）")


def _print_recommended_spread_summary(
    signals: pd.DataFrame,
    profiles: pd.DataFrame,
    issuer_bonds: pd.DataFrame,
) -> None:
    if signals.empty:
        return
    recommended = signals[signals["is_recommended"]]
    profile_medians = []
    for _, profile in profiles.iterrows():
        matches = (
            (recommended["tenor"] == profile["tenor"])
            & (recommended["rating"] == profile["rating"])
            & (recommended["bond_type"] == profile["bond_type"])
        )
        if matches.any():
            profile_medians.append(recommended.loc[matches, "peer_median(bp)"].mean())
    if not profile_medians:
        return
    avg_rec_peer = float(np.mean(profile_medians))
    actual_avg = float(issuer_bonds["spread_to_benchmark"].mean())
    print("\n  [3] 年平均发行利差（东财主要品种）")
    print(f"      东财实际发行利差均值:   {actual_avg:.1f} bp")
    print(f"      推荐日市场基准利差均值: {avg_rec_peer:.1f} bp（peer_median 均值）")
    print(f"      潜在降低:               {actual_avg - avg_rec_peer:+.1f} bp")


def _print_savings_summary(results: pd.DataFrame, planning_window_days: int) -> None:
    if results.empty:
        return
    avg_bp = results["savings_bp"].mean()
    total_wan = results["savings_万元/年"].sum()
    avg_wan = results["savings_万元/年"].mean()
    positive_ratio = (results["savings_bp"] > 0).mean()
    print(f"\n  [4] 东财节约成本（规划窗口 {planning_window_days} 天）")
    print(f"      评估东财债券数:   {len(results)} 笔")
    print(f"      平均节约利差:     {avg_bp:+.2f} bp/笔")
    print(f"      节约为正比例:     {positive_ratio:.1%}")
    print(f"      年度节约总量:     {total_wan:+.1f} 万元/年（所有东财债券合计）")
    print(f"      每笔平均年节约:   {avg_wan:+.1f} 万元/年")


def _print_daily_backtest_summary(
    start_date: str,
    signals: pd.DataFrame,
    scored: pd.DataFrame,
    profiles: pd.DataFrame,
    issuer_bonds: pd.DataFrame,
    results: pd.DataFrame,
    planning_window_days: int,
) -> None:
    print(f"\n{'=' * 60}")
    print(f"逐日择时回测汇总（{start_date} 至今）")
    print(f"{'=' * 60}")
    _print_daily_signal_summary(signals)
    _print_market_validation_summary(scored)
    _print_recommended_spread_summary(signals, profiles, issuer_bonds)
    _print_savings_summary(results, planning_window_days)


def daily_timing_backtest(
    dataset: pd.DataFrame,
    fe: FeatureEngineer,
    start_date: str = "2024-01-01",
    issuer_name: str = "东方财富证券股份有限公司",
    planning_window_days: int = 30,
) -> pd.DataFrame:
    """
    逐日择时回测：
    1. 逐日评估 start_date 至今每个交易日是否适合发行（针对东财主要发行品种）
    2. 用全市场实际发行验证推荐日发行的胜率
    3. 统计推荐日的年平均发行利差
    4. 对每笔东财实际发行，在 planning_window_days 窗口内找反事实最优发行日，
       测算与实际发行的利差节约

    节约成本换算：savings_万元/年 = savings_bp × issue_size(亿)
        （1bp × 1亿 = 0.01% × 1e8元 = 1万元/年）

    参数：
        dataset: merge_all_features + build_label 输出的完整数据集
        fe: FeatureEngineer 实例（提供 feature_names 和 all_market_features_）
        start_date: 回测起始日期
        issuer_name: 发行人名称
        planning_window_days: 节约成本计算的规划窗口（天）

    返回：
        DataFrame，每行一笔东财债券，含最优日期和节约成本
    """
    ef_bonds = _issuer_bonds(dataset, issuer_name, start_date)

    if ef_bonds.empty:
        print(f"[WARN] 未找到 {issuer_name} 在 {start_date} 之后的发行记录")
        return pd.DataFrame()

    # 全市场有标签发行（用于胜率验证）
    all_bonds_test = dataset[
        (dataset["issue_date"] >= pd.Timestamp(start_date))
        & dataset["y_regression"].notna()
    ].copy()

    print(f"[INFO] 东财债券: {len(ef_bonds)} 笔（{start_date} 至今）")
    print(f"[INFO] 全市场验证集: {len(all_bonds_test)} 笔（含所有发行人）")
    print(f"[INFO] 规划窗口: {planning_window_days} 天")

    # 东财主要发行品种（按频次取前3，用于逐日评估）
    ef_profiles = (
        ef_bonds.groupby(["tenor", "rating", "bond_type"])
        .size()
        .sort_values(ascending=False)
        .head(3)
        .reset_index()
        .rename(columns={0: "count"})
    )
    print("[INFO] 东财主要发行品种:")
    for _, r in ef_profiles.iterrows():
        print(
            f"  {r['tenor']:.0f}Y {r['rating']} {r['bond_type']}: {r['count']:.0f} 笔"
        )

    # ---- Phase 1: 按月训练模型（调用 model.build_monthly_models）----
    print("\n[INFO] 按月训练模型...")
    month_models = build_monthly_models(
        dataset=dataset,
        feature_names=fe.feature_names,
        start_date=start_date,
        end_date=ef_bonds["issue_date"].max() + pd.DateOffset(months=1),
    )

    if not month_models:
        print("[WARN] 没有成功训练的模型")
        return pd.DataFrame()

    scorer = _DailyBacktestScorer(dataset, fe, month_models)

    # ---- Phase 2: 逐日评估（start_date 至今，针对东财主要品种）----
    print("\n[INFO] 逐日评估交易日...")
    signals_df = _build_daily_signals(scorer, ef_profiles, start_date)

    # ---- Phase 3: 全市场逐笔打分（用于胜率验证）----
    print("[INFO] 全市场逐笔打分...")
    scored_df = _score_market_bonds(all_bonds_test, fe, month_models)

    # ---- Phase 4: 东财节约成本（每笔在规划窗口内找反事实最优发行日）----
    print("[INFO] 东财节约成本评估...")
    result_df = _evaluate_counterfactual_bonds(ef_bonds, scorer, planning_window_days)

    _print_daily_backtest_summary(
        start_date,
        signals_df,
        scored_df,
        ef_profiles,
        ef_bonds,
        result_df,
        planning_window_days,
    )

    return result_df
