# 接口约定

代码与运行时 Schema 是接口事实来源。本文记录 Dashboard 的路由职责和稳定契约。

## 外部数据服务 `/data/*`

- 资源、`fields` 投影、DTO、空值规则和错误诊断由 [Data API](../../data/docs/API.md) 维护。Dashboard 先用 `src/data-contracts.ts` 或服务端局部 Zod Schema 校验响应，不用 TypeScript 断言猜测结构。
- 本地 Vite 保留 `/data` 前缀并代理到 `DATA_PROXY_TARGET`。线上由 Data Worker 处理，Dashboard Worker 不注册这些路由。
- 公开与需登录的边界见 [共享 AUTH](../../docs/AUTH.md#公开仅登录与业务权限)。
- 拆借 CAMEL 由浏览器同源调用 `/data/camel/*`，不经 Dashboard 后端，见 [拆借台账](TRADING_RESEARCH_WORKBENCH.md#拆借台账)。
- 原始资源字段变化须同步 `worker/market-briefing-runner.ts`、`src/market-report-resources.ts`、`src/report-view.ts`、`src/text-report.ts` 和测试。视觉版与文字版共用一个数据源。
- 市场点评日期只通过 `GET /api/market-report` 读取定稿，缺失明确返回错误，不回退到 Data。生成、重试与归档由 `market-briefing` Workflow 承担，见 [市场点评](modules/market-briefing.md)。
- 研究辅助页面只调用 `GET /api/economic-indicators`（读 Neon）。Choice `/data/choice/edb` 与 DM `/data/cfets-histories` 只供本地回填和每日增量，页面加载不消耗上游额度。
- `/api/market-resources/*` 是公开的限定兼容通道，保留资源与参数白名单。

## Dashboard Worker `/api/*`

- JSON 错误为 `{ "error": "可公开信息" }`，日志可记诊断信息但不含 Secret 和完整敏感输入。
- 动态生成、台账和融资择时模型的响应用 `Cache-Control: no-store`。融资择时的写接口同时执行 Gateway 身份、业务权限和同源校验。
- 日期参数用严格 `YYYY-MM-DD`。起止日期须同时提供，且起始不晚于结束。
- route handler 只做解析、校验、错误映射和服务调用，业务逻辑放入 `src/lib`。
- `/bond-ledger` 以 308 指向 `/bond`。
- 前端发起的 AI 请求带 `Accept: text/event-stream`，事件协议（`progress` / `result` / `error`）见 [共享 AI](../../docs/AI.md#前端-sse)，客户端为 `src/lib/ai-client.svelte.ts`。
- `POST /api/ai/responses` 由 Gateway 直接处理，见 [Gateway AI](../../gateway/docs/AI.md)。
- `POST /api/mcp` 提供经 Gateway 逐用户授权的业务工具，见 [MCP](MCP.md)。

页面与接口细则见 [Context Routing](../AGENTS.md#context-routing)。

## 融资与管理路由

- `/financing/*` 是 Dashboard 的真实路由子树，SvelteKit 全局 base 为空，URL 由 `src/lib/financing/app-paths.ts` 生成。
- `/management/people` 提供管理员人员资料与只读角色权限，个人资料在 `/management/me`。旧 `/profile` 和融资资料入口重定向到 `/management/me`。
- 页面 load 只返回所需数据。通用预取用 tap，固定工作台导航允许 hover。
- 普通 mutation 返回单个确认实体或删除 ID，增强表单用 `update({ reset: false, invalidateAll: false })`。身份与提醒按 dependencies 定向失效。负债周报的显式生成按新快照版本刷新。
- 内部数据接口为 `/financing/data/token`、`/financing/data/api/*`、`/financing/data/import`。表、字段、主键和分页沿用白名单，请求身份在事务内设置并执行 RLS，不向浏览器返回 Neon JWT。
- 业务 GET/HEAD、API 写入和 named actions 由 Gateway 的 `permission-policy.ts` 登记检查。`src/lib/permissions.ts` 只是前端展示快照，请求传入的权限、角色或身份不能代替服务端授权。
