# 系统架构

## 运行单元

项目由 SvelteKit 应用和自定义 Cloudflare Worker 入口组成。`worker/entry.ts` 承载构建后的 SvelteKit Worker，并注册 `MarketBriefingWorkflow`。静态资源由 Worker Assets 提供。

Worker Assets 只承载随应用版本一起构建、发布的前端资源。资金日报每日独立上传，须在运行时立即生效。文件存入 R2，不写入构建目录，不触发 Worker 重新发布。

跨服务拓扑、生产路由、上游访问和身份所有权只在 [共享架构](../../docs/ARCHITECTURE.md) 维护。这里仅描述 Dashboard 内部结构。页面按 [模块分流](../AGENTS.md#context-routing) 读取。

```text
页面组件 → 浏览器安全的派生层 / 图表
路由与 hooks → 统一身份授权 → 领域 service → repository / 存储 adapter
worker/entry.ts → GatewayDashboard / SvelteKit / Workflow / CreditAgent / ScheduledTasks / NotificationSource
```

## 页面与派生层

- `src/routes/` 负责页面装配、路由参数和 HTTP 边界，不承载复杂业务计算。
- `src/App.svelte` 保留市场点评的整体报告装配。
- `src/lib/ai-client.svelte.ts` 是浏览器发起 AI 请求的唯一入口，统一解析 SSE、取消请求并在当前标签页内保留任务 summary 与完整终态结果。根 layout 挂载 `AiPanel.svelte`，在所有页面提供固定 AI 入口、任务列表与可进入的详情面板，并统一发布生成完成通知。业务页面只提交任务标题、路由、请求参数与终态 Schema，不自行解析流。
- `src/api.ts` 只 GET 完整 R2 市场点评定稿。无定稿明确失败，不触发原始资源或 AI。默认报告日由服务端按上海 17:00 截止时点及周一至周五选日，不查询交易所日历。
- `src/market-report-resources.ts` 维护市场点评筛选、合并和换算，供后台 Workflow 汇总唯一 `ReportData`，视觉与文字版只做展示派生。
- `src/report-view.ts` 将 API 已规范的最小报告字段投影为视觉数据。
- `src/text-report.ts` 从同一份归档报告数据派生只读文字版。不得保存完整文字版或建立第二套数据源。
- `src/charts/` 只负责图表配置和图形表达。业务筛选应位于视图派生层。
- `/credit-workbench` 的授信报表通过 `/api/credit` 读取 Neon `credit` 日报。交易研究工作台总览复用其最新可用额度。研究辅助通过 `/api/economic-indicators` 和 Hyperdrive 读取 Neon `public.edb`。融资工作台的负债周报也只读这张公共表。

  Choice EDB 与 DM 只由首次本地全历史回填及每日增量 Cron 调用。交易管理仍读取 `src/lib/trading-research/demo-data.ts`。交易流程通过 `/api/trading-workflow/config` 读写 D1 节点配置，通过 `/api/trading-workflow/day` 读写当日调度进度。询价记录和名单仍在浏览器本地，二级池与融资择时复用原页面组件及既有数据链路。

  具体边界见 `docs/TRADING_RESEARCH_WORKBENCH.md`。
- `/trading-research/policy-tracking` 只读 ingest Workflow 已聚合的政策、面向境内资金/利率研究的三档重要性与自动研报关系。人工调整关系通过同源 `/api/policies/*` 写 D1。生成与编辑归集到跟踪点评工作台 `/trading-research/tracking-commentary`，并保留旧 API 兼容。页面加载和筛选不调用模型。政策资讯、关联研报与点评分别使用 `/news/[id]`、`/articles/[id]`、`/commentaries/[id]` 独立深链。政策资讯详情读取 D1 已归档的 DM 原文与政策原文链接，研报详情通过 Worker 的 `DATA` Service Binding 获取正文，点评详情只读 D1。

- 交易研究工作台与授信工作台使用同一 `src/lib/workbench/WorkbenchShell.svelte`。市场热点和政策跟踪由 `src/lib/pages/` 维护单一业务组件，在工作台内使用嵌入布局。旧独立入口仅做兼容跳转。公开授信材料问答使用全站 AI 侧栏。旧独立入口重定向到门户并打开侧栏。

## 服务端模块

- 全站 AI 侧栏在浏览器运行工具循环，通过 `/api/ai/responses` 和 `/api/mcp` 查询公开授信 PDF。`CreditAgent` 的 HTTP/DO 仅保留旧会话兼容，见 [授信材料](CREDIT_ASSISTANT.md)。

- `src/lib/server/hotspots.ts` 读取结构化证据并调用模型。
- `src/lib/server/hotspot-snapshots.ts` 负责最新快照读取、范围校验与追加写入。
- `src/lib/server/market-briefing.ts` 通过 `DATA` Service Binding 分别从 `/data/stock-summary`、`/data/news` 和新闻详情取材。新闻详情保持最多 5 个并发，在 Dashboard Worker 组装提示词并生成今日聚焦。
- `src/lib/server/market-report.ts` 负责完整定稿的按日 R2 读取、Workflow 写入与旧接口兼容覆盖，读取和写入都经同一快照 Schema 校验，不查询 Data API。
- `src/lib/server/data-news.ts` 通过 `DATA` Service Binding 有界读取并校验单篇研报正文，供研报详情和政策点评生成复用。
- `src/lib/server/ai-gateway.ts` 是生成式模型唯一适配器。传输契约见 [共享 AI](../../docs/AI.md)，业务 Prompt 和 Schema 留在调用模块。
- `src/lib/server/ai-stream.ts` 在公开 reasoning summary 离开 Worker 前移除 Markdown 加粗标记。`src/lib/server/ai-sse.ts` 是前端交互式 AI 的统一 Worker 流边界，客户端只接收纯文本 `progress`、完整 JSON `result` 或纯文本 `error`，保活使用 SSE 注释帧。
- `src/lib/server/bond-ledger.ts` 处理台账直接导入、R2 原件与下载边界。
- Gateway 拥有 Auth0 个人信息与角色权限服务。Dashboard `/management/me` 保留资料界面，旧 `/profile` 重定向至该页。`/api/profile` 由 Gateway 直接处理，后端兼容转发使用 `IDENTITY` binding。
- `src/lib/server/fund-report.ts` 校验并归档资金日报 HTML，枚举固定前缀生成历史列表，并按确定性的日期 key 从 R2 读取单期日报。
- `src/lib/server/bond-ledger-repository.ts` 封装 `bond` schema SQL。`src/lib/server/postgres.ts` 管理短生命周期连接。
- `src/lib/server/credit-repository.ts` 封装 `credit` schema 的报表日导入、机构增量保存、历史日期读取、日历事件和相邻报告日比较。Worker 复用短生命周期 PostgreSQL 连接。
- `src/lib/server/issuance-model-repository.ts` 从新版结构化表重建票面快照，增量更新同一运行的当前整体结论，并追加卖方观点和逻辑汇总修订。`src/lib/server/financing-model-research.ts` 按 [共享 AI](../../docs/AI.md) 调用 AI Search MCP，再通过统一 AI Gateway 生成结构化卖方逻辑汇总。

## 模块数据流

- 工作台装配、交易范围与交易流程配置与进度边界：[交易研究工作台](TRADING_RESEARCH_WORKBENCH.md)。
- 授信日报导入、显式保存、事件比较：[授信模块](modules/credit-workbench.md)。
- 经济数据回填、增量同步、研究与周报共享读取：[研究辅助](modules/research-assistance.md)。
- 研究资讯、研报和点评详情来源：[详情模块](modules/research-details.md)。
- Quant 快照及人工结论分工：[共享数据库](../../docs/DATABASE.md#融资模型跨仓库写入)。

## 依赖规则

- 浏览器模块不得导入 `$lib/server` 或直接访问 D1、R2、Hyperdrive。
- 图表模块不得自行请求数据。
- 路由 handler 保持轻薄。可复用校验和业务逻辑放入 `src/lib`。
- Workflow 代码留在 `worker/`，避免 Cloudflare runtime 类型污染浏览器 TypeScript 环境。
- 新增报告口径先扩展共享派生层和测试，再接入视觉或文字消费者。

具体页面规则和接口见 [模块分流](../AGENTS.md#context-routing)，不在公共文档重复维护。

## 融资模块合并

Dashboard 是唯一 UI/API Worker。融资领域位于 `src/lib/financing/`（浏览器安全代码）、`src/lib/server/financing/`（融资查询与数据访问）、`src/routes/financing/`（路由）和 `src/charts/financing/`（报表图表）。管理页面位于 `src/routes/management/`。共享 UI 只由既有 `WorkbenchShell`、`MetricCard`、`ModuleCard`、`PanelHeading`、`ChartHost`、`GlobalMessages` 维护。

融资人员授权查询、提醒查询、报表生成和数据库连接均不能放进全站根 layout。仅融资业务导航执行融资授权与集合查询。重型导入解析器留在浏览器 Web Worker，报表动作客户端按路由加载。Finance 的 CSS 限定 `.financing-scope`，其颜色与表面映射 Dashboard 令牌，不能在导航后污染门户和报告。

融资与二级池均由浏览器本地解析、线上直接执行原子导入，旧导入 Workflow 已退役。Messenger 持有唯一分钟 Cron，经私有 ScheduledTasks 触发市场点评与 Data 经济同步。Dashboard 不配置 Cron。融资与交易提醒经私有 NotificationSource 扫描。迁移不会改变 Quant、Data、Ingest 或其他上游接口。

Gateway 在私有 `GatewayDashboard` 中传入唯一身份。hooks 设置 `locals.user` 及 `user.authorization`。融资领域只使用该统一身份与权限。`src/lib/identity.ts` 定义身份及客户端 DTO，基础 subject、邮箱和认证有效期不被业务缓存替换。

统一权限与 JWT 验证位于独立 Gateway。Dashboard/Data 无公网路由、workers.dev 或 preview，默认入口 404。Dashboard 经 `IDENTITY: IdentityService` 调用账号目录/角色配置，业务层保留输入、记录归属及 RLS。Gateway 与应用绑定边界见 [共享架构](../../docs/ARCHITECTURE.md)。
