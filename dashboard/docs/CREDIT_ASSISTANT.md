# 授信公开材料与 AI 侧栏

原授信助手页面由全站 AI 侧栏取代。`/credit-workbench/assistant`、`/credit-assistant`、`/trading-research/credit-assistant` 重定向到门户并打开侧栏。

侧栏的浏览器 ToolLoopAgent 调用 `/api/ai/responses` 和 `/api/mcp`，可选只读工具为 `credit_public_materials`、`credit_public_search`。问答不向客户发送消息。

## 公开资料边界

- 目录只枚举 R2 `eastmoney/credit/public/` 下的单层 PDF，原件链接用 URL 编码后的文件名。
- 搜索调用 Cloudflare AI Search `credit` 的 `search()`：每次取 50 个线上片段，只保留仍在该目录中的文件片段，工具结果最多 12 个。旧 `credit/catalog/`、`credit/originals/`、`credit/search/` 不进入检索结果。
- ROE / 净资产收益率问题先从公开审计报告文件名确定年度，再逐年检索“加权平均净资产收益率 + 年份”。同年审计报告中带指标和值的表格片段才算该年证据。返回已找到和缺少的年度，不内置指标数值。
- 片段没有可核验页码时只标记“AI Search 检索片段”，不虚构页码。
- 回答具体金额须对照可辨认的页面或可靠文本来源，并核对主体、报告期、母公司或合并口径和单位。证据不足时说明缺口。

## AI Search 索引

- 数据源只索引 `credit/public/**`。中文关键词用 trigram 和 `or` 匹配，检索开启重排并取消默认阈值。
- 实例启用、远端 OCR 关闭：部分 PDF 的文字层曾把中文表项解析为乱码，线上 OCR 有超时记录。扫描件在本地生成可搜索 PDF（单文件小于 4 MB），流程见 [OCR 说明](../scripts/credit-pdf-ocr/README.md)。
- 原始扫描件保留，R2 公开目录存放检索副本。密集财务报表的 OCR 数字仍可能有误。
- 替换 R2 对象后触发 AI Search 同步，核对 Item 文件大小、分块中的中文指标与数值，再用不含目标数值的问题实测检索。`completed` 状态不代表文本可用。

## 浏览器 Agent

- 对话、工具循环和本地历史在浏览器运行，历史按登录用户隔离。模型调用走共享 AI Gateway 入口，浏览器带当前用户的同源 Bearer token，模型凭据只在 Worker。
- Ask 模式只开放只读工具。Act 模式的写操作先确认。

## 历史会话（CreditAgent）

原 CreditAgent HTTP/DO 会话保留历史读取、问答和附件下载，无独立页面入口。每个问题直接调用 AI Search 一次，把检索片段和最近六轮对话交给一次 `credit_answer` 生成答复，不做多轮搜索规划或独立复核。会话按已验证的 `user.auth0Id` 隔离，SSE 可恢复运行中或终态结果。

附件下载只访问 `credit/public/` 下的单层 PDF，支持 Range，响应用 `private, no-store`。新链接用文件名，旧会话保存的 24 位文件 ID 经公开目录映射到同一 PDF。

| 接口 | 用途 |
| --- | --- |
| `POST /api/ai/responses` | Responses 流式模型入口（Gateway 处理） |
| `POST /api/mcp` | 业务工具与公开授信资料工具 |
| `GET /api/credit-assistant/session` | 历史当前会话 |
| `GET /api/credit-assistant/session/events` | 历史问答 SSE |
| `POST /api/credit-assistant/session` | 提交 `{ "question": "..." }` |
| `POST /api/credit-assistant/session/new` | 提交 `{}` 开始新会话 |
| `GET/HEAD /api/credit-assistant/files/:filename-or-legacy-id` | 公开 PDF 下载和 Range |

## 验证

运行 `pnpm check:quick` 和相关 Node 与浏览器测试，上线后用程序化 HTTP 核对鉴权、模型响应、公开来源和 PDF 下载。历史会话答复可用 `scripts/evaluate-credit-assistant.mjs` 抽样核对，它不能代替浏览器 Agent 的验收。
