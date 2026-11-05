# AGENTS.md

## Project Overview

债券市场研究全栈应用：市场点评、市场热点、二级池周报、授信工作台、融资业务管理和交易研究工作台。技术栈为 SvelteKit、Svelte 5、TypeScript、Tailwind CSS 4、shadcn-svelte Maia、Bits UI、svelte-sonner、TanStack Table、ECharts、Cloudflare Workers/D1/R2/Workflows/Hyperdrive、Neon PostgreSQL 与 AI Gateway。

融资入口 `/financing`（仪表盘、负债周报、项目、SOP、台账）。管理入口 `/management/me`、`/management/permissions`、`/management/notifications`，管理员另有 `/management/people`、`/management/messenger`。`/management` 和 `/profile` 重定向到 `/management/me`。

精确路由以 `src/routes/` 和 `worker/entry.ts` 为准。

## Mandatory Rules

- 修改前先搜索现有页面、组件、图表、派生函数和测试，优先复用。
- UI 变更先读 [DESIGN](DESIGN.md)，保持桌面布局和移动端模块顺序。前端不加解释性小字和口径扩写，交互说明用控件、状态与布局表达。
- 跨服务路由、DATA / InternalData 与身份所有权见 [共享架构](../docs/ARCHITECTURE.md)。
- 市场点评的 REST 编排、视觉与文字共用契约、旧资源兼容见 [市场点评](docs/modules/market-briefing.md)。业务加工留在 Dashboard。
- Data 消费端用 `src/data-contracts.ts` 的 Zod Schema 校验最小 DTO，字段投影与分页遵循 [Data API](../data/docs/API.md)，不透传上游 envelope。新闻详情扇出保持有界并发，复用 `src/lib/server/data-news.ts`。
- 身份只用 Gateway 私有入口注入的 `locals.user`，权限只用 `user.authorization`。应用不验证 JWT。记录归属和业务规则仍在应用内校验。详见 [SECURITY](docs/SECURITY.md)。
- 一级发行的视觉与文字输出共用 `src/primary-issues.ts`。
- 市场热点页直接展示近期研报因果传导图，只读 D1 `node` / `claim`，不调用模型，不写快照。
- 二级池 Excel 在浏览器 Web Worker 解析，线上校验后归档原件，经 Hyperdrive 单事务写入 Neon，无导入 Workflow。
- D1 / Neon / R2 所有权和跨仓库 migration 见 [共享数据库](../docs/DATABASE.md)。本地连接、日期和导入一致性见 [DATABASE](docs/DATABASE.md)。
- 生成式 AI 只经 `src/lib/server/ai-gateway.ts`。传输、重试与检索见 [共享 AI](../docs/AI.md)，业务 Prompt 和 Schema 留在目标模块。
- 融资模型的 Quant / Dashboard 写入分工见 [共享数据库](../docs/DATABASE.md#融资模型跨仓库写入)，页面契约见 [融资模型](docs/modules/financing-model.md)。
- 卖方观点用研究库检索，授信助手用独立授信材料库，证据来源和权限不通用。见融资模型模块与 [授信助手](docs/CREDIT_ASSISTANT.md)。
- `worker-configuration.d.ts` 是生成文件。绑定变化后运行 `pnpm worker:typegen`。
- `pnpm dev` 不同步远程 D1。需要本地证据时才运行 `pnpm db:sync:remote`。
- 推送前，代码变更运行 `pnpm check:quick` 和直接相关的轻量单元测试，纯文档修改运行 `git diff --check`。视觉改动用 `pnpm visual:local` 审阅受影响页，完整验收由合并队列的 `Dashboard CI` 执行。见 [DEVELOPMENT](docs/DEVELOPMENT.md) 和 [TESTING](docs/TESTING.md)。
- 前端、共享 UI、API 契约及影响页面输出的改动，由新的子代理交付。子代理提交并推送任务分支，创建或更新 PR，加入合并队列并核对 CI。失败证据交回主代理修复。流程见 [DEVELOPMENT](docs/DEVELOPMENT.md)，CI 等待见 [CI 等待与收尾](docs/TESTING.md#ci-等待与收尾)。

## Commands

- 安装：`pnpm install`
- 开发：`pnpm dev`
- 类型检查：`pnpm typecheck`
- 推送前快速检查：`pnpm check:quick`
- 单元测试：`pnpm test`
- 生产构建：`pnpm build`
- Worker 本地运行：`pnpm worker:dev`
- Worker 类型：`pnpm worker:typegen`
- D1 migration：`pnpm db:migrate:local` / `pnpm db:migrate:remote`
- 同步远程 D1：`pnpm db:sync:remote`
- Neon migration：`pnpm bond:db:migrate`（二级池）、`pnpm financing-model:db:migrate`（融资择时）、`pnpm credit:db:migrate`（授信）
- 台账回填盘点：`pnpm bond:db:backfill`，加 `--apply` 才写入
- 部署：PR 经合并队列后合入 `main`，由 Cloudflare Git 自动构建部署。自动构建失败时用 `pnpm worker:deploy -- --reason=<原因>` 补发。部署后核对线上版本和受影响路由。见 [DEVELOPMENT](docs/DEVELOPMENT.md#发布)。

## Context Routing

项目组规则见 [项目组 AGENTS](../AGENTS.md)。只加载任务相关文档，跨模块只加读受影响部分。

- 页面、API、业务或定时任务：先定位唯一模块文档，再叠加专题。兼容入口复用目标模块规范。
- 门户 `/` 读 [门户](docs/modules/portal.md)。市场点评、文字版和报告 API 读 [市场点评](docs/modules/market-briefing.md)，今日聚焦另读 [今日聚焦](docs/modules/market-focus.md)。
- 市场热点、政策跟踪、跟踪点评读 [热点](docs/modules/market-hotspots.md)、[政策](docs/modules/policy-tracking.md)、[跟踪点评](docs/modules/commentary.md)。资讯、研报与点评详情读 [详情](docs/modules/research-details.md)。资金日报读 [资金日报](docs/modules/fund-report.md)。
- 交易研究首页、交易、流程及兼容跳转读 [交易研究工作台](docs/TRADING_RESEARCH_WORKBENCH.md)。研究辅助与 EDB 读 [研究辅助](docs/modules/research-assistance.md)。二级池读 [二级池](docs/modules/secondary-bond-pool.md)。融资择时读 [融资模型](docs/modules/financing-model.md)。
- 授信工作台、日历、周报、Excel 导入读 [授信工作台](docs/modules/credit-workbench.md)。授信材料和 CreditAgent 读 [授信助手](docs/CREDIT_ASSISTANT.md)。
- 融资首页、投资人、项目、SOP、数据后台、负债周报、客户依次读 [总览](docs/modules/financing-overview.md)、[投资人](docs/modules/bond-investors.md)、[项目](docs/modules/financing-projects.md)、[SOP](docs/modules/financing-sop.md)、[数据后台](docs/modules/financing-data.md)、[负债周报](docs/modules/liability-report.md)、[客户](docs/modules/clients.md)。
- 管理中心、个人资料、账号与 `/auth/*` 读 [管理](docs/modules/management.md)，登录配置另读 [Gateway Auth0](../gateway/auth0/README.md)。
- 机构图标读 [Logo](docs/INSTITUTION_LOGOS.md)。Quant 原始输入读 [Quant 输入](../data/docs/modules/quant-inputs.md)。消息投递读 [Messenger](docs/modules/messenger.md)。业务 MCP 读 [MCP](docs/MCP.md)。
- UI、组件、图表、响应式、打印：加读 [DESIGN](DESIGN.md)。
- 本仓库分层：加读 [ARCHITECTURE](docs/ARCHITECTURE.md)。跨服务变化才加读共享架构。
- 业务不变量与计算：加读 [DOMAIN](docs/DOMAIN.md) 和目标模块。云资源用量与性能基线读 [云资源审计](docs/DEVELOPMENT.md#云资源审计)。
- SQL、日期、事务和导入：加读 [DATABASE](docs/DATABASE.md)。共享表和存储归属变化才加读共享数据库。
- API / actions：加读 [API](docs/API.md)。身份与权限：加读 [SECURITY](docs/SECURITY.md)。
- 测试、开发和交付：加读 [DEVELOPMENT](docs/DEVELOPMENT.md)。
- AI 调用：加读 [共享 AI](../docs/AI.md) 与模块 Prompt / Schema。授信助手的 `credit_answer` 例外见 [CREDIT_ASSISTANT](docs/CREDIT_ASSISTANT.md)。

共享专题按 [项目组 AGENTS](../AGENTS.md#context-routing) 选读。

## 权限与测试

权限范围、匿名与测试账号、程序化登录见 [共享 AUTH](../docs/AUTH.md#程序化权限测试)。权限登录验收只用程序化 HTTP、单测和 CLI。

页面或视觉变更按 [TESTING](docs/TESTING.md) 更新视觉覆盖清单并审阅候选。交互用行为断言验证，不以源码样式或控件数量代替。
