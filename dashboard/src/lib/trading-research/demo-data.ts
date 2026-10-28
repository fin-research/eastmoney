export type WorkbenchViewId =
  | "overview"
  | "trading"
  | "market-hotspots"
  | "tracking-commentary"
  | "policy-tracking"
  | "research"
  | "workflow"
  | "interbank-ledger"
  | "secondary-bond-pool"
  | "bond"
  | "financing-model";

export type WorkbenchIconName =
  | WorkbenchViewId
  | "credit"
  | "calendar"
  | "check"
  | "database"
  | "funds"
  | "menu"
  | "user"
  | "search"
  | "sidebar"
  | "chat"
  | "plus"
  | "arrow-up"
  | "file"
  | "download"
  | "copy"
  | "warning";

export const workbenchRoutes: Array<{
  id: WorkbenchViewId;
  label: string;
  title: string;
  context: string;
  icon: WorkbenchIconName;
}> = [
  {
    id: "overview",
    label: "总览",
    title: "总览",
    context: "交易、授信、研究与流程的多基准日快照",
    icon: "overview",
  },
  {
    id: "trading",
    label: "交易管理",
    title: "交易管理",
    context: "同业拆借（纯信用）与拆出（质押式回购）",
    icon: "trading",
  },
  {
    id: "market-hotspots",
    label: "市场热点",
    title: "市场热点",
    context: "研报热点与关联证据",
    icon: "market-hotspots",
  },
  {
    id: "policy-tracking",
    label: "政策跟踪",
    title: "政策跟踪",
    context: "政策资讯与研究点评",
    icon: "policy-tracking",
  },
  {
    id: "tracking-commentary",
    label: "跟踪点评",
    title: "跟踪点评",
    context: "点评撰写与历史档案",
    icon: "tracking-commentary",
  },
  {
    id: "research",
    label: "研究辅助",
    title: "研究辅助",
    context: "国内宏观、海外利率与全球风险资产走势",
    icon: "research",
  },
  { id: "interbank-ledger", label: "拆借台账", title: "拆借台账", context: "拆借归档与资金系统", icon: "trading" },
  {
    id: "workflow",
    label: "交易流程",
    title: "交易流程",
    context: "日内交易流程",
    icon: "workflow",
  },
  {
    id: "secondary-bond-pool",
    label: "二级池周报",
    title: "二级池周报",
    context: "规模杠杆、收益创收与资产期限结构",
    icon: "secondary-bond-pool",
  },
  {
    id: "bond",
    label: "二级池",
    title: "二级池",
    context: "逐日收益、持仓结构与成交复盘",
    icon: "bond",
  },
  {
    id: "financing-model",
    label: "融资择时模型",
    title: "融资择时模型",
    context: "融资成本、发行窗口与卖方观点",
    icon: "financing-model",
  },
];

export const workbenchViews = workbenchRoutes.filter(
  (view) => view.id !== "bond" && view.id !== "workflow" && view.id !== "interbank-ledger",
);

export function normalizeWorkbenchView(
  value: string | null | undefined,
): WorkbenchViewId {
  return workbenchRoutes.some((view) => view.id === value)
    ? (value as WorkbenchViewId)
    : "overview";
}

export function workbenchViewPath(view: WorkbenchViewId): string {
  return view === "overview"
    ? "/trading-research"
    : `/trading-research/${view}`;
}

export const demoMeta = {
  importedAt: "2026-08-25",
  tradingAsOf: "2026-08-07 15:00",
} as const;

export type DemoTrade = {
  id: string;
  time: string;
  direction: "融入" | "融出";
  product: "同业拆借" | "质押式回购";
  counterparty: string;
  amount: number;
  term: string;
  rate: number;
  collateral: string;
  collateralRisk: "不适用" | "资料待补录";
  status: "已成交" | "待确认";
};

export const demoTrades: DemoTrade[] = [
  { id: "T20260807001", time: "09:32", direction: "融入", product: "同业拆借", counterparty: "招商银行", amount: 5, term: "7D", rate: 1.85, collateral: "—", collateralRisk: "不适用", status: "已成交" },
  { id: "T20260807002", time: "09:45", direction: "融入", product: "同业拆借", counterparty: "工商银行", amount: 3, term: "14D", rate: 1.92, collateral: "—", collateralRisk: "不适用", status: "已成交" },
  { id: "T20260807003", time: "10:10", direction: "融出", product: "质押式回购", counterparty: "中信证券", amount: 2, term: "隔夜", rate: 1.65, collateral: "国债", collateralRisk: "资料待补录", status: "已成交" },
  { id: "T20260807004", time: "10:28", direction: "融入", product: "同业拆借", counterparty: "建设银行", amount: 8, term: "7D", rate: 1.83, collateral: "—", collateralRisk: "不适用", status: "已成交" },
  { id: "T20260807005", time: "10:55", direction: "融出", product: "同业拆借", counterparty: "华泰证券", amount: 1.5, term: "7D", rate: 1.88, collateral: "—", collateralRisk: "不适用", status: "已成交" },
  { id: "T20260807006", time: "11:05", direction: "融出", product: "质押式回购", counterparty: "农业银行", amount: 10, term: "1M", rate: 1.95, collateral: "利率债", collateralRisk: "资料待补录", status: "待确认" },
  { id: "T20260807007", time: "11:22", direction: "融入", product: "同业拆借", counterparty: "交通银行", amount: 4, term: "隔夜", rate: 1.62, collateral: "—", collateralRisk: "不适用", status: "已成交" },
  { id: "T20260807008", time: "13:15", direction: "融出", product: "质押式回购", counterparty: "国泰君安", amount: 3, term: "14D", rate: 1.9, collateral: "国债", collateralRisk: "资料待补录", status: "已成交" },
  { id: "T20260807009", time: "14:02", direction: "融入", product: "同业拆借", counterparty: "兴业银行", amount: 6, term: "7D", rate: 1.86, collateral: "—", collateralRisk: "不适用", status: "已成交" },
  { id: "T20260807010", time: "14:30", direction: "融出", product: "质押式回购", counterparty: "浦发银行", amount: 2.5, term: "隔夜", rate: 1.6, collateral: "信用债", collateralRisk: "资料待补录", status: "待确认" },
];

export function computeTradingSummary(trades: DemoTrade[]) {
  const totalAmount = trades.reduce((sum, trade) => sum + trade.amount, 0);
  const interbankAmount = trades
    .filter((trade) => trade.product === "同业拆借")
    .reduce((sum, trade) => sum + trade.amount, 0);
  const repoLendAmount = trades
    .filter((trade) => trade.product === "质押式回购" && trade.direction === "融出")
    .reduce((sum, trade) => sum + trade.amount, 0);
  const weightedRate = totalAmount
    ? trades.reduce((sum, trade) => sum + trade.amount * trade.rate, 0) /
      totalAmount
    : 0;

  return {
    tradeCount: trades.length,
    totalAmount,
    interbankAmount,
    repoLendAmount,
    interbankShare: totalAmount ? (interbankAmount / totalAmount) * 100 : 0,
    weightedRate,
    pendingCount: trades.filter((trade) => trade.status === "待确认").length,
  };
}

export const tradingSummary = computeTradingSummary(demoTrades);

export const fundingOverview = {
  borrowTotal: 185.2,
  lendTotal: 142.8,
  total: 328,
} as const;

export const overviewCreditFallback = {
  reportDate: "2026-08-21",
  institutionCount: 120,
  approvedCount: 110,
  totalLimit: 3448.35,
  totalUsed: 1022.5955,
  totalAvailable: 2425.7545,
  utilization: 29.7,
  expiringWithin30Days: 8,
} as const;

export const secondaryPoolSnapshot = {
  principal: 55.2,
  marketValue: 55.34,
  annualizedReturn: 2.45,
  dailyRevenue: 94.88,
  positionCount: 49,
} as const;

export const fundingTrend = {
  dates: [
    "07-01", "07-04", "07-07", "07-10", "07-13", "07-16", "07-19",
    "07-22", "07-25", "07-28", "07-31", "08-03", "08-05", "08-06", "08-07",
  ],
  series: [
    {
      name: "融入",
      values: [176.4, 178.8, 174.6, 179.2, 181.5, 180.1, 182.8, 184.3, 181.9, 183.7, 186.1, 184.6, 183.2, 185.0, 185.2],
      color: "#f79009",
    },
    {
      name: "融出",
      values: [131.2, 133.8, 135.1, 132.4, 136.7, 138.5, 137.3, 139.8, 141.1, 140.4, 139.6, 141.7, 140.9, 131.8, 142.8],
      color: "#2f6fed",
    },
  ],
} as const;

export const tradeVolumeHistory = {
  dates: [
    "07-20", "07-21", "07-22", "07-23", "07-24", "07-27", "07-28", "07-29",
    "07-30", "07-31", "08-03", "08-04", "08-05", "08-06", "08-07",
  ],
  series: [
    {
      name: "同业拆借（纯信用）",
      values: [24.2, 21.8, 28.5, 23.1, 26.4, 30.2, 22.7, 25.9, 31.4, 27.6, 29.8, 24.6, 26.1, 28.9, 27.5],
      color: "#2f6fed",
    },
    {
      name: "拆出（质押式回购）",
      values: [12.6, 14.3, 11.8, 16.2, 13.5, 15.1, 18.4, 12.9, 14.8, 16.7, 13.2, 17.5, 15.6, 19.1, 17.5],
      color: "#f79009",
    },
  ],
} as const;

export const termDistribution = ["隔夜", "7D", "14D", "1M", "3M", "6M", "1Y"].map(
  (term) => ({
    label: term,
    value: demoTrades
      .filter((trade) => trade.term === term)
      .reduce((sum, trade) => sum + trade.amount, 0),
  }),
);

export type DemoAlert = {
  id: string;
  level: "critical" | "high" | "medium" | "low";
  category: "交易" | "授信" | "市场";
  owner: string;
  eventAt: string;
  text: string;
};

export const overviewAlerts: DemoAlert[] = [
  { id: "ALR-002", level: "high", category: "交易", owner: "资金交易岗", eventAt: "2026-08-07 14:35", text: "质押式回购拆出待确认2笔、合计12.5亿元，需完成押券准入与估值折算复核" },
  { id: "ALR-004", level: "medium", category: "市场", owner: "研究岗", eventAt: "2026-08-07 13:00", text: "DR007较前值下行0.59个基点，关注跨月前资金面变化" },
  { id: "ALR-006", level: "low", category: "授信", owner: "授信管理岗", eventAt: "2026-08-21 09:00", text: "部分机构授信额度使用率超过60%关注线，需核对后续业务安排" },
  { id: "ALR-007", level: "high", category: "授信", owner: "授信管理岗", eventAt: "2026-08-21 09:00", text: "未来30日存在授信到期事项，需提前安排续作材料" },
];

export type DemoRate = {
  label: string;
  value: number;
  previous: number;
  changeBp: number;
};

export const researchSnapshot = {
  validation: {
    status: "pass",
    passedChecks: 10,
    mode: "规则模板",
    ruleVersion: "研究规则 0.1",
    reviewStatus: "待复核",
  },
  rates: [
    { label: "DR001", value: 1.3611, previous: 1.3634, changeBp: -0.23 },
    { label: "DR007", value: 1.3858, previous: 1.3917, changeBp: -0.59 },
    { label: "R001", value: 1.3813, previous: 1.3827, changeBp: -0.14 },
    { label: "R007", value: 1.4119, previous: 1.4206, changeBp: -0.87 },
    { label: "GC001", value: 0.957, previous: 1.27, changeBp: -31.3 },
    { label: "GC007", value: 1.391, previous: 1.411, changeBp: -2 },
  ] satisfies DemoRate[],
  history: {
    dates: ["08-03", "08-04", "08-05", "08-06", "08-07", "08-10", "08-11", "08-12", "08-13", "08-14"],
    dr007: [1.4204, 1.3816, 1.3738, 1.3816, 1.3881, 1.3953, 1.3925, 1.3959, 1.3917, 1.3858],
    r007: [1.4395, 1.4196, 1.4181, 1.4122, 1.4092, 1.4132, 1.4181, 1.4262, 1.4206, 1.4119],
    gc001: [1.506, 1.45, 1.366, 1.321, 1.015, 1.446, 1.421, 1.405, 1.27, 0.957],
  },
  cdCurve: [
    { tenor: "1月", value: 1.385, changeBp: -0.5 },
    { tenor: "3月", value: 1.425, changeBp: 0 },
    { tenor: "6月", value: 1.455, changeBp: 0.42 },
    { tenor: "9月", value: 1.4725, changeBp: 0.11 },
    { tenor: "1年", value: 1.48, changeBp: 0.2 },
  ],
  govCurve: [
    { tenor: "1年", value: 1.2065, changeBp: 0.22 },
    { tenor: "3年", value: 1.2607, changeBp: -0.81 },
    { tenor: "5年", value: 1.3935, changeBp: -1.38 },
    { tenor: "7年", value: 1.523, changeBp: -1.38 },
    { tenor: "10年", value: 1.6964, changeBp: -1.5 },
    { tenor: "30年", value: 2.1644, changeBp: -1.37 },
  ],
  unavailable: [
    { label: "SHIBOR 曲线", reason: "当前底稿未提供可核验 SHIBOR 曲线" },
    { label: "公开市场操作", reason: "当前底稿未提供逐日 OMO 操作明细" },
    { label: "政策卡片", reason: "当前底稿未提供政策原文及来源" },
    { label: "国内高频指标", reason: "当前底稿未覆盖高频宏观指标" },
    { label: "海外市场指标", reason: "当前底稿未覆盖海外市场指标" },
  ],
} as const;

export const workflowDemos = [
  {
    id: "FLOW-T20260807001",
    type: "交易流程",
    title: "招商银行 7D 同业拆借",
    businessKey: "T20260807001",
    detail: "2026年8月7日，与招商银行开展5亿元7天同业拆借，利率1.85%。",
    state: "投资经理复核",
    currentStep: 1,
    steps: ["交易员提交", "投资经理复核", "合规复核", "部门负责人复核", "交易员归档"],
  },
  {
    id: "FLOW-CREDIT-20260821",
    type: "授信周报",
    title: "授信周报（截至2026-08-21）",
    businessKey: "CREDIT-20260821",
    detail: "授信总额度3448.35亿元，已使用1022.5955亿元，可用额度2425.7545亿元。",
    state: "授信主管复核",
    currentStep: 1,
    steps: ["授信专员提交", "授信主管复核", "周报待导出", "已导出"],
  },
] as const;
