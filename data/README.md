> 生产入口由 Gateway 统一承接。Data 只有 `GatewayData`、`InternalData`、`ScheduledTasks` 私有 Service Binding，默认 fetch 返回 404。

# Eastmoney Data Worker

为 Eastmoney 站点提供统一的 `/data/*` 数据 API，覆盖 DM、Choice 与东方财富网页/行情。公共 REST、OpenAPI、Swagger/ReDoc、薄 GraphQL 和 MCP 由 TypeScript Hono Worker 承载。CAMEL 资金系统经 Gateway 授权的 `/data/camel/*` 和内部客户端调用。

DM、Choice、CAMEL 经 office 私网访问。Choice SDK 由 [Choice](../choice/README.md) 项目运行。Data 输出单资源契约，Dashboard 负责报告业务加工。

## 使用与开发

```bash
pnpm install
pnpm check
pnpm deploy:dry
```

DM、东方财富网和固定市场快照公开只读。Choice 通用查询要求登录，CAMEL 要求拆借权限。GraphQL 按字段使用相同规则，权限矩阵见[共享 AUTH](../docs/AUTH.md#公开仅登录与业务权限)。字段与调用方式见 [API](docs/API.md)，私有入口见 [ARCHITECTURE](docs/ARCHITECTURE.md#入口与访问边界)，上游连通性与发布见 [DEVELOPMENT](docs/DEVELOPMENT.md)。

## 文档入口

- [AGENTS](AGENTS.md)：本项目硬规则、命令和[模块分流](AGENTS.md#context-routing)。
- [项目组规则](../AGENTS.md)：跨项目架构、数据库、Choice 与 AI 专题。
