"""从同一逐笔回测生成完整中文报告、逐日明细与误差图。"""

import numpy as np
import pandas as pd

from .export import write_json
from .issuance_backtest import clustered_loss_interval, path_metrics


def _table(frame, columns):
    lines = [
        "| " + " | ".join(columns.values()) + " |",
        "| " + " | ".join("---" for _ in columns) + " |",
    ]
    for record in frame.to_dict(orient="records"):
        cells = []
        for key in columns:
            value = record[key]
            if pd.isna(value):
                cells.append("—")
            elif isinstance(value, (float, np.floating)):
                cells.append(
                    f"{value:.1%}"
                    if key.endswith("rate")
                    or "accuracy" in key
                    or key.startswith("within_")
                    else f"{value:.3f}"
                )
            else:
                cells.append(str(value))
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def _bond_details(current, directory):
    valid = current.loc[current.status.eq("estimated")].copy()
    valid["predicted_percent"] = valid.prediction_coupon_bp / 100
    grid = valid.pivot(
        index="bond_code", columns="event_lead_days", values="predicted_percent"
    )
    grid.columns = [f"T-{lead}" for lead in grid.columns]
    base = current.drop_duplicates("bond_code").set_index("bond_code")[
        ["issue_date", "pricing_date", "tenor", "actual_coupon_bp"]
    ]
    base["actual_percent"] = base.pop("actual_coupon_bp") / 100
    details = base.join(grid).sort_values(["issue_date", "tenor"])
    details.to_csv(directory / "bond-all-30-origins.csv")
    return details.reset_index()


def _draw_horizons(horizons, directory):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(9, 4.6), layout="constrained")
    names = {
        "lgb_anchor_drift": "LightGBM anchor",
        "random_walk": "No rate change",
        "direct_lgb": "Direct horizon LightGBM",
    }
    for name, label in names.items():
        group = horizons.loc[horizons.candidate.eq(name)].sort_values("event_lead_days")
        ax.plot(group.event_lead_days, group.mae_bp, label=label, linewidth=2)
    ax.set(
        xlabel="Calendar days before actual issue date",
        ylabel="Coupon MAE (bp)",
        xlim=(1, 30),
    )
    ax.grid(alpha=0.2)
    ax.legend(frameon=False)
    fig.savefig(directory / "horizon-mae.png", dpi=180)
    plt.close(fig)


def _policy_metrics(policy, issuer):
    rows = []
    for scope, subset in (
        ("全部同类发行人", policy),
        ("我司", policy.loc[policy.issuer.eq(issuer)]),
    ):
        for cost, group in subset.groupby("waiting_cost_bp_day"):
            waited = group.loc[group.wait]
            rows.append(
                {
                    "scope": scope,
                    "cost": cost,
                    "pairs": len(group),
                    "waits": len(waited),
                    "win_rate": waited.actual_net_saving_bp.gt(0).mean(),
                    "gain_immediate": group.realized_saving_vs_immediate_bp.mean(),
                    "gain_deadline": group.realized_saving_vs_always_wait_bp.mean(),
                }
            )
    return pd.DataFrame(rows)


def write_event_report(paths, targets, pairs, policy, directory, issuer, date):
    issue = paths.loc[paths.date_basis.eq("issue_date")].copy()
    current = issue.loc[issue.candidate.eq("lgb_anchor_drift")]
    metrics = path_metrics(current, ("candidate",)).iloc[0]
    intervals = clustered_loss_interval(current)
    horizons = path_metrics(issue)
    selected = horizons.loc[horizons.candidate.eq("lgb_anchor_drift")].sort_values(
        "event_lead_days"
    )
    overall = path_metrics(issue, ("candidate",)).sort_values("mae_bp")
    current = current.assign(year=pd.to_datetime(current.pricing_date).dt.year)
    annual = path_metrics(current, ("year",))
    terms = path_metrics(current, ("tenor", "bond_type"))
    details = _bond_details(current, directory)
    _draw_horizons(horizons, directory)
    own_pairs = pairs.loc[pairs.issuer.eq(issuer)]
    policy_summary = _policy_metrics(policy, issuer)
    policy_summary.to_csv(directory / "policy-summary.csv", index=False)
    write_json(
        directory / "assessment.json",
        {
            "issuer": issuer,
            "as_of": str(date.date()),
            "usage": "pricing_reference_only",
            "timing_alpha": "not_established",
            "issuer_prediction_metrics": metrics.to_dict(),
            "event_cluster_loss_improvement": intervals,
            "issuer_real_pairs": len(own_pairs),
            "policy": policy_summary.to_dict(orient="records"),
            "independent_new_holdout": False,
        },
    )
    lines = [
        "# 交易所债券融资择时模型——我司真实发行回测",
        "",
        f"> 摘要：按{issuer}真实发行重放T−30至T−1，当前LightGBM票面平均绝对误差{metrics.mae_bp:.2f}bp，利率不变基准{metrics.flat_mae_bp:.2f}bp；误差在5bp、10bp以内的比例分别为{metrics.within_5bp:.1%}、{metrics.within_10bp:.1%}。按{intervals['events']}个定价事件聚类后，改善的95%描述性区间为[{intervals['low95_bp']:.2f}, {intervals['high95_bp']:.2f}]bp，不能确认稳定预测增益。模型目前适合辅助票面预算，不足以支持主动押注发行时点；完整等待规则没有形成可报告的已执行等待胜率。",
        "",
        "## 1. 研究问题",
        "",
        "固定每笔真实发行的方案与最终票面，分别站在实际发行日T前30至1个自然日，评价当时能否预测最终融资利率。逐个提前量评分，同时分清票面误差、二级市场方向和实际等待收益。",
        "",
        "## 2. 研究方法",
        "",
        "信息集严格早于预测时点。已发生但尚未公开/成熟的最终票面不能进入历史估计；已过真实簿记定价日的时点保留为排除记录，不冒充成功预测。发行方案和实际定价日是固定情景假设，不能证明当时已经知晓其后最终方案。另输出以簿记日为T的全期限结果作敏感性比较。",
        "",
        "基准包括同一级溢价下的利率不变、历史漂移和上一笔同方案票面。挑战者包括各自然日期限直接训练的LightGBM、25%收缩LightGBM、25%收缩Ridge。直接模型按月初冻结训练，训练标签必须在月初全部成熟；月冻结锚定模型只冻结树，漂移和一级历史仍每日更新。原锚定模型按当时成熟历史训练，远期仍含历史漂移，不能把该路径解释为逐日高置信度信号。",
        "",
        "旧模型复现其下一报价日起算的内部市场时钟；新直接模型以真实自然日预测时点起算。二者用相同可用行情预测同一笔最终票面，但训练标签时钟与更新安排不同，这是完整系统比较，不能归因为LightGBM结构一项差异。逐行保存market_clock、forecast_origin、effective_horizon和市场来源日期；周末T−1不会被改名为T当日。",
        "",
        "MAE是平均绝对误差；5/10bp命中率是报价精度；优于基准比例是绝对误差更小的比例。市场方向采用±0.5bp中性区间，主表使用全部有效记录；另报非中性预测且实际非中性的筛选分母，不能以筛选后的方向比例充当公司择时胜率。",
        "",
        "## 3. 数据",
        "",
        f"可用目标债券{targets.bond_code.nunique()}笔，对应{intervals['events']}个定价日期；请求{len(current)}个时点，有效{int(metrics.samples)}个。{int((current.status == 'already_priced_excluded').sum())}个时点因已过定价日排除。30个提前量、多只同日债券高度相关，不视为独立样本。相同方案的我司真实连续发行仅{len(own_pairs)}对，全体发行人{len(pairs)}对。",
        "",
        "只纳入交易所固息、无含权、1—10年证券公司普通债或次级债。缺真实定价资料、含权债不进入；缺失造成的覆盖偏差必须保留。源数据是当前历史快照，缺少逐次发布版本，评级和发行方案是事后固定条件；2026已被观察，本轮不能宣称为新独立测试。官方发行日期修正（若提供）单独记录原值与来源，不改写原始快照。",
        "",
        "## 4. 模型与结果",
        "",
        "**全部候选，同一发行日口径**：",
        "",
        _table(
            overall,
            {
                "candidate": "候选",
                "samples": "有效记录",
                "mae_bp": "MAE(bp)",
                "rmse_bp": "RMSE(bp)",
                "within_5bp": "≤5bp",
                "within_10bp": "≤10bp",
            },
        ),
        "",
        "**T−1至T−30完整提前量表现**：",
        "",
        _table(
            selected,
            {
                "event_lead_days": "提前自然日",
                "samples": "笔数",
                "mae_bp": "MAE(bp)",
                "flat_mae_bp": "不变基准(bp)",
                "within_5bp": "≤5bp",
                "within_10bp": "≤10bp",
                "beat_flat_rate": "优于基准",
            },
        ),
        "",
        f"![各提前量票面误差]({(directory / 'horizon-mae.png').resolve()})",
        "",
        "**分年表现**：",
        "",
        _table(
            annual,
            {
                "year": "定价年份",
                "bonds": "债券数",
                "pricing_events": "定价事件",
                "mae_bp": "MAE(bp)",
                "flat_mae_bp": "不变基准(bp)",
                "within_10bp": "≤10bp",
            },
        ),
        "",
        "**分期限与券种**：",
        "",
        _table(
            terms,
            {
                "tenor": "期限(年)",
                "bond_type": "类型",
                "bonds": "债券数",
                "mae_bp": "MAE(bp)",
                "flat_mae_bp": "不变基准(bp)",
            },
        ),
        "",
        f"市场方向在全部{int(metrics.samples)}个记录上的正确率为{metrics.market_direction_accuracy:.1%}，恒预测下行基准为{metrics.always_down_direction_accuracy:.1%}。筛选非中性预测且实际非中性后为{metrics.direction_signal_accuracy:.1%}，分母缩小为{int(metrics.direction_signal_samples)}；相同筛选集恒预测下行为{metrics.direction_signal_always_down_accuracy:.1%}。所有这些都是二级AAA3Y方向，不能当作我司等待胜率。",
        "",
        "**真实两次发行之间的等待规则回放**（当时成熟校准对，非事后概率）：",
        "",
        _table(
            policy_summary,
            {
                "scope": "范围",
                "cost": "成本bp/日",
                "pairs": "真实发行对",
                "waits": "触发等待",
                "win_rate": "等待胜率",
                "gain_immediate": "较立即(bp)",
                "gain_deadline": "较一直等待(bp)",
            },
        ),
        "",
        "等待样本为0时胜率未定义，不报告为0%或100%。这是只有两个实际发行日期的条件回放，不是完整30天窗口选优或每日停止策略验证；缺少任意候选日的实际一级票面，不能视为完整反事实收益。",
        "",
        "**每笔发行T−30/T−1与真实票面**（单位%）：",
        "",
        _table(
            details,
            {
                "bond_code": "代码",
                "issue_date": "发行日",
                "pricing_date": "定价日",
                "tenor": "期限",
                "actual_percent": "真实票面",
                "T-30": "T−30预测",
                "T-1": "T−1预测",
            },
        ),
        "",
        "## 5. 分析与讨论",
        "",
        "不能为了让路径出现拐点而采用误差更大的模型，也不能因点预测最低日总在末尾就推荐等待。长期平均下行可以在历史下行样本中得到较高方向比例，却未必具有条件预测增益。当前更大的风险来自一级溢价与发行方案变化；公开/非公开发行方式尚未进入统一输入，跨方式比较存在混杂。",
        "",
        "票面、净节约和真实TreeSHAP继续保留；SHAP只解释树模型贡献，不证明漂移正确，也不解释全部一级溢价变化。可用的业务边界是票面预算、误差区间和询价复核；主动择时能力尚未通过验证。",
        "",
        "## 6. 后续改进方向",
        "",
        "先补齐公开/非公开、期限曲线、真实簿记/发行日期和当时承销询价，再比较同方案票面；在新前向时期同时保存模型与简单基准。拟上线的停止策略必须单独超过立即与固定截止日基准，并有足够非重叠触发案例，不能只放宽概率阈值制造交易。当前业务结论为按资金计划发行，模型供预算参考。",
        "",
        "## 7. 参考资料",
        "",
        "- protocol.json：输入、候选及信息边界；各候选manifest：代码与数据哈希。",
        "- all-paths.csv / bond-all-30-origins.csv：完整逐笔30个时点及排除状态。",
        "- horizons.csv / years.csv / terms.csv / premium-ablation.csv：期限、年份、方案及一级层比较。",
        "- primary-optimization-report.md / primary-optimization-assessment.json：一级层有限候选、历史滚动选择及研究准入结果；不自动替换生产。",
        "- all-issuer-pairs.csv / policy-replay.csv：实际配对与事前等待规则回放。",
        "- [scikit-learn 时序交叉验证](https://scikit-learn.org/stable/modules/cross_validation.html#time-series-split)：按时间排序，训练与评价隔离。",
        "",
        f"报告日期：{date.date()}。",
    ]
    (directory / "report.md").write_text("\n".join(lines) + "\n")
