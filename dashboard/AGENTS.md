# AGENTS.md

## Project Overview

债券市场研究全栈应用，提供市场点评、市场热点、二级池周报及融资业务管理。技术栈为 SvelteKit、Svelte 5、TypeScript、Tailwind CSS 4、shadcn-svelte Maia、Bits UI、svelte-sonner、TanStack Table v9、ECharts、Cloudflare Workers/D1/R2/Workflows/Hyperdrive、Neon PostgreSQL 与 AI Gateway。

融资入口 `/financing`（仪表盘、负债周报、项目、SOP、台账）。管理入口 `/management/me`、`/management/permissions`、`/management/notifications`。管理员使用 `/management/people` 和 `/management/messenger`。旧 `/management`、`/profile` 重定向到“我的”。

页面与模块文档按下方 Context Routing 选读。精确路由以 `src/routes/` 和 `worker/entry.ts` 为准。

## Mandatory Rules

- 修改前先搜索现有页面、组件、图表、派生函数和测试。优先复用，不建立平行实现。
- UI 变更必须读取 `DESIGN.md`。保持既有桌面布局和移动端模块顺序，不自行引入新设计体系。
- 前端禁止解释性小字和口径扩写，保持简洁标签。交互说明通过控件、状态与布局表达，不另加提示文案。
- 跨服务路由、DATA / InternalData 与身份所有权遵循 [共享架构](../docs/ARCHITECTURE.md)。只改页面时按下方对应模块读取，不预读其他仓库。
- 市场点评 REST 编排与视觉/文字共用契约、旧资源兼容边界见 [市场点评模块](docs/modules/market-briefing.md)。业务加工留在 Dashboard。
- Data 消费端使用 `src/data-contracts.ts` 的 Zod Schema 校验最小 DTO。字段投影与分页遵循 [Data API 契约](../data/docs/API.md)，不透传上游 envelope。债券动态代码与类型筛选见市场点评模块。
- 新闻详情扇出保持有界并发，复用 `src/lib/server/data-news.ts` 和既有 DATA adapter。
- 身份只使用 Gateway 私有入口注入的 `locals.user`，权限只使用 `user.authorization`。应用不验证 JWT、不回查 Auth0，不另建授权系统。保留记录归属和业务规则。精确认证、路由豁免、失败关闭与模式规则见 [SECURITY](docs/SECURITY.md)。
- 一级发行视觉与文字输出必须共用 `src/primary-issues.ts`。文字报告不得读取 Python 归档文本。
- 热点首次访问只读最近成功快照。只有用户手动生成才调用模型并追加 `hotspot_snapshot`。旧快照的证据范围以快照自身为准。
- 二级池 Excel 在浏览器 Web Worker 解析，线上校验结构后归档原件并通过 Hyperdrive 单事务直接写入 Neon。不使用导入 Workflow，浏览器不缓存完整台账。
- D1/Neon/R2 所有权及跨仓库 migration 协同遵循 [共享数据库](../docs/DATABASE.md)。本地连接、日期和导入一致性遵循 [DATABASE](docs/DATABASE.md)。
- 生成式 AI 仅通过 `src/lib/server/ai-gateway.ts`。传输、重试与检索遵循 [共享 AI](../docs/AI.md)，业务 Prompt、Schema 和例外留在目标模块。
- 融资模型的 Quant / Dashboard 写入分工见 [共享数据库](../docs/DATABASE.md#融资模型跨仓库写入)，页面契约见 [融资模型模块](docs/modules/financing-model.md)。
- 卖方观点使用研究库检索，授信助手使用独立授信材料库。不得跨用其证据来源和权限。具体检索分别见融资模型模块与 [授信助手](docs/CREDIT_ASSISTANT.md)。
- 不手动编辑生成文件 `worker-configuration.d.ts`。绑定变化使用 `pnpm worker:typegen`。
- `pnpm dev` 不自动同步远程 D1。只有任务明确需要本地证据时才运行 `pnpm db:sync:remote`。
- 保留用户已有改动，不做无关重构，不通过删除测试或关闭检查掩盖错误。
- 推送前代码变更运行 `pnpm check:quick` 和直接相关的轻量单元测试。纯文档修改只运行 `git diff --check`。页面视觉改动在本地以 `pnpm visual:local` 审阅受影响页，完整验收由合并队列的 `Dashboard CI` 执行。阶段、截图候选与部署边界见 [DEVELOPMENT](docs/DEVELOPMENT.md) 和 [TESTING](docs/TESTING.md)。
- 前端、共享 UI、API 契约及影响页面输出的改动，须由新的子代理交付。子代理提交并推送任务分支，创建/更新 PR、加入合并队列并核对 CI。失败证据交回主代理修复。

  monorepo统一通过PR及合并队列集成，不使用直接推送例外。

  完整流程见 [DEVELOPMENT](docs/DEVELOPMENT.md)。


CI 等待和停止条件见 [CI 等待与收尾](docs/TESTING.md#ci-等待与收尾2026-09-20)。

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
- 显式同步远程 D1：`pnpm db:sync:remote`
- 权限 migration：`pnpm auth:db:migrate` 默认只读盘点。显式 `--apply` 才执行，替换账号需提供经确认的 `--person-map` JSON。
- Neon migration：`pnpm bond:db:migrate`
- 融资择时 Neon migration：`pnpm financing-model:db:migrate`
- 台账回填盘点：`pnpm bond:db:backfill`。只有显式增加 `--apply` 才写入
- 部署：PR 经合并队列的 GitHub 必需检查后合并到 `main`，由 Cloudflare Git 自动构建部署。必要时可执行 `pnpm worker:deploy` 手动部署同一已验证提交。两种方式均无需再次向用户申请授权。部署后核对线上版本和受影响路由。

## Context Routing

跨项目执行与并行工作树规则见 [项目组 AGENTS](../AGENTS.md)。未在上下文中时读取一次。只加载任务相关文档，跨模块仅加读受影响部分，不重复读取已有上下文。

- 页面、API、业务或定时任务：先按下方路径定位唯一模块文档，再按任务叠加专题。兼容入口复用目标模块规范，不另建一份。
- 门户 `/` 读[门户](docs/modules/portal.md)。市场点评、文字版和报告 API 读[市场点评](docs/modules/market-briefing.md)，其中今日聚焦另读[今日聚焦](docs/modules/market-focus.md)。市场热点、政策跟踪、跟踪点评分别读[热点](docs/modules/market-hotspots.md)、[政策](docs/modules/policy-tracking.md)、[跟踪点评](docs/modules/commentary.md)。资讯、研报与点评详情读[详情](docs/modules/research-details.md)。资金日报读[资金日报](docs/modules/fund-report.md)。
- 交易研究首页、交易、流程及兼容跳转读[交易研究工作台](docs/TRADING_RESEARCH_WORKBENCH.md)。研究辅助与 EDB 读[研究辅助](docs/modules/research-assistance.md)。二级池读[二级池](docs/modules/secondary-bond-pool.md)。融资择时模型读[融资模型](docs/modules/financing-model.md)。
- 授信工作台、日历、周报、Excel 导入读[授信工作台](docs/modules/credit-workbench.md)。授信材料和 CreditAgent 读[授信助手](docs/CREDIT_ASSISTANT.md)。
- 融资首页、投资人、项目、SOP/提醒、台账与数据后台、负债周报、客户关联依次读[总览](docs/modules/financing-overview.md)、[投资人](docs/modules/bond-investors.md)、[项目](docs/modules/financing-projects.md)、[SOP](docs/modules/financing-sop.md)、[数据后台](docs/modules/financing-data.md)、[负债周报](docs/modules/liability-report.md)、[客户](docs/modules/clients.md)。管理中心、个人资料、账号与 `/auth/*` 读[管理](docs/modules/management.md)，登录配置才加读 [Gateway Auth0](../gateway/auth0/README.md)。
- 机构图标读[Logo](docs/INSTITUTION_LOGOS.md)。Quant 原始输入读[Quant 输入](docs/modules/quant-inputs.md)。消息投递读[Messenger](docs/modules/messenger.md)。业务 MCP 读[MCP](docs/MCP.md)。历史合并记录和需求底稿仅供追溯，不作当前规范。
- UI、组件、图表、响应式、打印：加读 [DESIGN](DESIGN.md)。
- 本仓库分层：加读 [ARCHITECTURE](docs/ARCHITECTURE.md)。只有跨服务变化才加读共享架构。
- 业务不变量与计算：加读 [DOMAIN](docs/DOMAIN.md) 和目标模块。云资源用量与性能基线读[云资源审计](docs/operations/cloud-resource-audit-2026-09-21.md)。
- SQL、日期、事务和导入：加读 [DATABASE](docs/DATABASE.md)。共享表/存储归属变化才加读共享数据库。
- API / actions：加读 [API](docs/API.md)。身份与权限：加读 [SECURITY](docs/SECURITY.md)。
- 测试、开发和交付：加读 [DEVELOPMENT](docs/DEVELOPMENT.md)。
- AI 调用：加读 [共享 AI](../docs/AI.md) 与模块 Prompt/Schema。授信助手 `credit_answer` 例外由 [CREDIT_ASSISTANT](docs/CREDIT_ASSISTANT.md) 维护。

融资和管理功能不读取旧 Financing 文档作为当前规范。共享专题按[项目组 AGENTS](../AGENTS.md#context-routing)选读。

## 权限与测试

权限范围、匿名与测试账号、程序化登录限制见 [共享 AUTH](../docs/AUTH.md#程序化权限测试)。禁止用浏览器、Chrome、Playwright 或浏览器 MCP 做权限登录验收。页面或视觉变更按 [TESTING](docs/TESTING.md) 更新视觉覆盖清单并审阅候选。不要用源码样式或控件数量代替行为验证。
