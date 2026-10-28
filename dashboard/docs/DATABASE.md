# 数据与存储

Schema 和字段以 migration 与代码为事实来源。本文件只维护 Dashboard 的连接、事务、日期与导入规则。D1 共享读写、Neon schema/migration 所有方和 R2 桶归属只读 [共享数据库](../../docs/DATABASE.md)。具体表和业务对象见 [模块分流](../AGENTS.md#context-routing)。

## R2

业务报告使用私有 `eastmoney` bucket。`EASTMONEY` 与 `LIABILITY_REPORT_SNAPSHOTS` 指向该桶，授信问答只读取 `credit/public/` 下的 PDF。旧 `credit` 桶不再绑定生产 Worker。绑定事实以 [wrangler.jsonc](../wrangler.jsonc) 为准。报告对象使用固定前缀：

- `bond-ledger/imports/<uuid>.xlsx`：二级池原始 Excel 独立版本。浏览器解析后随结构化数据上传，服务端校验并归档，再单事务切换数据库成功导入记录。提交响应丢失时保留原件。失败归档不进入成功清单。历史 `bond-ledger/YYYY-MM-DD.xlsx` 继续可下载。页面统计只读数据库。
- `market-briefing/YYYY-MM-DD.json`：市场点评定稿快照，只包含规范报告字段、今日聚焦和定稿时间，不含原始上游响应。由 market-briefing Workflow 汇总写入。所有日期页面都只读该日定稿，旧手动保存接口保留兼容。
- `fund-reports/YYYY-MM-DD.html`：资金日报。同一天再次上传会替换该日报。读取路由不得接受任意对象 key。

资金日报当前不需要 D1/Neon 索引：上传文件名已经提供日期，公开 URL 和 R2 key 都可由日期直接确定。历史列表只枚举 `fund-reports/` 固定前缀并过滤严格日期文件名。需要审批或同日报告的版本历史时再增加独立元数据模型。

负债周报快照由 [负债周报模块](modules/liability-report.md) 维护 key、版本与读写规则。授信材料与会话存储按 [授信助手](CREDIT_ASSISTANT.md) 读取，不能套用台账上传流程。

## 变更检查

- D1：本地应用 migration，运行热点快照和证据测试。
- Neon：在 PostgreSQL 兼容环境应用对应 schema migration，检查约束、索引、事务回滚和追加顺序。
- 二级池导入解析变化：先运行只读回填盘点。只有明确授权并使用 `--apply` 才写入。
- 授信导入解析变化：先运行 `pnpm credit:import -- --file <xlsx> --date YYYY-MM-DD --dry-run`。确认目标环境后去掉 `--dry-run` 写入。

## 统一 Worker 下的数据库边界

Schema 与 migration 的所有权表已集中到 [共享数据库](../../docs/DATABASE.md#neon-领域与迁移所有权)，不在本文件复制。

同一个 Hyperdrive binding 不合并业务 schema。融资请求通过 `locals.database` 至多创建一个 Client，在 middleware 的 finally 中关闭。其他模块继续使用其既有 repository。日期字符串解析器只绑定融资 Client，禁止全局修改 pg 的 type parsers。数据库连接、临时身份与事务状态不能跨请求复用。

融资 migration 原样迁入并沿用 `financing.schema_migrations`，此次仓库合并不重建表、不重放已执行 migration，也不复制生产数据。数据后台的 RLS、字段白名单及台账继承结构见 [融资数据模块](modules/financing-data.md)。

## 日期与时间戳

融资上传原始文件中的无时区时间以 UTC+8 为准。`date` 是业务自然日，不做时区转换。`timestamp without time zone` 在融资 Client 的解析边界显式补 `+08:00`。`timestamptz` 保留来源明确的 offset 和微秒精度，不能再补 Z 或重复平移八小时。页面显示固定为 `Asia/Shanghai`。

不得调用全局 `pg.types.setTypeParser`。融资 Client 使用自己的 parser 配置，其他 schema 保持默认语义。乐观锁用的 `updated_at` 不转成丢失微秒的 JavaScript Date。SQLite 本地维护脚本按字段类型补全缺失时区，已有数据库历史不因代码合并批量改写。Excel 的业务日期继续按 `cellDates:false` 提取日历日期。用 UTC 做 date 加减只是日历算法，不能把它当原始 timestamp。

## 历史统一权限迁移

Auth0 与 Gateway 现行拥有角色授权。旧 `authorization` 表和 migration 仅供回溯，Dashboard 不持有权限连接。首次融资身份迁移把负责人、任务执行人、周报生成人和 SOP 默认角色改为已确认的 Auth0 ID。历史数据不重放。必要的回退边界见[历史记录](UNIFIED_PERMISSIONS.md)，当前所有权见[共享数据库](../../docs/DATABASE.md#neon-领域与迁移所有权)。
