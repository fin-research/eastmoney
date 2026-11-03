# AGENTS.md

## Project Overview

私有 Cloudflare 数据 API。Hono TypeScript Worker 在 Gateway 之后，经命名 Service Binding 提供 `/data` 资源。

- DM 经 `DM` Workers VPC binding。
- Choice 经 `CHOICE_RPC` 调用 office 主机上的 C++ SDK 小服务。
- CAMEL 资金系统经 `CAMEL` VPC binding。登录会话缓存在命名 Cache API，验证码经 AI Gateway 识别。

Free 计划不使用 Cloudflare Containers 等付费计算。

## Mandatory Rules

- Gateway 的公网路径保留 `/data`，私有和本地 handler 可用无前缀路径。Data 无 routes、workers.dev 和 preview URL，默认 fetch 返回 404。
- 上游请求只走 VPC binding，没有公网回退：`rest.innodealing.com` 用 `env.DM.fetch`，Choice 用 `env.CHOICE_RPC.fetch`，CAMEL 用 `env.CAMEL.fetch`。
- `DM_COOKIE`、`CHOICE_RPC_TOKEN`、`CF_AIG_TOKEN`、`CAMEL_USERNAME`、`CAMEL_PASSWORD` 是 Worker secret。`CHOICE_AUTH` 只在 office Docker 主机。这些值不进入源码、Wrangler vars、日志、夹具、镜像层和文档。
- CAMEL 会话缓存只存 access token、token name、device ID 和服务端推导的到期时间。
- Gateway 负责公网认证与授权，Data 不校验 JWT。`GatewayData` 消费 Gateway 的判定上下文，`InternalData` 是 Dashboard 和 Ingest 的机器 binding。身份信任只来自 binding，不来自请求头。
- 保持既有状态码、薄 GraphQL 和 `Cache-Control`。GraphQL 镜像全部公共数据资源，委托同一 REST handler 与契约。
- 只暴露单资源字段，不做市场报告聚合、业务计算和上游 envelope。报告加工在 Dashboard。
- REST 上游值先通过 `src/contracts.ts` 的 Zod 契约，才能出公开边界。列表返回顶层 array，对象返回顶层 object。`fields` 白名单和生成的 OpenAPI 与契约同步，不透传上游任意键。
- Worker 须兼容 Workers Free 的 10 ms CPU 上限。路由有本地 CPU profile 和生产 invocation CPU 后，才能称为安全。
- 交付运行 typegen、typecheck、Worker 测试、dry-run 和 diff 检查。RPC 变更在 [Choice](../choice/AGENTS.md) 项目验证。

## Commands

- 安装：`pnpm install`
- 生成绑定类型：`pnpm typegen`
- 类型检查：`pnpm typecheck`
- Worker 测试：`pnpm test`
- 完整静态验证：`pnpm check`
- Worker 与配置 dry-run：`pnpm deploy:dry`
- 启动 profile：`pnpm check:startup`
- CPU 路由基准：`pnpm benchmark:cpu`

## Context Routing

跨项目执行规则见[项目组 AGENTS](../AGENTS.md)，上下文中没有时读一次。只选读受影响的主题。

- Worker 入口、Hono 路由、依赖方向：[ARCHITECTURE](docs/ARCHITECTURE.md)。跨服务变更：[共享架构](../docs/ARCHITECTURE.md)。
- REST、GraphQL、MCP 契约，DM、东方财富网和中国货币网资源：[API](docs/API.md)。私有入口与访问边界：[ARCHITECTURE](docs/ARCHITECTURE.md#入口与访问边界)。
- Choice 查询、行情快照和交易日历：[Choice RPC API](../choice/docs/API.md) 与[额度和限流](../docs/CHOICE.md)。代码入口为 `src/choice/`、`src/services/eastmoney-market.ts`、`src/trading-calendar.ts`。
- CAMEL 与验证码识别：[CAMEL](docs/modules/camel.md) 与[共享 AI](../docs/AI.md)。
- 验证、发布与 VPC smoke：[DEVELOPMENT](docs/DEVELOPMENT.md)。
- EDB 与 Quant 原始输入的同步和回填：[经济指标同步](docs/modules/economic-indicator-sync.md)、[Quant 输入](docs/modules/quant-inputs.md)、[前瞻发行观察](docs/modules/issuance-observations.md)。存储所有权见[共享 DATABASE](../docs/DATABASE.md)。
- CPU 与 subrequest 证据：[CPU_BUDGET](docs/CPU_BUDGET.md)。

## 测试规范

测试新增、合并与覆盖率按 [TESTING](docs/TESTING.md) 执行。权限验收按[共享 AUTH](../docs/AUTH.md#程序化权限测试)，新增测试只用匿名和 `test@18.cn` 两种身份。
