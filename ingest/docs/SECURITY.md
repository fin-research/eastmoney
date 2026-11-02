# 安全边界

## Secret 与配置

- `CF_AIG_TOKEN` 只通过 Worker Secret 注入。
- Telegram 渠道凭据归 Messenger 管理，Ingest 只经 `MESSENGER` Service Binding 提交通知。
- `CLOUDFLARE_ACCOUNT_ID`、`AI_GATEWAY_ID` 与 `ARTICLE_API_BASE_URL` 是非敏感配置，保存在 `wrangler.jsonc`。
- `.env`、`.dev.vars` 和实际 token 不提交。

## 外部数据

- `ARTICLE_API_BASE_URL` 使用 HTTPS 并保留生产 `/data` 契约。Cron 和 Workflow 经 `DATA` binding 的 `InternalData` 读取列表与详情，不依赖浏览器 Cookie。
- 列表、详情、公众号 HTML 和 AI 响应都限长读取并做运行时校验，不把未校验的 JSON 或 HTML 断言为业务类型。
- 公众号 Markdown 清洗移除图片 URL 和链接 URL，保留锚文本，并按既有规则截断风险披露后文。

## AI

- 所有生成式请求经 `src/ai-gateway.ts`。Provider、重试、Prompt Cache、reasoning 参数、限长读取和日志规则只在[共享 AI](../../docs/AI.md)维护。
- Zod Schema 是结构化输出的唯一来源。特征与政策 Prompt 归各业务模块。

## Cloudflare 资源

- D1、R2 与 Workflow 用 binding，不在 Worker 中使用管理 API token。AI Search 独立读取 R2，Worker 不持有其 binding 或管理凭证。
- AI Search 的 `queued` / `running` 状态不是成功。最终复核后才报告修复完成。
- 正文备份和验收记录只存于 Git 忽略的 `var/` 目录。

## 日志

结构化日志只含事件名、数量、文章 ID、公开错误和 Workflow 状态。不记录 Secret、管理 token、完整正文、原始公众号 HTML、外部响应头中的敏感信息，以及 Messenger 的请求体和服务凭据。
