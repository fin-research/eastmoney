# Data 内部架构

跨服务拓扑、VPC 所有权与生产路由只在[共享架构](../../docs/ARCHITECTURE.md)维护。本文件拥有 Worker 内部依赖方向。任务先由 [AGENTS](../AGENTS.md#context-routing) 分流。

```text
默认 fetch → 404
GatewayData.fetch → Gateway 上下文 / GraphQL 字段结果 → app / Hono 路由
InternalData.fetch ────────→ app / Hono 路由
REST / GraphQL → 相同 typed resolver → 上游 client → Zod DTO
CAMEL client → 会话缓存 / CAPTCHA → AI adapter
```

- [index.ts](../src/index.ts) 区分关闭的默认入口与私有的 `GatewayData`、`InternalData`、`ScheduledTasks`。入口由 binding 选择，请求头无法选择，见[入口与访问边界](#入口与访问边界)。
- [public-access.ts](../src/public-access.ts) 只消费 Gateway 的版本化上下文和 GraphQL Choice 字段结果。
- [app.ts](../src/app.ts) 只装配路由。DM 的签名与协议解码在 `src/dm/`，Choice 的 RPC 版本校验在 `src/choice/`，网页解析在 `src/eastmoney.ts`。
- 交易日由 [trading-calendar.ts](../src/trading-calendar.ts) 调用 Choice `tradedates`，结果缓存在当前节点的 Cache API：当日和未来 1 小时，历史 24 小时。缓存故障时回源，错误不缓存。公共 HTTP 仍为 no-store。
- 行情快照由 [eastmoney-market.ts](../src/services/eastmoney-market.ts) 通过 Choice CSS 生成。
- REST 与 GraphQL 复用通过契约校验的 DTO。GraphQL 不复制上游读取。字段投影、分页和错误见 [API](API.md)。
- CAMEL 会话和验证码只在 [CAMEL 模块](modules/camel.md)管理。生成式请求统一经 `src/ai-gateway.ts`。
- `EconomicIndicatorSyncWorkflow` 经 Hyperdrive 写入 EDB 与 Quant 原始输入，从 R2 读取资金日报，并在 Data 自有目录归档有限的发行响应。结构由 `edb-migrations/` 维护，页面归 Dashboard，存储边界见[共享数据库](../../docs/DATABASE.md#r2-与检索边界)。
- 定时：Messenger 的分钟 Cron 经私有 `ScheduledTasks` 调用 `src/scheduled-tasks.ts`。Data 的 `triggers.crons` 为空。流程见[经济指标同步](modules/economic-indicator-sync.md)。
- 资源和请求预算是架构边界，CPU 证据见 [CPU_BUDGET](CPU_BUDGET.md)。

## 入口与访问边界

公网认证、公开资源白名单、机器凭据和路由权限由 [Gateway](../../gateway/AGENTS.md) 维护，权限矩阵见[共享 AUTH](../../docs/AUTH.md#公开仅登录与业务权限)。Data 不校验 JWT，不查询 Auth0 或权限表，只消费 Gateway 的准入结果。

- `GatewayData`：只由 Gateway 的 `DATA` binding 调用，接收版本化 Base64URL 上下文。`/camel/*`、`/mcp` 和 GraphQL 的 Choice 字段按上下文中的准入结果执行。
- `InternalData`：Dashboard 和 Ingest 的机器调用，直接执行内部资源，不依赖用户会话。
- `ScheduledTasks`：仅供 Messenger 的定时调用。
- 默认 fetch：所有路径、方法和自报身份头都返回 404。Wrangler 设置 `routes=[]`、`workers_dev=false`、`preview_urls=false`，没有 Custom Domain。

入口由 Cloudflare binding 选择，URL、Host、Cookie 和自报头都不能选中入口。联调与发布后核对见 [DEVELOPMENT](DEVELOPMENT.md#权限专项验证)。

## 私网上游

VPC service 经 `office` tunnel 连接，service id 以 [wrangler.jsonc](../wrangler.jsonc) 为准。

| binding | VPC service | 目标 |
| --- | --- | --- |
| `DM` | `dm` | `rest.innodealing.com:80,443` |
| `CAMEL` | `camel` | office `10.6.88.192:7000`，HTTP |

- DM：Worker 用 `DM_COOKIE` 中的 `device_id` 重算 MD5 签名，解码 JSON 和 deflate/gzip protobuf。
- Choice：私有 `CHOICE_SESSION` Durable Object 经出站 TCP 和 HTTPS 访问厂商服务，不走 VPC。会话、令牌有效期、费用和离线验证边界见[原生协议迁移](modules/choice-native.md)，该迁移尚未部署。
- CAMEL：无公共业务路由，浏览器经 Gateway 调用 `/data/camel/*`，详见 [CAMEL](modules/camel.md)。

东方财富网页与行情走普通 fetch，网络等待不计入 CPU。
