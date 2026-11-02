# 通知管理

入口：`/management/messenger`，仅 admin。Gateway 的 GET、POST:retry、POST:sendTest 均校验 admin，Dashboard 对可信身份再查一次角色。两个标签页 `?tab=delivery` / `?tab=test` 的深链规则见 [DESIGN](../../DESIGN.md)。

## 页面

- 消息投递：显示渠道、来源、状态、收件人和发送尝试，支持人工重试。测试消息用 `admin-test` 来源筛选。
- 测试消息：标题和正文有可编辑默认值，支持单发和最多 50 人群发，渠道可选邮件、Telegram、Web Push。
- 收件人只能选当前有效账号，服务端重新核对用户 ID。联系方式由 Messenger 按个人通知设置解析，不用账号邮箱代替。未配置的渠道逐项显示未发送，测试发送不要求订阅业务类型。

## 契约

- `MESSENGER` / `MESSENGER_ADMIN` 分别绑定 Messenger 的 `Messaging` / `MessengerAdmin`。
- 测试批次经 `/test-messages` 保存幂等请求、冻结目标和审计 actor（由可信身份派生），由现有队列投递。网络重试复用请求 ID，失败保留输入。
- 大批次由 Messenger 分钟 Cron 续发，发送前重查联系方式和设备。
- D1、Queue、渠道凭据和重试归 Messenger 所有。Dashboard 不直连渠道，入队不等于送达。
- 融资提醒历史保留原表：`queued` 表示已提交 Messenger，`provider_message_id` 保存消息/通知 ID，最终结果以消息投递页为准。旧 `sent` 行保持原 ID。
