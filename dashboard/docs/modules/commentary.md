# 标准点评

入口 `/trading-research/tracking-commentary`。时事快评、政策跟踪与海外事件统一为 `commentary`，共用类型、仓储、标准正文、CRUD 和历史版本。政策页面只保留关联入口。原 `/api/tracking-commentaries` 与 `/api/policies/[id]/commentary` 已移除，无别名。

## 数据与历史导入

Dashboard migration `1021_unify_commentary.sql` 直接将主表及伴随表统一为 `commentary`、`commentary_workspace`、`commentary_revision`、`commentary_pdf`，保留所有列、ID、`policy_id`、时间戳、正文与历史版本。Ingest 政策保护查询同步读取 `commentary`。生产改名只由 Dashboard migration 执行，Ingest 保留 canonical 表的本地初始化镜像；切换时先完成三仓验证，再紧邻发布和迁移。workspace 保存初始来源、手写原文、原文件名/SHA256、选取的研报原句与检索范围，不保存完整研报正文。同步脚本原本只同步 article/keyword/hotspot，本模块不隐式添加线上点评下载。

`origin` 表示材料来源，`edited` 表示当前是否人工修订：导入稿编辑后仍保留手写来源。重新生成后 origin 为 AI，但手写 originalText 和文件哈希保留。数据库触发器在每次更新前归档旧版，所有写入共用同一仓储。版本 API 同时返回当前稿和最近50个历史版本。生成与人工保存使用 updatedAt 乐观锁，冲突返回409，失败保留输入。

导入预览：

```sh
python3 scripts/import-tracking-commentaries.py --input '<材料目录>' --output '/tmp/tracking-commentary-import'
```

核对后使用相同命令加 `--apply --remote`。先应用 `1021`。只做按内容SHA256的幂等插入，不覆盖旧点评或人工修改。Word优先、PDF兜底，同目录同 stem 的DOCX/PDF/MD归为一篇。

不同版本内容保留为不同记录。按文内日期，不使用mtime。确实缺失日期/建议保留空值。原文标题、段落、对比表完整保存，表格以安全文本单元格展示。

原文件、导入SQL、manifest不进入Git。

## 撰写与取材

用户填主题、类型、事件/点评日期、研报日期范围，保存草稿后手动生成。默认最近7个上海自然日。从政策进入时以政策日期初始化范围，可修改。页面加载/筛选不调用模型。

通过研究库 MCP `search` 分别检索主题与固收传导，每次50条、研报类型与published_at硬过滤。合并同key，不截断返回的原文块。关联政策的已有研报正文在所选日期内通过 DATA 最多5路并发读取。政策资讯作为事实材料。无研报或材料超过250000字符明确失败，要求调整主题/日期，不编造或裁切来源。新管线不使用模型 Web Search 生成不可逐字核验的摘录。

AI Gateway 使用独立 `commentary/xhigh` 任务和版本化 Prompt，选材而不改写正文。摘要与2—4点正文均为原文摘录，标题表达判断。融资建议独立撰写，必须关联已摘录来源。应用校验完整句界、逐字子串、来源ID及无行动套话。失败进入既有同模型重试一次。通过后由程序组装正文。

保存源key、机构、日期、原句位置和检索文档哈希。机构/标题/时间只来自检索元数据，不接受模型填写。原文的条件和分歧不得删去，明确观点不等于虚构确定性。

接口 `/api/commentaries` GET/POST（列表/建稿）、`/[id]` GET/PUT（读取/修订）、`/[id]/generate` POST（统一 `progress/result/error` SSE，15秒注释帧保活）、`/[id]/revisions` GET。创建/修订使用既有 `research.policy_commentary:update`，生成使用 `research.policy:generate`，读取使用 `research.policy:read`。由 Gateway 登记并同步展示契约。连接中断不保证后台继续生成，用户重新打开草稿读取实际保存结果。

交互式生成通过统一 adapter 的 Responses 流接收模型事件。Worker 仅将公开 reasoning summary 作为纯文本 `progress`，完成后将完整点评作为 JSON `result`，错误为纯文本 `error`，不发送推理正文或未校验 JSON。单次AI请求300秒，保留统一的一次重试。日志只记录稿件ID、尝试序号、材料数、状态、Gateway log ID和token计数。Responses终止帧立即结束读取，不等上游EOF。截止和客户端取消贯穿读取，取消后不重试/写入，失败不保存半成品。

## 手写稿与旧 AI 稿诊断

38篇历史稿的共同优势：判断先行、边际变化清楚、传导后落到具体融资安排。会议类需要对比表，不应强制全部变成三段。4篇没有单列建议，不能导入时补写。原D1仅有1条 `policy-commentary-v3` 且 edited=1，未保留修改前AI稿，不能声称完成同题原始AI与手写稿的严格对照。用户随后提供了完整旧提示词与9月17日AI原稿，已据此补充下面的同题分析。

旧Prompt要求“吸收卖方框架后独立形成结论”，并示范“中性偏防御”“若…可…”。容易产生再概括和泛化建议。新Prompt把任务改为“选择已有判断原句”，程序直接组装，只有标题与资金部操作建议允许原创。历史数据、仓位上限和具体数值不写入风格示例，避免模型把旧判断移植到新事件。原始AI版本与人工修订分开留档，以便后续真实对照。

## 9月17日补充样本与 Prompt v2

用户提供的 AI 稿与9月15日手写稿讨论同一组经济/金融数据。AI稿大段列举工业、消费、投资、地产、信贷、社融、货币增速。大量数字没有改变标题已经表达的判断。手写稿用“生产强、需求弱，直接融资强、信贷弱”抓住结构，随后落到“适度后置融资安排，避开季末资金波动窗口”。两者融资方向不同，应核验各自依据，不能只靠语气评价。

旧提示词“关键语句可直接用”是可选而非原文约束，模型会继续重述。示例含“继续前置”“中性偏防御”“若…可…”，容易形成无条件的固定推荐。v2要求从研报选择结构变化、定价差、边际判断，正文各点不重复原句，摘要120字、点评含标题900字、建议300字。禁止把资金需求弱直接推导为立即前置，先比较等待利率下行与季末成本再给动作。取材和建议不预设方向，保留原句实际条件，不能为了强硬语气删掉证据限制。

## PDF 归档

R2 `eastmoney` 桶前缀为 `research-commentary/`，按中文类型分类：`时事快评/`、`政策跟踪/`、`海外事件/`。再按点评ID/版本保存PDF。无前导 `/`。D1 migration `1018` 的 `commentary_pdf` 保存点评版本、R2 key、文件名、SHA256、大小、归档时间。修订内容产生新版本，不覆盖旧PDF。

38份历史PDF按原字节上传，分类按结构化点评类型。已有无PDF的D1点评由结构化字段生成A4 PDF。页面“归档 PDF”先保存当前修改再从数据库渲染、存R2。“下载 PDF”通过已授权API按D1 key读取，不开放存储桶或接受任意路径。新稿PDF使用标准中文CID字体和Unicode映射，长稿自动分页，不截断正文。历史原件不重新排版。

`POST /api/commentaries/[id]/pdf` 使用 `research.policy_commentary:update`，`GET` 使用 `research.policy:read`。重复归档同版本幂等返回，版本冲突409。初次迁移脚本 `scripts/archive-tracking-commentary-pdfs.mjs --manifest=... --source=... --output=/tmp/...` 默认预览。`--apply` 执行R2上传及D1索引，逐份下载核验SHA256后落库。发现同key内容不同直接失败，不覆盖。

## 人工编辑、A4打印与前端PDF（v3）

AI生成后，已存在点评的人工输入使用800ms防抖串行同步D1。保存期间继续编辑不会被迟到响应覆盖。失败保留输入并停止对同一份失败内容自动重试，用户可修改后重试或“保存草稿”。未保存的新主题在生成或保存时建稿。

“打印”直接调用浏览器原生打印，专用报告使用A4 portrait、12mm页边距，只打印标题、元数据及正文。App壳、工具栏、证据区不打印。关闭打印后恢复原工作台。原生打印对话框不会向网页返回PDF字节。

“保存 PDF”先完成D1同步，再在前端捕获同一报告（系统字体、3倍像素密度），按A4页宽分页。分页位置避开文字行。前端将PDF二进制上传R2，随后下载已归档的同一份字节。同版本已有PDF直接下载原件。

`POST /[id]/pdf?updatedAt=...`接受限16MB的application/pdf，仍以数据库点评版本解析唯一key。JSON 请求用于从标准正文生成 PDF。历史原件不改写。

每次生成动态读取最近三期同类型人工稿（截至点评日期，排除当前稿与未来稿），作为独立styleReferences传入Prompt。sourceId原文校验仍只接受本次研报/政策，不接受参考稿。检索快照保存参考稿ID/标题/日期，页面显示“参考点评”。

## 生成超时排查与 v4 选材

2026-09-18生产追踪确认两次上游HTTP 200后只收到推理摘要，分别在305秒本地截止，实际错误为 `The operation was aborted due to timeout`。未收到正文或终止帧，不能归因为鉴权或Schema错误。极简max请求14秒成功，同一批20篇研报与3篇参考稿的high对照85秒完成，但旧逐字抄写输出触发句界校验。

v4选材任务现统一映射 `xhigh`，保留300秒预算及统一重试。完整上下文仍传入模型。程序为完整原句标记编号，模型只选编号、拟标题和建议，程序从原文组装正文。句子不按逗号/分号拆分，保留条件、否定与小数。

摘要编号仅允许120字内原句。句界识别兼容中文引号和列表。参考稿不进入可选原句集合。

AI失败返回 `AI_RESPONSE_TIMEOUT`、`AI_OUTPUT_INVALID` 或 `AI_UPSTREAM_ERROR`，并带尝试次数、HTTP状态和Gateway追踪ID。不回显上游正文、Prompt或secret。超时不会再被隐藏为通用“操作失败”。

## MCP 发布

`commentaries`、`commentary`、`commentary_revisions`、`create_commentary`、`update_commentary` 使用同一组标准点评 Schema 和 `/api/commentaries`。人工修改必须携带 `updatedAt`。MCP 返回标准正文与版本信息，剔除原始导入文本、文件名、PDF R2 key、工作区检索参数与内部证据定位。历史版本同样投影。AI 生成保留为网站显式操作，不进入 MCP catalog。
