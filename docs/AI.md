# Cloudflare AI Gateway 规范

本文件是 Gateway、Data、Dashboard、Ingest 共用的模型传输与检索规范。业务 Prompt、Zod Schema 和任务类型映射在各调用项目维护。只在 AI 任务中读取。

| 调用项目 | 适配器 | 业务入口 |
| --- | --- | --- |
| Gateway | [ai.ts](../gateway/src/ai.ts) | [通用 Responses API](../gateway/docs/AI.md) |
| Dashboard | [ai-gateway.ts](../dashboard/src/lib/server/ai-gateway.ts) | [按页面选读](../dashboard/AGENTS.md#context-routing) |
| Ingest | [ai-gateway.ts](../ingest/src/ai-gateway.ts) | [按采集模块选读](../ingest/AGENTS.md#context-routing) |
| Data | [ai-gateway.ts](../data/src/ai-gateway.ts) | [CAMEL 验证码](../data/docs/modules/camel.md) |

## 传输契约

生产生成式 AI 必须经过 Cloudflare AI Gateway，不直连上游 Provider。Provider 基础地址、BYOK 和默认密钥别名由 AI Gateway 管理，业务代码不访问 Provider 的 `base_url`。

自定义 Provider 的 Responses API 使用 provider-specific URL：

```text
https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/{provider}/responses
```

不要用 `env.AI.gateway(gatewayId).run({ provider, endpoint: "responses" })` 调用自定义 Provider。该调用走 Universal 适配层。上游返回无法被识别时，会产生 `AiGatewayError`、HTTP 502、内部错误码 2006。

请求头：

```http
Content-Type: application/json
cf-aig-authorization: Bearer ${CF_AIG_TOKEN}
cf-aig-skip-cache: true
cf-aig-collect-log: true
cf-aig-request-timeout: 120000
cf-aig-metadata: {...}
```

- `CF_AIG_TOKEN` 是 Worker Secret。
- `metadata` 标记业务、提示词版本、模型、Provider 和尝试次序。
- 模型较慢时可调大 `cf-aig-request-timeout`，上限 300000 ms。
- 每个 Promise 都 `await`。响应正文限长读取并做运行时校验。
- 日志不记录 Secret、完整输入、完整输出或完整上游错误体。保留 HTTP 状态和 `cf-aig-log-id`。

## 前端 SSE

Dashboard 业务任务的前端统一用 SSE。浏览器经 `src/lib/ai-client.svelte.ts` 发起请求并带 `Accept: text/event-stream`，Worker 以流式请求上游。事件只有三种：

- `progress`：`data` 是去掉 Markdown 加粗标记的公开 reasoning summary 纯文本。
- `result`：`data` 是完整终态 JSON。
- `error`：`data` 是可公开的错误纯文本。

保活用注释帧。`data` 内不重复嵌套 `type` 或 `id`，也不新增 NDJSON 等并行任务流协议。

全站通用 AI 侧栏是例外：浏览器端 `ToolLoopAgent` 经同源 `POST /api/ai/responses` 读取原生 Responses SSE，并在浏览器执行工具循环。该接口由 Gateway 直接处理并持有 `CF_AIG_TOKEN`。参数、CORS、错误脱敏和取消规则见 [Gateway AI](../gateway/docs/AI.md)。

## 默认路径：Provider 原生 Responses API

所有生产生成式调用固定使用：

| 顺序 | Provider | 模型 | Gateway endpoint |
| --- | --- | --- | --- |
| Primary / Retry | `custom-codex` | `gpt-6-luna` | `custom-codex/responses` |

请求体构造见各适配器。

### 重试

Gateway 的通用 Responses 转发不自动重试，由调用方按业务幂等性决定。以下规则适用于 Dashboard、Ingest、Data 的适配器：

1. 重试一次，模型、Prompt 和 Schema 不变。触发条件：网络错误、超时、`408`、`429`、`5xx`、Responses `failed` / `incomplete`、输出未通过 Schema 校验。
2. 其他 `4xx` 是请求、权限或配置错误，不重试。
3. 一次适配器调用最多两次尝试，metadata 分别标 `primary` / `retry`，各自保留状态和 Gateway log ID。均失败后，由外层 Workflow 按既有步骤重试。
4. `credit_answer` 只尝试一次。
5. Codex 返回带 `phase` 的 message 时，只提取 `final_answer`，不把 `commentary` 拼入 JSON。无 phase 的结构化输出照常处理。

### 参数

- 使用 `instructions`、`input`、`reasoning.effort`、`reasoning.summary` 和 `reasoning.context`。不用 Chat Completions 的 `messages` 或顶层 `reasoning_effort`。
- 请求不显式传 `store`，不设置 `include: ["reasoning.encrypted_content"]`。固定 `reasoning.context="current_turn"` 和 `reasoning.summary="auto"`，从 reasoning item 的 `summary` 读取可读摘要。
- effort 由各项目按任务类型映射，调用方不能填任意值。映射见各适配器的 `AI_GATEWAY_REASONING_EFFORT_BY_TASK`，不同项目取值不同。
- 稳定内容（角色、业务规则、输出约束）放 `instructions`。日期、正文、新闻、模型快照和证据卡片只放最后的 `input`。这样才能命中上游 Prompt Cache。
- 每类任务用含 Prompt 版本的稳定 `prompt_cache_key`。key 不含日期、文章 ID、run ID 或随机值。`prompt_cache_key` 只作用于上游 Prompt Cache，Cloudflare 响应缓存由 `cf-aig-skip-cache=true` 关闭。
- 不设置 `max_output_tokens`，不截断输入或有效输出。
- 结构化输出用 `text.format.type=json_schema` 和 `strict=true`，应用端用同一 Zod 或等价 Schema 再校验。
- 从 `output` 中提取 `output_text`，不按 `choices[0].message.content` 解析。
- 成功日志只记录元数据：任务类型、effort、reasoning summary/context 模式、摘要条数与字符数、Prompt Cache token 数、`encrypted_content` 是否存在、`output_text` 长度、Gateway log ID。不记录 Prompt、推理摘要或业务输出正文。

## Decisions API

OpenAI Decisions API（`POST /v1/decisions`，仅 `gpt-6-luna`）当前不能经 `custom-codex` 调用，业务代码不要接入。

- `custom-codex` 的上游是 CLIProxyAPI，凭证为 Codex OAuth 账号。Gateway 对 `custom-codex/decisions` 和 `custom-codex/v1/decisions` 都返回 404 空正文，同一 token 调 `custom-codex/responses` 返回 200。
- CLIProxyAPI 最新版（v8.0.52）及 `main` 未注册 `/v1/decisions`，升级上游无效。透传请求见上游 issue #6586，仍未实现。
- OpenAI 不允许 ChatGPT 订阅或 Codex OAuth 凭证调用该端点，订阅账号上的 `gpt-6-luna` 只能走 Responses API（上游 issue #6917，维护者不计划支持）。
- 需要时，新建指向 `https://api.openai.com/v1` 的自定义 Provider，用 BYOK 存付费 API Key，调用 `…/{provider}/decisions`。

## AI Search

- 研究检索工具是 MCP 工具 `research_search`，由 Gateway `/mcp` 经 Dashboard 提供，上游为 `https://research.hasbai.xyz/mcp` 的 `search`。见 [Dashboard MCP](../dashboard/docs/MCP.md) 和[实现](../dashboard/src/lib/server/research-search.ts)。
- 研报与政策的数据源是 AI Search `research`，索引 R2 `article/report/` 和 `article/policy/`。`type` 是文本 `研报` 或 `政策`。研报专用检索（如卖方观点）加 `type: { "$eq": "研报" }`，政策专用检索用 `政策`，综合检索可覆盖两类。
- 每次检索显式设置 `ai_search_options.retrieval.max_num_results=50`。
- 每次检索对 `published_at` 加硬过滤，不只靠 recency boosting。默认取最近 7 个上海时区自然日。用户指定日期或区间时，按指定值设 `$gte`、`$lte`。边界先按 `Asia/Shanghai` 计算，再转为 Unix 毫秒时间戳。

```json
{
  "query": "用户查询",
  "ai_search_options": {
    "retrieval": {
      "max_num_results": 50,
      "filters": { "published_at": { "$gte": 1786636800000 } }
    }
  }
}
```

`$gte` 的值仅示意参数结构，实际值按查询时点或指定区间计算。

授信问答使用独立的 AI Search `credit` 和 `CREDIT_SEARCH` binding，数据源是 R2 `eastmoney/credit/public/` 下的公开 PDF。检索和附件规则见[授信问答](../dashboard/docs/CREDIT_ASSISTANT.md)，不套用研究库的类型、日期范围或 MCP 入口。研究库的对象命名、元数据和索引边界见[研究归档协议](DATABASE.md#研究归档协议)。

## 官方参考

- [Custom Providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)
- [Authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
- [Request Headers](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/)
- [Universal Endpoint](https://developers.cloudflare.com/ai-gateway/usage/universal/)
