# 融资 SOP 与提醒

入口：`/financing/sop`、`/financing/sop/[id]`、`/financing/sop/reminders`。项目规则见 [融资项目](financing-projects.md)。

## 提醒规则

- 提醒规则作用于由 SOP 节点生成的项目任务，一条规则可关联多个节点。时段提醒仍以完成时点 `due_date` 为锚点，不在启动日另发。
- 一条规则支持 1–20 个提醒周期，每个周期为“提前 x 天 x 小时”。整天周期在对应日期 09:00（`Asia/Shanghai`）发送。含小时的周期相对节点到期日 00:00 倒推，在所得整点发送。
- 目标账号来自任务负责人、项目负责人或已解析为本站账号的规则收件人。渠道和联系方式由 Messenger 订阅决定，规则里历史 `email` 列只作兼容。
- 同一 `(rule_id, target_id, period_id)` 只发送一次，同日多个小时周期分别记录。
- 记录状态：Messenger 未绑定或 dry-run 为 `pending`，成功提交为 `queued`。`queued` 和 `accepted` 都不等于终端送达，新渠道结果以 Messenger 为准。历史 `sent` 不改写。

## 数据模型

- `projects`、`project_tasks` 是独立的融资项目体系，不引用负债。
- `sop_templates`、`sop_nodes` 定义模板和相对日期节点。`default_offset_days` 是计划/完成偏移，`default_start_offset_days` 为空表示时点，非空表示时段的启动偏移。两者都相对计划簿记日 T，按自然日，范围 -3650 至 3650，启动不晚于完成，可配同日时段。
- `reminder_rules`、`reminder_rule_nodes`（规则与节点多对多）、`reminder_rule_periods`（可排序的多个提前周期）保存规则。
- `reminder_deliveries` 以 `(rule_id, target_id, period_id)` 去重，保存 `scheduled_for`、实际结果和逻辑通知提交 ID。
- 删除项目用已有事务服务同步清理任务与提醒，页面不串联多个删除请求。

## 页面

- SOP 节点用左侧手柄拖拽排序，鼠标、触控和键盘共用同一个原子服务端动作，节点顺序有业务含义。
- 新增和编辑节点都可选“时点 / 时段”，时段配置启动、完成两个偏移。模板调整只作用于之后新建的项目，已有项目日期在项目详情维护。
- 新增节点只通过右下角固定加号打开居中模态框，页面不常驻新增表单。
- 融资日历默认周一至周五，可展开为周日起的七列整周。五列模式逐周跳过周末，月初为周日时仍从前一周周一对齐，当月工作日不得丢失。
- 日历事件按“负债简称•事件摘要”展示并可下钻。事件过多用“更多”入口，不缩小字号。
- 顶栏提醒展示未来 7 天与逾期节点，每条可进入对应项目。

## 调度

提醒由 Messenger 的分钟 Cron 经私有 `NotificationSource` 的 `/scan` 触发，Dashboard 不再有小时 Cron。调度通则见 [共享架构](../../../docs/ARCHITECTURE.md#用户通知中台)。

- `/scan` 请求含 `scheduledTime` 和 `userIds`（Messenger D1 的订阅名单）。责任人/经办人和规则指定的本站账号形成 `userIds`，提交 financing 通知事件。投递只依据 Messenger D1 的订阅、联系方式和设备，不查 Auth0。融资责任人映射不属于投递权限，仍由融资模块维护。
- 交易提醒先检查工作日及节点起止时间的五分钟窗口，仅在可能到期时才扫描 trading 订阅名单。
- 部署顺序：先部署携带 `userIds` 的 Messenger，再部署 Dashboard。

### 空闲扫描检查点

D1 `financing_reminder_checkpoint`（migration `1020`）保存单行调度元数据，不复制 Neon 业务数据或账号资格。SQL 候选集为空且非 dry-run 时，下一次访问 Neon 推迟到下一个整点。提醒周期均为整小时，原自然日、09:00 和小时倒推规则不变。存在候选（即使没有有效收件人）、发送失败或查询失败时仍按分钟重试。

- `/financing` 下所有写请求在动作前后同步失效检查点，generation 条件更新防止并发扫描写回旧的空结果。数据库错误直接返回失败，不把失败缓存为空。
- 直接 SQL / CLI 修改不经 HTTP hooks，下一整点自动重查。需要下一分钟生效时，在修改前后对 D1 执行 `UPDATE financing_reminder_checkpoint SET generation=generation+1,next_scan_at=0 WHERE id=1`。不要为刷新检查点而改 Neon 业务内容。
- 部署须先应用 Dashboard 的 D1 migration。无业务变更时回滚 Worker 即恢复分钟扫描，检查点表可保留。
