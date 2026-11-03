# 标准点评

入口：`/trading-research/tracking-commentary`。时事快评、政策跟踪和海外事件统一为 `commentary`，共用类型、仓储、标准正文、CRUD 和历史版本。政策页只保留关联入口。

## 数据

- 表为 `commentary`、`commentary_workspace`、`commentary_revision`、`commentary_pdf`，改名只由 Dashboard migration `1021_unify_commentary.sql` 在生产库执行。Ingest 的政策保护查询读 `commentary`，见 [共享数据库](../../../docs/DATABASE.md#共享-d1)。
- `commentary_workspace` 保存初始来源、手写原文、原文件名与 SHA256、选取的研报原句和检索范围，不保存完整研报正文。
- `origin` 表示材料来源，`edited` 表示当前是否人工修订。导入稿编辑后仍保留手写来源。重新生成后 `origin` 为 AI，手写原文和文件哈希保留。
- 数据库触发器在每次更新前归档旧版，所有写入共用同一仓储。版本 API 返回当前稿和最近 50 个历史版本。
- 生成和人工保存用 `updatedAt` 乐观锁，冲突返回 409，失败保留输入。

## 接口

- `/api/commentaries`：GET 列表，POST 建稿。
- `/api/commentaries/[id]`：GET 读取，PUT 修订。
- `/api/commentaries/[id]/generate`：POST 生成，统一 `progress/result/error` SSE，每 15 秒发注释帧保活。
- `/api/commentaries/[id]/revisions`：GET 历史版本。
- `/api/commentaries/[id]/pdf`：见下文 PDF 归档。

权限在 Gateway `route-permissions.ts` 登记。连接中断不保证后台继续生成，用户重新打开草稿读取实际保存结果。

## 撰写与取材

用户填主题、类型、事件/点评日期和研报日期范围，保存草稿后手动生成。默认范围为最近 7 个上海自然日，从政策进入时以政策日期初始化。页面加载和筛选不调用模型。

- 检索：经研究库 MCP `search` 分别检索主题与固收传导，每次 50 条，按研报类型和 `published_at` 过滤，同 key 合并，不截断返回的原文块。
- 关联政策的已有研报正文在所选日期内经 DATA 读取，最多 5 路并发。政策资讯作为事实材料。
- 无研报，或材料超过 250000 字符，明确失败并要求调整主题/日期，不编造也不裁切来源。
- 不使用模型 Web Search 生成摘录，因为无法逐字核验。

生成使用独立的 `commentary` 任务（`xhigh`）和版本化 Prompt，选材而不改写：

- 程序给完整原句编号，模型只选编号、拟标题和写建议，正文由程序从原文组装。句子不按逗号或分号拆分，保留条件、否定和小数。
- 摘要为 120 字内的原句，2—4 点正文均为原文摘录，标题表达判断，整篇点评（含标题）不超过 900 字。融资建议独立撰写，不超过 300 字，必须关联已摘录来源，不预设方向。
- 应用校验完整句界、逐字子串、来源 ID 和无行动套话。失败走同模型重试一次。
- 机构、标题和时间只取检索元数据，不接受模型填写。原文的条件和分歧不得删去。
- 每次生成读取截至点评日期的最近三期同类型人工稿，作为 `styleReferences` 只学习写法。原句校验只接受本次研报和政策。检索快照记录参考稿，页面显示“参考点评”。

交互式生成经统一 adapter 的 Responses 流。公开 reasoning summary 作纯文本 `progress`，完整点评作 JSON `result`，错误作纯文本 `error`，不发送推理正文或未校验 JSON。

- 单次请求 300 秒，保留统一的一次重试。截止和客户端取消贯穿读取，取消后不重试也不写入，失败不保存半成品。
- 失败码 `AI_RESPONSE_TIMEOUT`、`AI_OUTPUT_INVALID`、`AI_UPSTREAM_ERROR` 带尝试次数、HTTP 状态和 Gateway 追踪 ID，不回显上游正文、Prompt 或 secret。
- 日志只记稿件 ID、尝试序号、材料数、状态、Gateway log ID 和 token 计数。

## 编辑与导出

- 已存在的点评，人工输入以 800ms 防抖串行同步 D1。保存期间继续编辑不被迟到响应覆盖。失败保留输入并停止对同一份内容自动重试。未保存的新主题在生成或保存时建稿。
- “打印”调用浏览器原生打印，报告为 A4 portrait、12mm 页边距，只含标题、元数据和正文。
- “保存 PDF”先同步 D1，再在前端按 A4 页宽捕获同一报告（3 倍像素密度）并分页，分页避开文字行。前端把 PDF 上传 R2，再下载已归档的同一份字节。同版本已有 PDF 直接下载原件。

## PDF 归档

- R2 `eastmoney` 桶 key 为 `research-commentary/<类型>/<点评ID>/<版本>.pdf`，类型为 `时事快评/`、`政策跟踪/`、`海外事件/`。修订产生新版本，不覆盖旧 PDF。
- `commentary_pdf` 保存点评版本、R2 key、文件名、SHA256、大小和归档时间。
- `POST /pdf?updatedAt=...` 接收不超过 16MB 的 `application/pdf`，仍以数据库点评版本解析唯一 key。JSON 请求用于从标准正文生成 PDF。重复归档同版本幂等，版本冲突 409。`GET` 经授权 API 按 D1 key 读取。
- 历史 PDF 按原字节上传，不重排。批量迁移：`node scripts/archive-tracking-commentary-pdfs.mjs --manifest=... --source=... --output=...` 默认预览，`--apply` 上传 R2 并写 D1 索引，逐份核验 SHA256，同 key 内容不同直接失败。

## 历史稿导入

`python3 scripts/import-tracking-commentaries.py --input '<材料目录>' --output '<仓库外目录>'` 默认预览，核对后加 `--apply --remote`，须先应用 `1021`。

- 按内容 SHA256 幂等插入，不覆盖旧点评或人工修改。Word 优先、PDF 兜底，同目录同 stem 的 DOCX/PDF/MD 归为一篇。
- 日期取文内日期，不用 mtime，缺失保留空值。原文标题、段落和对比表完整保存，表格以安全文本单元格展示。
- 原文件、导入 SQL 和 manifest 不进 Git。

## MCP

`commentaries`、`commentary`、`commentary_revisions`、`create_commentary`、`update_commentary` 共用标准点评 Schema 和 `/api/commentaries`，修订须带 `updatedAt`。返回标准正文和版本信息，剔除导入原文、文件名、PDF key、检索参数和内部证据定位。AI 生成不进 MCP，见 [MCP](../MCP.md)。
