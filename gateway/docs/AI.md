# 通用 Responses API

`POST https://eastmoney.hasbai.xyz/api/ai/responses` 由 Gateway 直接处理。OpenAI 兼容客户端的 base URL 为 `https://eastmoney.hasbai.xyz/api/ai`。

必须携带 `Authorization: Bearer <本站用户 Access JWT>`。校验沿用本站 Auth0 issuer、audience、客户端、组织、用户和角色，不要求额外业务权限。匿名、过期 token、ID token、机器 token 和 Cookie 身份均拒绝。

允许任意来源 CORS，包括 `Origin: null`。预检 OPTIONS 无需 token，返回 204。响应回显 Origin 并允许 credentials，以兼容 `credentials:"include"`，Cookie 不用于认证。程序调用可省略 Origin。其他写接口仍要求同源。

请求必须使用 `Content-Type: application/json`。`text/plain`（含 `text/plain;charset=UTF-8`）返回 415，避免跨域简单请求绕过预检。

```sh
curl https://eastmoney.hasbai.xyz/api/ai/responses \
  -H "Authorization: Bearer $SITE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-6-luna","input":"你好","stream":false}'
```

## 参数与响应

| 字段 | 契约 |
| --- | --- |
| `input` | 必填；字符串或 Responses 输入数组。完整消息、函数调用及函数结果由调用方传入 |
| `model` | 可省略，固定 `gpt-6-luna`，Provider 为 `custom-codex` |
| `stream` | 默认 JSON；`true` 返回原生 Responses SSE |
| `instructions` / `text` | 原生指令与输出格式，支持 `json_schema` |
| `tools` | `function`、`web_search`。函数由调用方执行，Gateway 不执行工具 |
| `tool_choice` / `parallel_tool_calls` | 原生工具选择与并行控制 |
| `reasoning` | effort 默认 `xhigh`，允许 `none/minimal/low/medium/high/xhigh`，具体模型支持情况以上游为准。固定 summary=`auto`、context=`current_turn` |
| 其他 | 支持 `metadata`、`prompt_cache_key`、`service_tier`、`include`、`truncation:"disabled"` |

SDK 自带的 `store:false`、`background:false`、空 `previous_response_id` / `conversation` 被接受但不发往上游。SDK 自动添加的 `reasoning.encrypted_content` include 会被移除。

远端会话、托管 Prompt、`item_reference`、Provider `file_id`、其他托管工具、`max_output_tokens` 和未登记顶层字段被拒绝，因为它们会引用共享 Provider 账户中的对象。

请求 JSON 最多 1 MiB，JSON 响应及单个 SSE 事件最多 16 MiB，超限即失败，不截断。完整模型调用限时 5 分钟，调用方取消会中止上游。

JSON/SSE 保留 Responses 成功结构和工具循环事件。HTTP 200 中仍可能有 `response.failed` / `error`，调用方必须检查终态。

本站 token 不转发上游。上游 HTTP 401/403 和重定向映射为 502，其余 HTTP 错误保留状态。错误正文及 JSON/SSE 的错误字段只含稳定的公开信息，可用时附 `cf-aig-log-id`。响应为 private/no-store/no-transform，不含上游 Cookie、Location 或身份头。

通用转发不自动重试，由调用方按业务幂等性决定。

## 配置与验证

Wrangler vars 为 `CLOUDFLARE_ACCOUNT_ID`、`AI_GATEWAY_ID`，Worker Secret 为 `CF_AIG_TOKEN`。Provider 密钥和 base URL 由 AI Gateway 的 BYOK 管理。`enable_request_signal` 使客户端断连时取消上游。应用日志不记录凭据和完整输入输出。

发布后执行 `pnpm auth:verify -- --ai`（参数见 [DEVELOPMENT](DEVELOPMENT.md#配置与本地验证)）。它复用一次真实登录，检查跨域预检、匿名与无效 token 拒绝、`text/plain` 的 415、跨域结构化 JSON 和两轮原生 SSE 函数调用。该选项执行三次小型模型生成，不写业务数据。
