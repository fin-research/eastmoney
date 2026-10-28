# 统一权限迁移（历史）

本文只记录 Dashboard 融资人员与权限模型首次合并的历史边界。现行身份、Auth0 角色授权、Gateway 权限缓存和程序化验收见 [项目组 AUTH](../../docs/AUTH.md) 与 [Gateway 开发](../../gateway/docs/DEVELOPMENT.md)。不得按本文恢复 Access、权限数据库运行时读取或重新播种角色。

2026-09-08 的迁移将融资负责人、任务执行人、周报生成人和 SOP 默认角色关联到已确认的 Auth0 ID。替换账号须通过仓库外的 `--person-map` 逐人确认，不能按姓名或邮箱猜测。旧 `financing.people`、`role_permissions`、`audit_logs` 被移除。历史 migration 与脚本保留用于回溯，不对生产重放。旧 `authorization` 表不再是运行时授权来源。迁移前受限数据库分支 `backup-unified-permissions-20260908` 曾用于回退准备，其状态需实时核验，不能据此推定今日仍可恢复。

若回退到依赖旧表的 Worker，必须先在受控数据库分支恢复并核对旧 schema 与业务数据，再成套切回代码和连接。不能只回滚 Worker，也不得覆盖迁移后新增的业务数据。
