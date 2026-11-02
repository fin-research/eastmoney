# Messenger 内部架构

## 消息投递

D1 保存 messages、attempts 与审计，Queue 只携带 ID。状态为 `queued → processing → accepted / retrying / failed / uncertain`。先持久化再入队，消费者用 D1 条件认领抵御至少一次交付。Cron 每分钟恢复未入队、到期重试与过期 lease。

永久失败直接结束。其余最多尝试 6 次，从 30 秒起指数退避，上限 1 小时。Telegram 429 遵循 `retry_after`。Telegram 结果不确定时进入 `uncertain`，只经人工确认后重发。Resend 使用稳定的渠道幂等键，仅在幂等窗口内自动重试，窗口过期后进入 `uncertain`。

人工重试生成新一轮键并记录操作者，操作者取自 Dashboard 已验证的身份，不接受浏览器指定。

消息批次按 email、Telegram、Web Push 和逻辑通知分组。组间并行，组内保持顺序，逐条确认或重试。两类 Queue 的批大小、等待和并发见 [wrangler.jsonc](../wrangler.jsonc)。调整时核对事件到达至渠道启动的延迟，以及同渠道顺序。

历史业务投递记录保留，新的渠道结果以 Messenger 为准。

## Workflow 终态订阅

平台 Event Subscriptions 把 Workflow 事件送到 `messenger-workflow-events`。Messenger 按实例 ID 读取状态和错误，先存 `workflow_events` inbox 并冻结通知快照，再展开到消息 outbox。

- 全部 Workflow 订阅失败与终止。
- omo、market-briefing 还订阅完成。economic-indicator-sync 的完成事件只用于识别业务 partial/failed。
- 经济同步 completed 结果若只含明确的 `kind=data_gap` 缺口，仍通知用户，标题为“Workflow 数据缺口”。正文按业务组汇总原因、数量和样例，完整清单留在实例中。混合执行错误和平台 error/terminated 按失败或终止通知。

Workflow 内不重复发送终态通知。写入 inbox 前失败由 Queue 重试，耗尽进入死信队列。写入后的查询或入队失败由 Cron 恢复。新增 Workflow 按[开发运维](DEVELOPMENT.md#workflow-订阅)执行。

## 用户通知与 Web Push

`POST /notifications` 写入逻辑通知，Queue 只携带 `{id,kind:"notification"}`。Messenger D1 独占订阅、联系方式和 Push 设备。调用方只决定业务类别、内容和目标账号。发送前重新检查退订与设备归属。

Web Push 使用 VAPID 与 aes128gcm，限制浏览器厂商推送域并禁止跟随重定向，以免推送凭据被送往其他地址。404/410 移除失效设备，429/5xx 退避。endpoint/auth/p256dh 不进入日志或管理详情。

Messenger 每分钟带上 D1 中交易订阅用户的名单，调用 Dashboard 私有 `NotificationSource` 的 `/scan`。候选业务查询归 Dashboard，投递资格只依据 Messenger D1，不查询 Auth0。扫描槽位与 lease 由 Messenger 维护。

管理员测试消息按选定用户和渠道使用已保存的联系方式。批次与目标冻结，重试不能更换收件人。

## 集中调度

Messenger 是项目组唯一的 Cloudflare Cron（`* * * * *`）。[scheduler.ts](../src/scheduler.ts) 把 `scheduledTime` 向下归一到 UTC 分钟，匹配固定任务表，再经四个私有 `ScheduledTasks` Service Binding 发出 `POST /scheduled?scheduledTime=<毫秒>`。全部调用完成后分别记录结果。

| 绑定 | UTC 时间表 |
| --- | --- |
| INGEST_SCHEDULE | `*/5 0-9 * * MON-FRI` |
| DASHBOARD_SCHEDULE | `0 9 * * MON-FRI` |
| DATA_SCHEDULE | `0 16 * * *` |
| QUANT_SCHEDULE | `30 0 * * MON-FRI` |

- 通知恢复与业务调度互不阻断。采集、交易日判断、Workflow 创建和幂等归各业务仓库。
- 消费者只在命名入口接受分钟对齐的计划时间。`GET /health` 只用于私有绑定的连通性验证。
- 成功响应表示该轮编排完成或正常跳过，不表示 Workflow 已成功。日志 `scheduled_task_completed` / `scheduled_task_failed` 对应各私有调用。
- 错过的槽位不自动补跑，失败实例不自动重启。
- 其他 Worker 的 wrangler 显式设 `triggers.crons=[]`，防止发布时恢复 Cron。
- 新增任务时同步绑定、时间表与所有方测试。
