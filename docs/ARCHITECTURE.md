# 共享架构

本文件拥有跨项目职责、生产路由和服务边界。项目内部结构见各项目 `AGENTS.md`。存储所有权见 [DATABASE](DATABASE.md)，模型传输见 [AI](AI.md)，认证与权限见 [AUTH](AUTH.md)。

## 运行单元与生产入口

| 运行单元 | 职责 | 配置与入口 |
|---|---|---|
| Gateway Worker | 唯一公网 `eastmoney.hasbai.xyz/*`。Hono、Auth0、JWT、会话与权限服务 | [wrangler](../gateway/wrangler.jsonc)、[入口](../gateway/src/index.ts) |
| Data Worker | 私有 `GatewayData` / `InternalData` / `ScheduledTasks`。经济指标与 DM 资金面同步 Workflow | [wrangler](../data/wrangler.jsonc)、[入口](../data/src/index.ts) |
| Dashboard Worker | 私有 `GatewayDashboard` 承接 UI、业务 API 和 actions。market-briefing Workflow、授信 Agent | [wrangler](../dashboard/wrangler.jsonc)、[入口](../dashboard/worker/entry.ts) |
| Messenger Worker | 私有 `Messaging` / `MessengerAdmin`。消息投递和全项目唯一的分钟 Cron | [wrangler](../messenger/wrangler.jsonc)、[接口](../messenger/README.md) |
| Ingest Worker | 研报、政策与央行资讯的私有 `ScheduledTasks` 和 Workflows。不承接站点页面 | [wrangler](../ingest/wrangler.jsonc)、[入口](../ingest/src/index.ts) |
| Choice | 生产为 office Linux amd64 上的 SDK 单会话私网服务。本分支由 Data 的私有 Durable Object 持有原生会话，尚未部署 | [构建与运行](../choice/docs/DEVELOPMENT.md)、[原生协议迁移](../data/docs/modules/choice-native.md) |
| Quant | 本地债券训练（两融已封存于 `archive`）。线上为私有债券推理 Workflow 和静态研究报告，无公网 API | [本地架构](../quant/docs/ARCHITECTURE.md)、[线上推理](../quant/docs/ONLINE_INFERENCE.md) |

路由：

- `/api/ai/responses`：Gateway 验证本站用户 Bearer 后，直接请求 Cloudflare AI Gateway，支持 JSON 和原生 Responses SSE。
- `/data` 及子路径：Data。
- `/financing-model/research`：按 `/financing-model` 的 `model.financing:read` 授权，进入 Quant `ResearchReport`。
- `/mcp`：Gateway 汇总 Dashboard 与 Data 的工具。连接和授权见 [AUTH](AUTH.md#mcp-边界)，工具目录见 [Dashboard MCP](../dashboard/docs/MCP.md)。
- 其余已登记路径：Dashboard。

Dashboard 与 Data 没有 routes、Custom Domain、workers.dev 或 preview URL。默认 fetch 固定返回 404。命名入口只能经预先配置的 Service Binding 访问，不能由 URL 或请求头选中。

## 调用链路

```text
Browser / HTTP client
  → Gateway (Hono)
      ├─ 精确公开路径 → passthrough
      ├─ Auth0 SPA SDK 授权码 + PKCE → 内存 Access JWT / Bearer
      └─ Auth0 JWKS JWT / 登录角色 + Auth0 角色权限 JSON 缓存 + 路由权限
          ├─ /api/ai/responses → Cloudflare AI Gateway custom-codex/responses
          ├─ DASHBOARD: GatewayDashboard → UI / API / actions / 授信 HTTP
          ├─ DATA: GatewayData → REST / GraphQL / CAMEL
          └─ QUANT_REPORT: ResearchReport → 已构建 README.md

浏览器管理页 → Gateway /api/management/people → Auth0 人员资料
Dashboard → IDENTITY: IdentityService → Gateway 内部账号目录 / 角色授权缓存
Dashboard / Ingest → MESSENGER: Messaging → D1 messenger / Queue messenger → Resend / Telegram
Dashboard 管理页 → MESSENGER_ADMIN: MessengerAdmin → 投递历史与人工重试
Cloudflare Workflow 终态 → Event Subscriptions / Queue messenger-workflow-events → Messenger
Messenger 每分钟 Cron → 私有 ScheduledTasks → Dashboard / Data / Ingest / Quant
Dashboard / Ingest / Quant → DATA: InternalData → Data
Data → DM / CAMEL VPC → office 上游
Data → CHOICE_SESSION Durable Object → Choice 厂商 TCP / HTTPS（本分支，尚未部署）
Data economic-indicator-sync → Hyperdrive → Neon public.edb / quant_input
Data economic-indicator-sync → R2 eastmoney/fund-reports（只读）
Ingest → D1 + R2 article → AI Search research
Dashboard → D1 / R2 / Hyperdrive → Neon
Dashboard 授信问答 → R2 eastmoney/credit/ → AI Search credit
Quant 本地 → Neon 只读输入 → 本地结果 / 训练导出
Quant BondInferenceWorkflow → R2 quant-trial 归档 → Neon financing_model.publish_online_result → Dashboard 只读报告
```

- **身份传递**：可信边界是命名 Service Binding。Gateway 移除外部凭据和身份头，以 UTF-8 Base64URL 传入版本化上下文。Dashboard 只在私有入口解析它，hooks 不读取身份头或 JWT。
- **Data 授权**：Data 接收 Gateway 的 GraphQL 字段授权结果和 CAMEL 准入结果，不访问 Auth0 或权限库。受保护资源在调用上游前应用这些结果。
- **角色目录**：Dashboard 经 `IDENTITY` 取得用户目录和角色权限。Gateway 用 Cache API 缓存角色权限 1 小时并逐请求检查。提醒 Cron 经同一目录服务取得收件人，不依赖用户会话。
- **机器调用**：Dashboard、Ingest 和 Quant 在线任务经 `InternalData` 调用 Data。Quant 在线任务只查询交易日。Gateway 的机器客户端白名单为空。恢复机器 Choice 访问须按 [AUTH](AUTH.md) 重新配置并验证完整调用链。
- **上游访问**：DM、Choice、CAMEL 各走 VPC binding，无公网回退。CAMEL 的拆借查询、Excel 导入、PDF 上传和还款草稿由浏览器直接调用 `/data/camel/*`，不经 Dashboard。ZIP 解析、改名和本地归档在浏览器完成，资金凭据、验证码和会话留在 Data。
- **Workflow 通知**：Messenger 订阅平台事件，处理 Workflow 失败和终止。omo 和 market-briefing 成功也通知。economic-indicator-sync 的完成事件用于捕获业务 partial/failed，成功不通知。Workflow 不内嵌终态通知。订阅流程见 [Messenger 运维](../messenger/docs/DEVELOPMENT.md#workflow-订阅)。

## 数据接口与业务计算

Data 拥有单资源 REST、薄 GraphQL 和 Zod DTO。字段以 [contracts.ts](../data/src/contracts.ts) 和生成的 [OpenAPI](../data/src/openapi.json) 为准。列表为顶层 array，对象为 object。分页例外和 `fields` 投影见 [Data API](../data/docs/API.md)。调用方不要假设统一的 `data/list` envelope。

market-briefing Workflow 在交易日北京时间 17:00 编排市场点评。分段 REST 与今日聚焦 AI 并发执行，经 DATA binding 取材，按报告契约加工后存 R2。浏览器只读定稿，供视觉与文字共用。Data 不生成整份报告。页面行为见[市场点评](../dashboard/docs/modules/market-briefing.md)和[今日聚焦](../dashboard/docs/modules/market-focus.md)。

Ingest 经 DATA binding 取研报与政策的列表和详情，负责采集与归并。Dashboard 负责展示、人工关系和研究点评。两者对同一 D1 的写入分工见 [共享 D1](DATABASE.md#共享-d1)。

Quant Worker 的默认 HTTP 固定返回 404。`ResearchReport` 只接受命名服务绑定的 `/README.md` 与兼容路径 `/REPORT.html` 的 GET/HEAD，返回同一份报告。资产只含审阅后的聚合报告，不含输入、模型和逐笔记录。报告部署与推理代码部署分开，以免未过门槛的推理代码随报告上线。

Quant 债券 pipeline 不调用 R2 或 AI Search 生成卖方观点。R2 研报查询工具只作独立研究辅助。

## 变更协同

- 路由或绑定变化：同时核对生产 Wrangler 路由、命名 entrypoint、本地代理、受影响客户端和契约测试。
- 上游字段变化：先核对 Data DTO，再检查 Dashboard、Ingest、Quant 的实际消费者。
- 数据落库变化：按 [DATABASE](DATABASE.md) 定位读写双方和 migration 所有方。各项目独立测试和提交。
- VPC 健康以部署到 edge 的 smoke 为准，本地 preview 超时不说明生产状态。操作见 [Data 开发与验证](../data/docs/DEVELOPMENT.md)。

## 用户通知中台

Messenger 的逻辑通知 inbox 与投递 outbox 经 Queue 解耦。Dashboard 只提交类型、内容和目标账号。联系方式、类型订阅、渠道和 Web Push 设备由 Messenger 维护。Workflow 终态事件也进入逻辑通知层。投递只依据 Messenger D1，不查 Auth0 权限。

Messenger 拥有全项目唯一的分钟 Cron，按 UTC 分钟分派 Dashboard、Data、Ingest、Quant 的私有 `ScheduledTasks`。业务时间窗、交易日和 Workflow 幂等仍归各业务方。交易和融资提醒扫描也在 Messenger：它把 D1 中 trading 订阅用户的名单交给 Dashboard 私有 `NotificationSource`，业务表查询仍在 Dashboard。

PWA 静态资源经 Gateway 精确公开。Service Worker 不缓存受保护页面或 API。
