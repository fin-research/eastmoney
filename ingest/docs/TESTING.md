# Ingest 测试

测试取舍遵循[项目组测试规范](../../docs/TESTING.md)。`pnpm test:coverage` 使用 Workers pool 与 Istanbul，因为 workerd pool 的 V8 coverage 会触发 `StubSession` 错误，失败时生成的 0% 不是覆盖率。`src/**/*.ts` 纳入分母，结果写入被忽略的 `coverage/`。

必须保留行为测试的范围：D1 幂等、Workflow 顺序与失败恢复、人工政策关联优先、脱敏、DATA binding 边界。覆盖率不能替代定时采集、真实 AI、线上投递和 R2 索引的验收。
