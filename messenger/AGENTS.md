# Messenger

独立 Cloudflare Worker，拥有消息投递、重试、D1 `messenger` 与 Queue `messenger`。遵循[根 AGENTS](../AGENTS.md)。

- Hono + Zod 管理私有 HTTP 契约。Resend 与 grammY 分别拥有渠道 API。
- `Messaging` 仅供业务 Worker 提交，`MessengerAdmin` 仅供 Dashboard 管理端。默认 fetch 固定返回 404，无公网路由、workers.dev 和 preview。
- 业务内容与收件人规则归调用方，Secret 与渠道重试归本项目。
- D1 是事实来源，Queue 只携带 ID。异步状态变化用条件更新，以抵御至少一次交付。
- Telegram 结果不确定时不自动重试，因为重发可能造成重复消息。
- `accepted` 只表示渠道接收，不是送达。模拟渠道的测试不证明真实投递。
- schema 变更新增 migration，不改写已应用文件。
- 日志不含密钥、bot URL 和完整消息正文。

检查、migration 与发布命令见[开发运维](docs/DEVELOPMENT.md)，接入示例见 [README](README.md)，投递状态与通知边界见[架构](docs/ARCHITECTURE.md)。
