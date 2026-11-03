# 央行资讯通知

只处理含 `经济数据&政策` 标签且标题以 `中国央行：` 开头的新增资讯。

Cron → Data → 业务筛选/去重 → TelegramWorkflow → MESSENGER（messenger#Messaging）→ D1 / Queue → Telegram。

- TelegramWorkflow 只生成内容，并提交稳定的 `central-bank/articleId` 幂等键。渠道凭据、限流、发送尝试和自动重试归 Messenger。
- `telegram_delivery` 保留历史 `sent_at` / `telegram_message_id`。新记录只写 `messenger_id` / `submitted_at`，不表示 Telegram 已发送。
- 提交失败由 Workflow 或后续采集重试，并发提交由 Messenger 的业务键去重。
- 历史成功记录不重新投递。新消息的最终状态和人工重试在 Dashboard `/management/messenger` 查看。
- Telegram 结果不确定时不自动重发，管理员确认重复风险后才可手动重试。
