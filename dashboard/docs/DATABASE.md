# 数据与存储

Schema 和字段以 migration 与代码为准。本文只维护 Dashboard 的连接、事务、日期与导入规则。D1 共享读写、Neon schema / migration 所有方和 R2 桶归属见 [共享数据库](../../docs/DATABASE.md)。表和业务对象见 [Context Routing](../AGENTS.md#context-routing)。

## R2

绑定以 [wrangler.jsonc](../wrangler.jsonc) 为准。`EASTMONEY` 和 `LIABILITY_REPORT_SNAPSHOTS` 指向私有 `eastmoney` 桶，`MARKET_BRIEFING_R2` 指向 `market-briefing` 桶。

- `bond-ledger/imports/<uuid>.xlsx`：二级池原件的独立版本。浏览器解析后随结构化数据上传，服务端校验并归档，再单事务切换数据库中的成功导入记录。提交响应丢失时保留原件，归档失败的不进成功清单。历史 `bond-ledger/YYYY-MM-DD.xlsx` 仍可下载。页面统计只读数据库。
- `market-briefing/YYYY-MM-DD.json`（`market-briefing` 桶）：市场点评定稿，只含规范报告字段、今日聚焦和定稿时间，不含上游原始响应。Workflow、定稿 API 和主动生成经 `MARKET_BRIEFING_R2` 读写，prototype-lab 静态页经公开域名只读同一对象。
- `fund-reports/YYYY-MM-DD.html`：资金日报，同一天再次上传会替换。列表只枚举该前缀并过滤严格日期文件名，单期读取由严格日期派生 key，路由不接受任意对象 key。需要审批或同日版本历史时，再增加独立元数据模型。
- `credit/public/` 的授信公开 PDF 按 [授信助手](CREDIT_ASSISTANT.md) 读取，不套用台账上传流程。
- 负债周报快照的 key、版本与读写规则见 [负债周报](modules/liability-report.md)。

## 变更检查

- D1：本地应用 migration，运行热点快照和证据测试。
- Neon：在 PostgreSQL 兼容环境应用 migration，检查约束、索引、事务回滚和追加顺序。
- 二级池导入解析变化：先运行 `pnpm bond:db:backfill` 只读盘点，授权后加 `--apply` 写入。
- 授信导入解析变化：先运行 `pnpm credit:import -- --file <xlsx> --date YYYY-MM-DD --dry-run`，确认目标环境后去掉 `--dry-run`。

## 连接与事务

- 同一个 Hyperdrive binding 不合并业务 schema。
- 融资请求经 `locals.database` 最多创建一个 Client，在 middleware 的 finally 中关闭。其他模块用各自的 repository。
- 连接、临时身份和事务状态不跨请求复用。
- 融资 migration 沿用 `financing.schema_migrations`。数据后台的 RLS、字段白名单和台账结构见 [融资数据](modules/financing-data.md)。
- 现行所有权见[共享数据库](../../docs/DATABASE.md#neon-领域与迁移所有权)。
- 身份统一迁移 `financing-migrations/0032` 已在生产应用，不重放。

## 日期与时间戳

- 融资上传原始文件中的无时区时间按 UTC+8 解释。`date` 是业务自然日，不转时区。
- `timestamp without time zone` 在融资 Client 的解析边界补 `+08:00`。`timestamptz` 保留来源 offset 和微秒精度，不再补 Z 或平移八小时。页面显示固定 `Asia/Shanghai`。
- 类型解析只配置在融资 Client（`src/lib/financing/postgres.js`），不调用全局 `pg.types.setTypeParser`，其他 schema 保持默认语义。
- 乐观锁用的 `updated_at` 不转成丢失微秒的 JavaScript Date。
- Excel 业务日期按 `cellDates:false` 提取日历日期。用 UTC 做 date 加减只是日历算法，不用于原始 timestamp。
- SQLite 本地维护脚本按字段类型补全缺失时区，不批量改写已有数据库历史。
