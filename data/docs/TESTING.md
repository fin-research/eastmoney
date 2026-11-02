# Data 测试

测试取舍遵循[项目组测试规范](../../docs/TESTING.md)。`pnpm test:coverage` 使用 Vitest V8 provider，`src/**/*.ts` 含未执行源码。HTML、JSON summary 和 LCOV 写入被忽略的 `coverage/`。覆盖率只说明该次执行范围，生产 VPC、权限和 CPU 另行验收，CPU 见 [CPU 预算](CPU_BUDGET.md)。

REST、GraphQL 与 MCP 各保留代表性的公开、鉴权和资源链路测试。DTO 字段枚举由契约测试维护，上游 URL 与请求体由客户端层测试。Worker 入口测试覆盖默认拒绝和私有 binding 边界。空值、脱敏、长度限制和失败状态各保留用例。
