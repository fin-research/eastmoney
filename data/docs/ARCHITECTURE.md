# 当前入口

Data 仅经 Gateway 的 `GatewayData` 或机器消费者的 `InternalData` Service Binding 接入。公网路由、JWT、Auth0、机器 token 和字段授权在 Gateway。默认 fetch 404，workers.dev/preview 关闭，详见 [访问边界](access-migration.md)。

# Data 内部架构

跨服务拓扑、VPC 所有权与生产路由只在 [共享架构](../../docs/ARCHITECTURE.md) 维护。本文件拥有 Worker 内部依赖方向。任务先由 [AGENTS](../AGENTS.md#context-routing) 分流。

```text
默认 fetch → 404
GatewayData.fetch → Gateway 上下文 / GraphQL 字段结果 → app / Hono 路由
InternalData.fetch ────────→ app / Hono 路由
REST / GraphQL → 相同 typed resolver → 上游 client → Zod DTO
CAMEL 内部 client → 会话缓存 / CAPTCHA → AI adapter
```

- [index.ts](../src/index.ts) 区分关闭的默认入口与私有 `GatewayData` / `InternalData`，不能让公网 caller 通过 header 选择入口。
- [public-access.ts](../src/public-access.ts) 只消费 Gateway 的版本化上下文和 GraphQL Choice 字段结果，不验证 JWT 或调用身份服务。精确公开资源策略由 Gateway 维护，见 [访问保护专题](access-migration.md)。
- [app.ts](../src/app.ts) 只装配路由。DM 的签名与协议解码留在 `src/dm/`，Choice 的 RPC 版本校验留在 `src/choice/`，网页解析留在 `src/eastmoney.ts`。交易日由 [trading-calendar.ts](../src/trading-calendar.ts) 调用 Choice 专用函数。

  成功响应按市场和日期缓存于当前节点 Cache API：当日/未来1小时，历史24小时。缓存故障回源，错误不缓存。公共 HTTP 仍为 no-store。

  行情快照由 [eastmoney-market.ts](../src/services/eastmoney-market.ts) 使用 CSS。
- REST 与 GraphQL 复用通过契约校验后的 DTO，不在 GraphQL 复制上游读取或增加市场报告聚合。字段投影、分页和错误见 [API](API.md)。
- CAMEL 会话和验证码只在 [CAMEL 模块](modules/camel.md) 管理。生成式请求统一经 `src/ai-gateway.ts`。
- Data 的 `EconomicIndicatorSyncWorkflow` 通过 Hyperdrive 写入 EDB 与 Quant 原始输入，通过 R2 读取资金日报并在 Data 自有目录归档有限发行响应。`edb-migrations/` 维护其结构。页面仍由 Dashboard 持有。存储边界引用 [共享数据库](../../docs/DATABASE.md#r2-与检索边界)。
- 资源和请求预算是架构边界，CPU 与生产证据见 [CPU_BUDGET](CPU_BUDGET.md)，旧切换记录不作为当前实现规范。

Messenger 私有定时调用 → 上海计划日期交易日检查 → EconomicIndicatorSyncWorkflow → 本地 REST adapter / VPC → Hyperdrive 入库。R2 读取当天资金日报，发行原响应在合并数据库前按[前瞻观察](modules/issuance-observations.md)归档。显式replay只读该目录恢复数据库，不调用上游。详细步骤、回填和发布切换见 [经济指标同步](modules/economic-indicator-sync.md)。

## 定时触发入口

每日 UTC 16:00 的触发由 Messenger 唯一分钟 Cron 匹配，经私有 `ScheduledTasks` 调用 `src/scheduled-tasks.ts`。原计划时间传入 `runEconomicIndicatorScheduledSync`，上海日期、交易日校验和 Workflow 实例 ID 保持不变。Data 的 `triggers.crons` 为空。此入口不属于 REST、GraphQL 或 GatewayData 的公共资源。
