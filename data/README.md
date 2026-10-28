> 生产入口由 Gateway 统一承接。Data 只有 `GatewayData` / `InternalData` 私有 Service Binding，默认 fetch 404，不开放 workers.dev/preview。

# Eastmoney Data Worker

为 Eastmoney 站点提供统一 `/data/*` 数据 API，支持 DM、Choice 与东方财富网页/行情。CAMEL 资金系统目前提供内部客户端。公共 REST、OpenAPI、Swagger/ReDoc 与薄 GraphQL 由 TypeScript Hono Worker 承载。

DM、Choice、CAMEL 通过 office 私网访问，Choice SDK 由独立 [Choice 仓库](../choice/README.md) 运行。Data 输出单资源契约，Dashboard 负责报告业务加工。

## 使用与开发

```bash
pnpm install
pnpm check
pnpm deploy:dry
```

DM、东方财富网及固定市场快照公开只读。Choice 通用查询要求登录，CAMEL 仍只有内部客户端。GraphQL 按字段使用相同规则。字段与调用方式见 [API](docs/API.md)，访问保护见 [access-migration](docs/access-migration.md)，真实上游连通性与发布见 [DEVELOPMENT](docs/DEVELOPMENT.md)。

## 文档入口

- [AGENTS](AGENTS.md)：本仓库硬规则与命令。
- [模块分流](AGENTS.md#context-routing)：按 REST、DM、网页、Choice、CAMEL 或身份模块读取。
- [项目组规则](../AGENTS.md)：按需读取跨项目架构、数据库、Choice 与 AI 专题。
- [历史迁移记录](docs/MIGRATION.md)：旧切换与排障证据，非当前生产状态说明。
