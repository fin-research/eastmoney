# 接口约定

代码与运行时 Schema 是接口事实来源。本文件记录路由职责和稳定契约，不复制完整响应结构。

## 外部数据服务 `/data/*`

市场点评及其定稿 GET/HEAD 公开只读。市场点评 Workflow 通过私有 DATA binding 读取原始行情，浏览器只读取 R2 定稿。DM、东方财富网和固定行业快照读取不查询身份服务。Choice 通用查询仍要求登录。CAMEL 只经 Dashboard 同源 `/api/interbank/*` 访问私有 Data 入口，见[拆借台账](TRADING_RESEARCH_WORKBENCH.md#拆借台账)。旧 `/api/market-resources/*` 保留为公开的限定兼容通道。

除基础配置和 Choice 外，所有 REST 资源都支持 `fields=a,b` 顶层字段投影。未知字段为
422。列表资源直接返回 JSON array，不再读取 `data`、`list` 等上游 envelope。响应必须
先通过 `src/data-contracts.ts` 或服务端局部 Zod Schema，不能用 TypeScript 断言猜测上游
结构。

- `GET /data/config`：默认报告配置。
- `GET /data/omo?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`、`GET /data/cfets?date=YYYY-MM-DD&source=DR|DIBO`：OMO 与资金利率原始映射。
- `GET /data/cfets-histories?bondCode=DR001&endCapitalTime=...&limit=100`：DM 单个资金利率的倒序分页历史，供研究数据回填和增量任务使用。
- `GET /data/bond-top-case?date=YYYY-MM-DD`、`GET /data/futures-latest`、`GET /data/margin?date=YYYY-MM-DD`：国债、期货与两融原始映射。
- `GET /data/industry?date=YYYY-MM-DD`：行业、主要指数、成交额及可用交易日。
- `GET /data/primary-issues?date=YYYY-MM-DD&startDate=YYYY-MM-DD`：一级发行原始映射。
- `GET /data/today-trades?limit=300`、`GET /data/favorite-quotes?limit=100`、`GET /data/bond-infos?codes=...`：今日成交、收藏报价与批量债券基础信息原始映射。`codes` 由本次两份行情的 `bondUniCode` 合并去重后动态生成。`fields` 只取连接、展示和类型筛选需要的 `bondUniCode,bondShortName,comShortName,bondType,bondOfferingType`。
- `GET /data/stock-summary?date=YYYY-MM-DD`：A 股收评标题、时间与前两段。
- `GET /data/news?date=YYYY-MM-DD&important=true&pageSize=40` 与 `GET /data/news/{id}`：今日聚焦的 DM 新闻列表和正文。
- `POST /data/graphql`：以 nullable 顶层字段薄映射全部公共数据资源，参数、`fields` 投影
  和 DTO 与对应 REST 相同。不包含市场点评筛选、合并或口径换算。市场点评继续使用分段
  REST，避免多字段 CPU 累计并让每个数据步骤独立重试。

本地 Vite 完整保留 `/data` 前缀并代理到 `DATA_PROXY_TARGET`。线上由独立数据服务处理，Dashboard Worker 不注册这些路由。

原始资源字段变化必须与 `worker/market-briefing-runner.ts` Workflow 请求编排、`src/market-report-resources.ts` 加工、`src/report-view.ts`、`src/text-report.ts` 及相关测试同步。不要恢复 `/data/market-report/*` 或 GraphQL 市场报告聚合，也不要为视觉版或文字版增加单独的数据源。

Data 错误保留安全诊断字段。市场点评 Workflow 对失败资源独立重试，耗尽后明确失败且不归档残缺报告。稀疏 OMO/CFETS/期货数值和今日成交收益率以 `null` 表示，不转换为 0。空列表是否有业务意义仍由原 DTO 与共享派生层解释。

研究辅助浏览器只调用 Dashboard `GET /api/economic-indicators` 读取 Neon。Choice `GET /data/choice/edb` 与 DM `GET /data/cfets-histories` 只供首次本地全历史回填和每日定时增量任务使用，页面加载不消耗上游查询额度。

市场点评所有日期只通过 `GET /api/market-report` 读取定稿。默认日期按上海 17:00 选择 T-1 或当日。缺失明确返回错误，不回退到 Data。生成、重试与归档由 `market-briefing` Workflow 承担。

终态通知由 Messenger 订阅平台事件投递。旧写接口兼容不代表新版前端生成入口。具体规则见[市场点评](modules/market-briefing.md)。

## Dashboard Worker `/api/*`

## 通用约定

- JSON 错误使用 `{ "error": "可公开信息" }`。服务端日志可记录诊断信息，但不得包含 Secret 或完整敏感输入。
- 动态生成和台账 JSON 响应使用 `Cache-Control: no-store`。
- 融资择时模型读取、人工结论、历史决策记录、卖方生成和卖方修订响应同样使用 `Cache-Control: no-store`。写接口同时执行 Gateway 身份、业务权限及同源校验。
- 日期参数使用严格 `YYYY-MM-DD`。起止日期必须同时提供且起始不晚于结束。
- route handler 只做解析、校验、错误映射和服务调用。业务逻辑放入 `src/lib`。
- 兼容跳转 `/bond-ledger` 固定以 308 指向 `/bond`。

前端发起的 AI 请求统一携带 `Accept: text/event-stream`，由 Worker 流式请求上游并返回以下 SSE 事件：`progress` 的 `data` 是移除 Markdown 加粗标记后的模型公开 reasoning summary 纯文本，`result` 的 `data` 是完整终态 JSON，`error` 的 `data` 是可公开错误文本。事件类型只使用 SSE 原生 `event` 字段，数据内不重复写 `type` 或 `id`。保活仅使用注释帧。前端统一由 `src/lib/ai-client.svelte.ts` 解析，终态后立即停止读取。不再新增 `complete`、`session`、`draft` 或 NDJSON AI 流协议。

具体页面规则和接口见 [模块分流](../AGENTS.md#context-routing)，不在公共文档重复维护。

## 融资与管理路由

`/financing/*` 属于 Dashboard 的真实路由子树，SvelteKit 全局 base 仍为空。URL 使用 `src/lib/financing/app-paths.ts`。`/management/people` 提供管理员人员资料及只读角色权限。个人资料使用 `/management/me`。旧 `/profile` 和融资资料入口重定向到“我的”。

页面 load 仅返回所需数据，通用预取使用 tap，固定工作台导航允许 hover。普通 mutation 返回单个确认实体或删除 ID，增强表单使用 `update({ reset: false, invalidateAll: false })`。身份与提醒只按 dependencies 定向失效。负债周报的显式生成按新快照版本刷新，具体例外见模块文档。

内部数据接口保持 `/financing/data/token`、`/financing/data/api/*`、`/financing/data/import`。Auth0 模式不向浏览器返回 Neon JWT。字段、表、主键与分页仍使用原白名单。请求身份在事务内设置并执行 RLS。

全站业务 GET/HEAD、API 写入及 named actions 均由 Gateway 的 `permission-policy.ts` 登记和检查，门户及身份 bootstrap 除外。权限目录由 Gateway 维护，`src/lib/permissions.ts` 为前端展示快照。请求传入的权限、角色、人员身份或来源标记不能代替服务端授权。

## 业务 MCP

`POST /api/mcp` 提供经 Gateway 逐用户授权的查询、修改与 AI 工具。定义、边界及验证见 [MCP](MCP.md)。

`POST /api/ai/responses` 为已登录浏览器的流式 Responses 接口。Gateway 校验 Bearer token 及同源请求，Dashboard 固定模型和 Cloudflare AI Gateway `custom-codex` 路径，服务端持有 `CF_AIG_TOKEN`。浏览器通过 `Authorization: Bearer` 调用，ToolLoopAgent、工具循环和本地对话历史均在浏览器运行。请求与响应不缓存。
