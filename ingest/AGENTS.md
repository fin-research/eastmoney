# AGENTS.md

## Project Overview

纯 TypeScript Cloudflare Worker。Messenger 的私有定时调用在工作日北京时间 08:00–18:00 每 5 分钟读取 `市场解读` 研报和 `中央政策` 资讯，以及央行资讯。

- 新增研报进入 `ArticleWorkflow`：取正文、AI 特征抽取、D1 元数据、R2 归档、政策关联。
- 新增政策进入 `PolicyWorkflow`，归并为政策卡片。
- 央行资讯进入 `TelegramWorkflow`。09:20 启动公开市场播报 `OmoWorkflow`。

运行资源以 `wrangler.jsonc` 为准：Worker `ingest`、D1 `eastmoney`、四个业务 Workflow 和 R2 `article`。AI Search `research` 独立同步 R2，Worker 不绑定。

## Rules

- 保持纯 TypeScript，不加 Python、本地采集器、SQLite 或 launchd。
- 修改前搜索现有 adapter、校验器和测试，复用 `article.ts`、`ai-gateway.ts` 与既有 Workflow 步骤。
- 定时触发只来自 Messenger 的分钟 Cron，经私有 `ScheduledTasks` 进入。`wrangler.jsonc` 的 `triggers.crons` 保持为空。
- Data 的列表和详情只经 `src/data-fetcher.ts` 的 `DATA` / `InternalData` binding 读取，不走公网。`ARTICLE_API_BASE_URL` 固定为 `https://eastmoney.hasbai.xyz/data`。
- `/data/news` 返回顶层 array，详情返回顶层 object。请求用 `fields` 只取所需字段。
- Cron 只读列表、批量查重和启动 Workflow，不写 D1、不预抓正文。每批最多 100 条元数据。
- Workflow 步骤幂等，每个 Promise 都 await。空白正文正常跳过，字段缺失、类型错误和 HTTP/JSON 异常不得当作空正文。
- 人工关联或排除优先于 AI，自动任务不覆盖。
- 研报正文不写 D1。政策正文留在 `policy_news`。R2 key、元数据和索引边界见[研究归档协议](../docs/DATABASE.md#研究归档协议)。
- 生成式 AI 只经 `src/ai-gateway.ts`，规则见[共享 AI](../docs/AI.md)。Prompt 与 Zod Schema 留在特征和政策模块。
- 外部 API 响应限长读取并做运行时校验，不直接断言为业务类型。
- 不手动编辑 `worker-configuration.d.ts`，用 `pnpm types` 生成。
- 验证后经 monorepo PR 和合并队列进入 `main`，由 Cloudflare Git 自动构建部署。不手动运行 `pnpm deploy:worker`。

## Commands

- `pnpm install`、`pnpm types`、`pnpm check`、`pnpm test`、`pnpm deploy:dry`
- D1 migration：`pnpm db:migrate:local`、`pnpm db:migrate:remote`

## Context Routing

按任务选读：

- Cron、DATA 契约、Workflow 启动：[ARCHITECTURE](docs/ARCHITECTURE.md)。
- 研报正文、公众号、特征、归档：[研报模块](docs/modules/articles.md)。
- 政策队列、归并、研报关联：[政策模块](docs/modules/policies.md)。
- 公开市场播报：[公开市场播报](docs/modules/open-market.md)。央行资讯与 Telegram：[通知模块](docs/modules/telegram.md)。
- D1 幂等与 migration：[DATABASE](docs/DATABASE.md)。Secret 与日志：[SECURITY](docs/SECURITY.md)。验证与发布：[DEVELOPMENT](docs/DEVELOPMENT.md)。测试取舍：[TESTING](docs/TESTING.md)。

跨服务变化才读[共享架构](../docs/ARCHITECTURE.md)，共享表或归档变化才读[共享数据库](../docs/DATABASE.md)。权限验收见[共享 AUTH](../docs/AUTH.md#程序化权限测试)。
