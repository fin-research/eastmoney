# 共享架构

本文件拥有跨仓库职责、生产路由与服务边界。仓库内部模块从目标仓库 `AGENTS.md` 按需定位。存储所有权见 [DATABASE](DATABASE.md)，模型传输见 [AI](AI.md)。以下为仓库代码与配置所表达的部署架构，不是本次线上可用性验收。

## 运行单元与生产入口

| 运行单元 | 职责 | 配置事实来源 |
|---|---|---|
| Gateway Worker | 唯一公网 `/*`。Hono、Auth0、JWT、会话与权限服务 | [wrangler](../gateway/wrangler.jsonc)、[入口](../gateway/src/index.ts) |
| Data Worker | 私有 `GatewayData` / `InternalData`，经济指标定时入口 / Workflow | [wrangler](../data/wrangler.jsonc)、[入口](../data/src/index.ts) |
| Dashboard Worker | 私有 `GatewayDashboard` 承接 UI、业务 API/actions。Workflows 与授信 Agent | [wrangler](../dashboard/wrangler.jsonc)、[入口](../dashboard/worker/entry.ts) |
| Messenger Worker | 私有 Messaging / MessengerAdmin，消息投递与唯一分钟 Cron Scheduler | [配置](../messenger/wrangler.jsonc)、[接口](../messenger/README.md) |
| Ingest Worker | 研报、政策与央行资讯私有定时入口 / Workflows。不承接站点页面 | [wrangler](../ingest/wrangler.jsonc)、[入口](../ingest/src/index.ts) |
| Choice RPC | office Linux amd64 的 Choice SDK 单会话私网服务 | [构建与运行](../choice/docs/DEVELOPMENT.md) |
| Quant | 本地债券训练。两融封存于 archive。私有债券 JS 推理 Workflow 与静态研究报告，自动归档并发布结果，无公网 API | [本地架构](../quant/docs/ARCHITECTURE.md)、[线上推理](../quant/docs/ONLINE_INFERENCE.md) |
| 原 Financing Worker | 休眠回退。空路由、空 Cron，不能重新取得生产 Workflow 所有权 | [合并记录](../dashboard/docs/FINANCING_MERGE.md) |

业务站点公网为 `eastmoney.hasbai.xyz/*` → Gateway。`/api/ai/responses` 由 Gateway 验证本站用户 Bearer 后直接请求 Cloudflare AI Gateway，支持 JSON 和原生 Responses SSE。`/data` 及其子路径进入 Data。`/financing-model/research` 按既有模型读取权限进入 Quant `ResearchReport` 命名报告入口，其余已登记路径进入 Dashboard。MCP 统一通过 Gateway `eastmoney.hasbai.xyz/mcp` 接入，不经过 Cloudflare MCP Portal。

MCP 通过 Gateway 公开资源发现直连 Auth0 OAuth，使用正常 API Bearer，执行经私有 IDENTITY 路由权限桥接；只注册已审核业务数据与人工操作，AI 生成不进入工具目录。Gateway 通过命名 `GatewayDashboard` / `GatewayData` Service Binding 汇总 Dashboard 与 Data 工具；应用维护 Schema、查询与业务权限，Gateway 不转发用户 token。旧公网 `/api/mcp`、`/data/mcp` 返回410。连接与发布目录见 [Dashboard MCP](../dashboard/docs/MCP.md)。Dashboard/Data 没有 routes、Custom Domain、workers.dev 或 preview URL。

默认 fetch 固定 404，命名入口不能由 URL 或请求头选中。

## 调用链路

```text
Browser / HTTP client
  → Gateway (Hono)
      ├─ 精确公开路径 → passthrough
      ├─ Auth0 SPA SDK 授权码 + PKCE → 内存 Access JWT / Bearer
      └─ Auth0 JWKS JWT / 登录角色 + Auth0 角色权限 JSON 缓存 + 路由权限
          ├─ /api/ai/responses → Cloudflare AI Gateway custom-codex/responses
          ├─ DASHBOARD: GatewayDashboard → UI / API / actions / 授信 HTTP
          ├─ DATA: GatewayData → REST / GraphQL
          └─ QUANT_REPORT: ResearchReport → 已构建 REPORT.html

浏览器管理页 → Gateway /api/management/people → Auth0 人员资料
Dashboard → IDENTITY: IdentityService → Gateway 内部账号目录 / 角色授权缓存
Dashboard / Ingest → MESSENGER: Messaging → D1 messenger / Queue messenger → Resend / Telegram
Cloudflare Workflow 终态 → Event Subscriptions / Queue messenger-workflow-events → Messenger
Messenger → 跨脚本 Workflow bindings → 实例结果及错误详情
Messenger 唯一每分钟 Cron → 私有 ScheduledTasks → Dashboard / Data / Ingest / Quant 原业务编排
Dashboard 管理页 → MESSENGER_ADMIN: MessengerAdmin → 投递历史与人工重试
Dashboard / Ingest / Quant 定时任务 → DATA: InternalData → Data
Quant 本地 → Neon 只读输入；旧 Auth0 机器 Choice 客户端已退役
Data → DM / CHOICE_RPC / CAMEL VPC → office 上游
Data economic-indicator-sync → Hyperdrive → Neon public.edb / quant_input
Data economic-indicator-sync → R2 eastmoney/fund-reports（只读）
Ingest → D1 + R2 article → AI Search research
Dashboard → D1 / R2 / Hyperdrive → Neon
Dashboard 授信问答 → CreditAgent / R2 eastmoney/credit/公开材料 / AI Search credit
Quant 本地 → 本地结果 / 训练导出
Quant BondInferenceWorkflow → R2 quant-trial 归档 → Neon financing_model.publish_online_result → Dashboard 只读报告
```

- 可信边界是 Cloudflare 预先配置的命名 Service Binding，不是用户 HTTP Header。Gateway 移除外部凭据和身份头，以 UTF-8 Base64URL 传入版本化上下文。Dashboard 仅在私有入口解析并转换为请求内元数据，hooks 不读取身份头或 JWT。
- Data 接收 Gateway 的 GraphQL 字段授权结果与 CAMEL 专用准入结果。公开字段照常执行，受保护资源在上游调用前应用结果。Data 不访问 Auth0 或权限库。
- Dashboard 的用户目录及角色权限配置通过 `IDENTITY` 调用 Gateway。角色权限在 Auth0 管理，Gateway 用 Cache API 缓存 1 小时并逐请求检查。提醒 Cron 通过相同私有目录服务取得收件人，不依赖用户会话。
- Dashboard/Ingest 的 `InternalData` 机器调用保持不变。Quant 在线定时任务使用同一命名绑定，仅查询交易日。Quant 本地的旧机器应用已退役，Gateway 白名单为空。恢复机器 Choice 访问须按 [AUTH](AUTH.md) 重新配置并验证。
- DM、Choice、CAMEL 继续各走 VPC binding，不添加公网回退。CAMEL 拆借查询、Excel 导入、PDF 上传和还款草稿由浏览器直接调用 `/data/camel/*`，Gateway 对精确资源校验独立拆借读/导入权限和 POST 同源后，经 GatewayData 的专用 CAMEL verdict 分派；不经过 Dashboard 业务后端。InternalData 继续服务可信机器绑定。ZIP 解析、改名、本地归档及导入编排在浏览器完成，资金凭据、验证码和会话留在 Data。
- Workflow 失败与终止统一由 Messenger 订阅平台事件。omo 和 market-briefing 成功也通知。economic-indicator-sync 的完成事件用于捕获业务 partial/failed，正常成功不通知。Workflow 不再内嵌终态通知。业务消息仍通过 Messaging。新增订阅流程见 [Messenger 运维](../messenger/docs/DEVELOPMENT.md#workflow-订阅)。

## 共享数据接口与业务计算

Data 拥有单资源 REST / 薄 GraphQL 与 Zod DTO。[contracts.ts](../data/src/contracts.ts) 和生成的 [OpenAPI](../data/src/openapi.json) 是字段事实来源。普通列表为顶层 array，对象为 object。分页例外和 `fields` 投影由 [Data API 文档](../data/docs/API.md) 维护，调用方不得推断统一的 `data/list` envelope。

Dashboard 的 market-briefing Workflow 在交易日北京时间 17:00 编排市场点评。分段 REST 与今日聚焦 AI 并发执行，经 DATA binding 取材，按唯一报告契约加工并存 R2。终态通知由 Messenger 订阅平台事件后统一发送 email 与 Telegram。浏览器只读定稿供视觉与文字共用，Data 不生成整份报告。页面行为只读 [市场点评](../dashboard/docs/modules/market-briefing.md) 与 [今日聚焦](../dashboard/docs/modules/market-focus.md)。

Ingest 固定以 `https://eastmoney.hasbai.xyz/data` 表示统一数据基址，但实际列表与详情请求使用 DATA binding。研报与政策采集、归并在 Ingest。Dashboard 负责展示、人工关系和研究点评。双方对同一 D1 的写入分工见 [共享数据库](DATABASE.md#共享-d1)。

Quant Worker 的默认 HTTP 仍固定404。`ResearchReport` 只接受命名服务绑定的 `/REPORT.html` GET/HEAD，资产构建仅包含审阅后的聚合报告，不包含输入/模型/逐笔记录。Gateway `/financing-model/research` 复用 `/financing-model` 的 `model.financing:read`，请求仍经认证、授权及凭据剥离。报告部署不能顺带替换未通过门槛的研究推理代码。

Quant 的债券 pipeline 不调用 R2 或 AI Search 生成卖方观点。保留的 R2 研报查询工具只供独立研究辅助。两融已封存，仅保留显式历史复现入口。

## 身份与授权所有权

Auth0、Gateway 授权入口、Data 公开资源/机器身份的完整架构、范围与测试规则只在 [AUTH](AUTH.md) 维护。权限表所有权见 [DATABASE](DATABASE.md#neon-领域与迁移所有权)。本文件只记录服务拓扑。

## 变更协同

- 路由/绑定变化：同时核对生产 Wrangler 路由、命名 entrypoint、本地代理、受影响客户端和契约测试。
- 上游字段变化：先核对 Data DTO，再检查实际 Dashboard / Ingest / Quant 消费者，不凭一个页面成功判断契约兼容。
- 数据落库变化：按 DATABASE 定位读写双方及 migration 所有方。各仓库独立测试和提交。
- VPC 健康以部署到 edge 的 smoke 为准。本地 preview 超时和历史迁移记录不能证明当前生产状态。操作见 [Data 开发与验证](../data/docs/DEVELOPMENT.md)。

## 用户通知中台

Messenger 的逻辑通知 inbox 与投递 outbox 经 Queue 解耦。Dashboard 只提交类型/内容/目标账号，个人联系方式、类型订阅、渠道选择和 Web Push 设备均由 Messenger 维护。Workflow 终态事件也进入逻辑通知层。Messenger 集中拥有项目组唯一分钟 Cron。

按原计划 UTC 分钟分派 Dashboard / Data / Ingest / Quant 的私有 ScheduledTasks，业务时间窗、交易日与 Workflow 幂等仍由各所有方维护。Messenger 同时拥有交易/融资提醒扫描，将 D1 trading 订阅用户名单交给 Dashboard 私有 NotificationSource 扫描。业务表查询仍在所有方。通知投递只依据 Messenger D1，不查询 Auth0 权限。

设置页面仍使用既有登录和管理员边界。PWA 静态资源经 Gateway 精确公开，Service Worker 不缓存受保护页面或 API。
