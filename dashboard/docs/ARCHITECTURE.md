# 系统架构

跨服务拓扑、生产路由、上游访问和身份所有权见 [共享架构](../../docs/ARCHITECTURE.md)。本文只描述 Dashboard 内部结构。

## 运行单元

SvelteKit 应用由自定义 Worker 入口 `worker/entry.ts` 承载，入口导出：

- `GatewayDashboard`：Gateway 的命名 Service Binding 入口，承接 UI、业务 API 和 actions。
- `MarketBriefingWorkflow`：市场点评编排。
- `CreditAgent`：授信助手历史会话 Durable Object。
- `ScheduledTasks`、`NotificationSource`：Messenger 分钟 Cron 的分派目标和提醒名单来源。Dashboard 不配置 Cron。

静态资源由 Worker Assets 提供，随应用版本发布。资金日报每日独立上传并须立即生效，所以存入 R2，不进构建目录。

```text
页面组件 → 浏览器安全的派生层 / 图表
路由与 hooks → 统一身份授权 → 领域 service → repository / 存储 adapter
```

## 分层

- `src/routes/` 负责页面装配、路由参数和 HTTP 边界，不承载复杂业务计算。可复用校验和业务逻辑放入 `src/lib`。
- `src/App.svelte` 装配市场点评整体报告。
- `src/lib/ai-client.svelte.ts` 是浏览器发起 AI 请求的唯一入口，负责解析 SSE、取消请求，并在当前标签页保留任务 summary 与终态结果。业务页只提交任务标题、路由、参数与终态 Schema。
- 根 layout 挂载 `AiPanel.svelte`，提供固定 AI 入口、任务列表、详情面板和完成通知。
- `src/charts/` 只负责图表配置，业务筛选在视图派生层。图表模块不自行请求数据。
- Workflow 代码留在 `worker/`，避免 Cloudflare runtime 类型进入浏览器 TypeScript 环境。
- 浏览器模块不导入 `$lib/server`，不直接访问 D1、R2、Hyperdrive。

## 市场点评数据流

- 后台 Workflow 经 `DATA` Service Binding 取材，`src/market-report-resources.ts` 汇总唯一 `ReportData` 并写入 R2 定稿。
- `src/api.ts` 只 GET R2 定稿，无定稿明确失败，不触发原始资源或 AI。
- `src/report-view.ts` 把定稿投影为视觉数据，`src/text-report.ts` 从同一份数据派生文字版。不保存完整文字版，不建第二套数据源。
- 新增报告口径先扩展共享派生层和测试，再接入视觉或文字消费者。
- 今日聚焦由 `src/lib/server/market-briefing.ts` 取材并生成。新闻详情有界并发读取，复用 `src/lib/server/data-news.ts`。

页面行为见 [市场点评](modules/market-briefing.md) 和 [今日聚焦](modules/market-focus.md)。

## 其他数据流

- 授信报表经 `/api/credit` 读 Neon `credit`，交易研究总览复用其最新可用额度。见 [授信工作台](modules/credit-workbench.md)。
- 研究辅助经 `/api/economic-indicators` 和 Hyperdrive 读 Neon `public.edb`，融资负债周报只读同一张表。Choice EDB 与 DM 只由 Data 的回填和每日增量调用。见 [研究辅助](modules/research-assistance.md)。
- 交易流程经 `/api/trading-workflow/*` 读写 D1，交易管理数据仍读 `src/lib/trading-research/demo-data.ts`。见 [交易研究工作台](TRADING_RESEARCH_WORKBENCH.md)。
- 政策跟踪只读 Ingest 已聚合的政策、三档重要性和自动研报关系，人工关系经 `/api/policies/*` 写 D1。页面加载和筛选不调用模型。见 [政策跟踪](modules/policy-tracking.md)。
- 研报详情经 `DATA` 获取正文，政策资讯详情读 D1 已归档的 DM 原文，点评详情只读 D1。见 [详情](modules/research-details.md)。
- Quant 快照与人工结论分工见 [共享数据库](../../docs/DATABASE.md#融资模型跨仓库写入)。
- 交易研究与授信工作台共用 `src/lib/workbench/WorkbenchShell.svelte`。市场热点、政策跟踪的单一业务组件在 `src/lib/pages/`，工作台内用嵌入布局，旧独立入口只做跳转。

## AI 与服务端模块

- `src/lib/server/ai-gateway.ts` 是生成式模型唯一适配器，传输契约见 [共享 AI](../../docs/AI.md)，业务 Prompt 与 Schema 留在调用模块。
- `src/lib/server/ai-sse.ts` 是交互式 AI 的 Worker 流边界，`ai-stream.ts` 在公开 summary 离开 Worker 前去除 Markdown 加粗标记。协议见 [共享 AI](../../docs/AI.md#前端-sse)。
- 全站 AI 侧栏在浏览器运行工具循环，经 `/api/ai/responses` 和 `/api/mcp` 查询公开授信 PDF。`CreditAgent` 的 HTTP/DO 只保留历史会话，见 [授信助手](CREDIT_ASSISTANT.md)。
- 传导图：`knowledge-graph.ts` 读 `node` / `claim`，按时间衰减聚合边与传导链，不调用模型。图形经 `charts/knowledge-graph.ts` 与 `ChartHost` 绘制，布局在 `lib/graph-layout.ts`。
- 融资择时：`issuance-model-repository.ts` 从结构化表重建票面快照并追加卖方观点修订，`financing-model-research.ts` 经 AI Search MCP 检索，再由 AI Gateway 生成结构化汇总。
- 存储 adapter：`bond-ledger*.ts`（二级池）、`credit-repository.ts`（`credit` schema）、`fund-report.ts`（R2 资金日报）、`postgres.ts`（短生命周期连接）。
- 个人资料、角色与账号目录由 Gateway 提供，Dashboard 经 `IDENTITY` 访问。`/api/profile` 由 Gateway 直接处理。

## 融资模块合并

Dashboard 是唯一 UI/API Worker。融资代码在 `src/lib/financing/`（浏览器安全）、`src/lib/server/financing/`、`src/routes/financing/` 和 `src/charts/financing/`，管理页在 `src/routes/management/`。共享 UI 复用 `WorkbenchShell`、`MetricCard`、`ModuleCard`、`PanelHeading`、`ChartHost`、`GlobalMessages`。

- 融资人员授权、提醒查询、报表生成和数据库连接不进全站根 layout，只由融资导航触发。
- 重型导入解析器留在浏览器 Web Worker，报表动作客户端按路由加载。
- 融资 CSS 限定 `.financing-scope`，颜色与表面映射 Dashboard 令牌。
- 融资与二级池由浏览器本地解析、线上原子导入，无导入 Workflow。
- Messenger 持有唯一分钟 Cron，经 `ScheduledTasks` 触发市场点评与 Data 经济同步。融资与交易提醒经 `NotificationSource` 扫描。
- Gateway 在 `GatewayDashboard` 传入唯一身份，hooks 设置 `locals.user` 与 `user.authorization`。`src/lib/identity.ts` 定义身份及客户端 DTO。规则见 [SECURITY](SECURITY.md)。
