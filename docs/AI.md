# Cloudflare AI Gateway 规范

本文件是 Gateway、Data、Dashboard、Ingest 的共享传输与检索规范。业务 Prompt、Zod Schema、任务类型映射和例外在各调用项目维护。只在 AI 任务中读取，不要求页面或数据库任务先加载。

| 调用项目 | 适配器事实来源 | 业务入口 |
|---|---|---|
| Gateway | [ai.ts](../gateway/src/ai.ts) | [通用 Responses API](../gateway/docs/AI.md) |
| Dashboard | [ai-gateway.ts](../dashboard/src/lib/server/ai-gateway.ts) | [按页面选读](../dashboard/AGENTS.md#context-routing) |
| Ingest | [ai-gateway.ts](../ingest/src/ai-gateway.ts) | [按采集模块选读](../ingest/AGENTS.md#context-routing) |
| Data | [ai-gateway.ts](../data/src/ai-gateway.ts) | [CAMEL 验证码](../data/docs/modules/camel.md) |

## 统一传输契约

生产生成式 AI 必须经过 Cloudflare AI Gateway，不得绕过 Gateway 直连上游 Provider。

自定义 Provider 的 Responses API 必须使用 provider-specific Gateway URL：

```text
https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/{provider}/responses
```

不得用 `env.AI.gateway(gatewayId).run({ provider, endpoint: "responses" })` 调用自定义 Provider。该调用会进入 Universal 请求适配层，而不是直接转发 Provider 原生 Responses 请求。上游返回无法被 Universal 适配器识别时，Gateway 会产生 `AiGatewayError`、HTTP 502、内部错误码 2006。

业务代码也不得自行访问自定义 Provider 的 `base_url`。Provider 基础地址、BYOK 和默认密钥别名都由 AI Gateway 管理。应用只拼固定的 Gateway provider-specific URL。

Gateway 鉴权统一使用 Worker Secret `CF_AIG_TOKEN`：

```http
Content-Type: application/json
cf-aig-authorization: Bearer ${CF_AIG_TOKEN}
cf-aig-skip-cache: true
cf-aig-collect-log: true
cf-aig-request-timeout: 120000
cf-aig-metadata: {...}
```

调用还必须满足：

- `metadata` 标记业务、提示词版本、模型、Provider 和尝试次序。
- 模型较慢时可将 `cf-aig-request-timeout` 调大，最长 300000 ms（5 分钟）。
- 每个 Promise 必须 `await`。响应正文必须限长读取并做运行时校验。
- 不记录 Secret、完整输入、完整输出或完整上游错误体。保留 HTTP 状态和 `cf-aig-log-id`。

Dashboard 的业务任务前端统一使用 SSE：浏览器从 `src/lib/ai-client.svelte.ts` 发起请求并携带 `Accept: text/event-stream`，Worker 流式请求上游。客户端只接收 `progress`（`data` 为移除 Markdown 加粗标记后的公开 reasoning summary 纯文本）、`result`（`data` 为完整终态 JSON）和 `error`（`data` 为可公开错误纯文本）。保活使用注释帧。不得在 `data` 内重复嵌套 `type` 或 `id`，也不得新增 NDJSON、`complete`、`session`、`draft` 等并行任务流协议。全站通用 AI 侧栏例外：浏览器端 `ToolLoopAgent` 经已鉴权的同源 `POST /api/ai/responses` 读取原生 Responses SSE 并在浏览器执行工具循环。此通用接口由本站 Gateway Worker 直接处理并持有 `CF_AIG_TOKEN`，固定 Provider/模型并限制请求体，支持原生 JSON/SSE；浏览器不得接触 Gateway Secret。此通用接口允许任意来源 CORS 与带凭据请求，OPTIONS 预检公开，实际 POST 必须携带本站用户 Bearer 并使用 application/json；其他写接口的同源规则不变。参数、无状态限制、错误脱敏和取消规则见 [Gateway AI](../gateway/docs/AI.md)。

## 默认路径：Provider 原生 Responses API

所有生产生成式调用固定使用 Codex，不切换 Provider：

| 顺序 | Provider | 模型 | Gateway endpoint |
| --- | --- | --- | --- |
| Primary / Retry | `custom-codex` | `gpt-6-luna` | `custom-codex/responses` |

基础调用形态：

```ts
const response = await fetch(
  `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${provider}/responses`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-aig-authorization": `Bearer ${cfAigToken}`,
      "cf-aig-skip-cache": "true",
      "cf-aig-collect-log": "true",
      "cf-aig-request-timeout": "120000",
      "cf-aig-metadata": JSON.stringify(metadata),
    },
    body: JSON.stringify({
      model: "gpt-6-luna",
      prompt_cache_key: promptCacheKey,
      instructions,
      reasoning: {
        effort: reasoningEffort,
        summary: "auto",
        context: "current_turn",
      },
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          strict: true,
          schema,
        },
      },
      input,
    }),
    signal,
  },
);
```

本站 Gateway 的通用 Responses 转发不自动重试，由调用方按业务幂等性决定重试。以下重试规则仅用于 Dashboard/Ingest/Data 的业务适配器。通用接口兼容侧栏的 medium effort，并移除 SDK 自动附带的 `store:false` 与加密 reasoning include。

应用层重试规则：

1. 所有任务直接调用 `custom-codex`，不得调用其他 Provider。
2. 首次出现以下错误时，用同一模型、Prompt 和 Schema 重试 `custom-codex` 一次：网络错误、超时、`408`、`429`、`5xx`、Responses `failed` / `incomplete`，或输出未通过业务 Schema 校验。
3. 其他 `4xx` 视为请求、权限或配置错误，不重试。
4. 一次 adapter 调用最多两次尝试。均失败后再由外层 Workflow 执行其既有步骤重试。授信问答 `credit_answer` 保持既有单次尝试策略。
5. 两次尝试使用 `primary` / `retry` metadata，并保留各自状态和 Gateway log ID。
6. Codex 返回带 `phase` 的 message 时只提取 `final_answer`，不将 `commentary` 拼入 JSON。继续兼容无 phase 的结构化输出。

Responses API 参数规范：

- 默认模型为 `gpt-6-luna`。
- 生产 Responses 请求不显式传递 `store`。统一设置 `reasoning.context="current_turn"`，只保留当前轮次的 reasoning 上下文。统一保留 `reasoning.summary="auto"`，从 reasoning output item 的 `summary` 数组观察 Provider 返回的可读推理摘要。
- 不设置 `include: ["reasoning.encrypted_content"]`，不主动请求加密 reasoning 内容。原始 reasoning tokens 仍不可见。
- 使用 `instructions`、`input`、`reasoning.effort`、`reasoning.summary` 和 `reasoning.context`，不得沿用 Chat Completions 的 `messages` 或顶层 `reasoning_effort`。
- reasoning effort 由各项目的业务任务类型统一映射，不允许调用方填任意值。Dashboard 当前前端 AI 及其兼容生成入口统一使用下表。Ingest、Data 的后台任务仍以各自适配器映射为准：

  | 任务类型 | Effort | 当前任务 |
  | --- | --- | --- |
  | `generation` | `xhigh` | 市场热点聚合 |
  | `market_briefing` | `xhigh` | 今日市场聚焦（启用 Web Search） |
  | `analysis` | `xhigh` | 融资择时卖方观点研判 |
  | `policy_commentary` | `xhigh` | 政策跟踪点评初版 |
  | `tracking_commentary` | `xhigh` | 跟踪点评原句选材与资金部建议 |
  | `summary` | `xhigh` | 单篇 article 特征摘要与抽取 |
  | `credit_answer` | `xhigh` | Dashboard 授信问答，单次尝试 |

- Prompt 按缓存友好的稳定前缀组织：长期不变的角色、业务规则、输出约束放入 `instructions`。日期、正文、新闻、模型快照和证据卡片只放在最后的 `input`。不得把单次请求的动态内容插入 `instructions`。
- 每类任务使用包含 Prompt 版本的稳定 `prompt_cache_key`。相同 Prompt 版本复用同一 key，不得把日期、文章 ID、run ID 或随机值写入 key。Cloudflare 响应缓存继续通过 `cf-aig-skip-cache=true` 关闭。`prompt_cache_key` 只用于上游模型的 Prompt Cache。
- 不设置 `max_output_tokens`。不得截断输入或有效输出。
- 结构化响应使用 `text.format.type=json_schema`、`strict=true`，并在应用端再次使用同一个 Zod 或等价 Schema 校验。
- 从 `output` 中提取 `output_text`。不得按 `choices[0].message.content` 解析。
- 成功日志仅记录以下元数据：任务类型、effort、请求的 reasoning summary/context 模式、返回摘要条数与字符数、Prompt Cache token 计数。还可记录是否仍有 `encrypted_content`、`output_text` 长度和 Gateway log ID。不得记录实际 Prompt、推理摘要或业务输出正文。

## 记录路径：动态路由 Chat Completions API

`dynamic/rag` 仅作为已有动态路由配置和历史兼容方案记录，不属于当前生产调用或 Responses fallback。未经明确变更，不得在业务 adapter 中自动切换到动态路由。

如未来重新启用，动态路由只能通过 Chat Completions API 调用，不得把 endpoint 改成 `responses`，不得使用 `/compat/responses`：

```text
POST https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/chat/completions
model: dynamic/rag
```

当前记录的 `dynamic/rag` 路由顺序：

| 顺序 | Provider / 模型 | 路由超时 | 路由重试 |
| --- | --- | ---: | ---: |
| Primary | `custom-opencode/mimo-v2.5` | 300000 ms（5 分钟） | 0 |
| Fallback | `workers-ai/@cf/google/gemma-4-26b-a4b-it` | 0（未单独限制） | 0 |

动态路由使用 Chat Completions 参数和响应结构：输入为 `messages`，结构化响应为 `response_format.json_schema`，输出从 `choices[0].message.content` 读取。

## AI Search

- 项目统一 MCP 使用 Cloudflare 托管的 `https://mcp.hasbai.xyz/mcp`，研究检索工具为 `research_search`。研究库上游为 `https://research.hasbai.xyz/mcp`，由门户连接其 `search` 工具。旧 search.hasbai.xyz 已失效。门户登录和配置见 [Gateway MCP](../gateway/docs/MCP.md)。
- 研报与政策检索数据源为 AI Search `research`，索引 R2 `article/report/` 与 `article/policy/`。`type` 是文本，值分别为 `研报`、`政策`。卖方观点等研报专用检索必须增加 `type: { "$eq": "研报" }`，政策专用检索使用 `政策`，综合检索可同时覆盖两类。
- 每次检索必须显式设置 `ai_search_options.retrieval.max_num_results=50`，不得使用默认返回数量。
- 每次检索必须对 `published_at` 施加硬过滤，不得仅依赖 recency boosting。默认检索最近 7 个上海时区自然日。用户明确指定日期或历史区间时，按指定区间设置 `$gte`、`$lte`。
- `published_at` 过滤边界先按 `Asia/Shanghai` 计算，再转换为 Unix 毫秒时间戳传入 MCP。

```json
{
  "query": "用户查询",
  "ai_search_options": {
    "retrieval": {
      "max_num_results": 50,
      "filters": {
        "published_at": {
          "$gte": 1786636800000
        }
      }
    }
  }
}
```

上例的 `$gte` 仅用于展示参数结构。实际调用必须根据查询时点或用户指定区间动态计算。

授信问答使用独立 AI Search `credit` 与 `CREDIT_SEARCH` binding。数据源仅为 R2 `eastmoney/credit/public/` 下直接存放的公开 PDF。检索和附件规则见 [授信问答](../dashboard/docs/CREDIT_ASSISTANT.md)，不套用研究库的类型、日期范围或 MCP 入口。研究库的 R2 对象命名、元数据和索引完成边界见 [共享数据库](DATABASE.md#研究归档协议)。

## 官方参考

- [Cloudflare AI Gateway Custom Providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)
- [Cloudflare AI Gateway Authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
- [Cloudflare AI Gateway Request Headers](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/)
- [Cloudflare AI Gateway Dynamic Routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/)
- [Cloudflare AI Gateway Universal Endpoint](https://developers.cloudflare.com/ai-gateway/usage/universal/)
