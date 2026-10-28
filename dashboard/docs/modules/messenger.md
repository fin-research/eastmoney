# 通知管理

`/management/messenger` 仅全站 admin 可访问，包含「消息投递」和「测试消息」两个内部标签页。Gateway 的 GET、POST:retry、POST:sendTest 均要求 admin。Dashboard 对可信身份再次检查角色。

「消息投递」显示渠道、来源、状态、收件人、发送尝试与人工重试，测试消息以 admin-test 来源筛选。「测试消息」提供默认可编辑标题和正文，支持单发、最多 50 人群发，以及邮件、Telegram、Web Push 多渠道选择。只选择当前有效账号，服务端重新核对用户 ID。联系方式由 Messenger 按个人通知设置解析，不使用账号邮箱替代联系邮箱。未配置渠道逐项显示为未发送，测试发送不要求勾选业务类型订阅。

MESSENGER / MESSENGER_ADMIN 分别绑定独立 Worker messenger 的 Messaging / MessengerAdmin。测试批次经 /test-messages 保存幂等请求、冻结目标与审计 actor（由可信身份派生），由现有消息队列投递。后续网络重试复用请求 ID，失败保留输入。大批次由 Messenger 分钟 Cron 继续生成，发送前重查联系方式和设备。D1、Queue、渠道凭据和重试归 Messenger 所有。Dashboard 不直连渠道，入队不等于送达。

融资历史保留原表，queued 表示已提交 Messenger。provider_message_id 保存消息/通知 ID，最终结果在消息投递标签页。旧 sent 行保持原 Provider ID。提醒统一由 Messenger Cron 调度。

验证：Dashboard 表单与 admin 校验单测、Messenger D1 批次/幂等/恢复/联系人校验、Gateway named action 权限矩阵，以及 CI 独立组件的双标签/单发群发/编辑/渠道选择。权限登录只通过程序化 HTTP，不发送真实测试通知。
