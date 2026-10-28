"""Command-line arguments shared by all local model modes."""

import argparse
from pathlib import Path


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="交易所债券融资择时模型")
    parser.add_argument(
        "--curve-research", action="store_true", help="固定起点完整未来曲线与选日研究"
    )
    parser.add_argument(
        "--funding-history", type=Path, help="显式扩展行情CSV，仅用于曲线研究"
    )
    parser.add_argument(
        "--curve-target", choices=("AAA_3Y", "CREDIT_3Y"), default="AAA_3Y"
    )
    parser.add_argument(
        "--timing-research",
        action="store_true",
        help="直接学习尽快/等待/暂缓的成本差，嵌套时序调参与统计检验，不发布",
    )
    parser.add_argument(
        "--conditional-research",
        action="store_true",
        help="条件历史漂移与等待风险对照，仅研究，不发布",
    )
    parser.add_argument(
        "--issuance-backtest",
        action="store_true",
        help="统一真实票面回测：有限候选、月度重训、发行人留出",
    )
    parser.add_argument(
        "--backtest-output", type=Path, default=Path("outputs/issuance_backtest")
    )
    parser.add_argument(
        "--study-protocol",
        type=Path,
        help="冻结研究协议JSON：smoke/development/historical-report，须显式本地输入",
    )
    parser.add_argument(
        "--event-overrides",
        type=Path,
        help="带原始值与官方来源的发行日期核对表，仅用于事件回测",
    )
    parser.add_argument(
        "--issuance-forecast",
        action="store_true",
        help="生成当前及未来N天发行票面、区间与择时建议，本地保存",
    )
    parser.add_argument(
        "--window-days",
        type=int,
        default=30,
        choices=(30,),
        help="最多30自然日；预测T+1、T+14、T+30",
    )
    parser.add_argument(
        "--forecast-output", type=Path, default=Path("outputs/issuance_forecast")
    )
    parser.add_argument(
        "--market-model",
        choices=("unified_coupon",),
        default="unified_coupon",
    )
    parser.add_argument("--issuer", default="东方财富证券股份有限公司")
    parser.add_argument("--rating", default="AAA")
    parser.add_argument("--placement-type", choices=("公募", "私募"), default="公募")
    parser.add_argument(
        "--evaluation-dir", type=Path, help="数据/代码指纹匹配的统一票面回测缓存"
    )
    parser.add_argument("--tenor", type=float, default=3.0)
    parser.add_argument(
        "--bond-type", choices=("证券公司债", "证券公司次级债"), default="证券公司债"
    )
    parser.add_argument("--issue-size", type=float, default=30.0, help="发行规模，亿元")
    parser.add_argument(
        "--waiting-cost-bp-day",
        type=float,
        default=0.0,
        help="每延迟一天的年化票面等价成本，bp",
    )
    parser.add_argument(
        "--primary-research",
        action="store_true",
        help="一级票面定价的历史检验与当前报价研究，不上传",
    )
    parser.add_argument(
        "--refresh-pricing-metadata",
        action="store_true",
        help="显式补取现有债券定价日期、公告日期、发行时评级和最终票面",
    )
    parser.add_argument(
        "--rate-research",
        action="store_true",
        help="本地利率变化候选模型2022—2025滚动开发评估，不上传",
    )
    parser.add_argument(
        "--research-output",
        type=Path,
        default=Path("outputs/rate-research/development"),
        help="利率研究证据目录",
    )
    parser.add_argument(
        "--online",
        choices=("train", "infer"),
        help="新模型：训练导出 / JS 推理；生产结果由 Workflow 发布",
    )
    parser.add_argument(
        "--coupon-selection", type=Path, help="冻结公募最优模型及评价证据；不重新搜索"
    )
    parser.add_argument("--bundle-dir", type=Path, default=Path("outputs/online"))
    parser.add_argument("--as-of", help="上海模型日期 YYYY-MM-DD，全部输入严格早于该日")
    parser.add_argument("--input-snapshot", type=Path, help="重放已保存的线上原始输入")
    parser.add_argument(
        "--no-upload",
        action="store_true",
        help="本地运行不发布；线上发布统一由 Workflow 执行",
    )
    parser.add_argument("--output", type=Path, help="另存新模型 JSON 的路径")
    args = parser.parse_args(argv)
    if args.study_protocol and not (args.issuance_backtest and args.input_snapshot):
        parser.error(
            "--study-protocol requires --issuance-backtest and --input-snapshot"
        )
    return args
