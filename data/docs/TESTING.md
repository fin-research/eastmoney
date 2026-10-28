# Data 测试

测试取舍遵循[项目组测试规范](../../docs/TESTING.md)。`pnpm test:coverage` 使用 Vitest V8 provider，`src/**/*.ts` 包含未执行源码。HTML、JSON summary 和 LCOV 写入忽略的 `coverage/`。覆盖率只说明该次执行范围，不代表生产 VPC、权限或 CPU 验收。

REST、GraphQL 与 MCP 各保留代表性的公开、鉴权和资源链路测试。共享 DTO 字段枚举由契约测试维护。上游 URL 与请求体由客户端层测试，Worker 入口须验证默认拒绝和私有 binding 边界。空值、脱敏、长度限制及失败状态不能为提高覆盖率而删除。生产 CPU 另按 [CPU 预算](CPU_BUDGET.md) 验证。
