# Messenger 开发运维

依赖由[根 workspace](../../pnpm-workspace.yaml)统一管理，安装见[根 README](../../README.md#开发)。

## 验证与发布

```sh
pnpm typegen
pnpm check
pnpm test
pnpm deploy:dry
git diff --check
```

monorepo PR 经合并队列进入 `main` 后，Messenger 目录变更触发 Cloudflare Git 自动构建。跨服务变更先确认提供方 entrypoint 已上线，再发布依赖其绑定的消费者。必要的手动发布使用同一已验证提交。

Schema 变化新增 migration。生产变更先执行 `pnpm db:migrate:remote`，再部署 Worker，并核对版本与私有 binding。真实外发测试须明确收件人和发件人。

Worker Secret 为 `RESEND_API_KEY`、`VAPID_PRIVATE_KEY`。Secrets Store 保存 `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_USER_ID`。VAPID 公钥是公开配置。`.dev.vars` 和 `.env` 不提交。

## Workflow 订阅

平台事件映射以 [workflow-events.ts](../src/workflow-events.ts) 和 [wrangler.jsonc](../wrangler.jsonc) 为准。Data 内部的 `dm-funding-sync` 子流程由主 `economic-indicator-sync` 汇总并通知，订阅脚本排除它。

新增 Workflow 的顺序：

1. 部署所有方的 binding。
2. 创建事件 Queue 与死信 Queue。
3. 应用 Messenger migration 并部署 Worker。
4. 运行 `node scripts/sync-workflow-subscriptions.mjs` 查看只读计划。
5. 核对后加 `--apply` 同步。

脚本不覆盖来源不同的已有订阅，缺少 binding 时失败。死信先核实原因，再原样重投事件 Queue。未知 schema 不得当成功丢弃。

## 恢复

D1 是事实来源，Queue 只调度 ID。先检查 inbox、outbox、lease、retry_audit 和死信，再决定恢复或人工重试。Telegram `uncertain` 须先确认渠道结果。Resend 幂等窗口过期后不能盲目重发。订阅与设备变更不通过重放旧消息改写。
