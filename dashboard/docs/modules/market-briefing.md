# 市场点评

入口：`/market-briefing`、`/market-briefing/text`。业务计算与原有报告 Schema 保持一致，生成由 Dashboard `market-briefing` Workflow 持有。

## 定时生成

- Messenger 按 UTC `0 9 * * MON-FRI` 经 Dashboard 私有 ScheduledTasks 启动市场点评，即北京时间工作日 17:00。各业务 Worker 不再配置 Cron，调度所有权见 [共享架构](../../../docs/ARCHITECTURE.md#用户通知中台)。
- `MARKET_BRIEFING` 绑定 `MarketBriefingWorkflow`，平台名称固定 `market-briefing`。实例 ID 为 `market-briefing-YYYY-MM-DD`，同日重复定时调用不重复创建。
- 定时入口在创建 Workflow 实例前按计划触发时间的上海日期检查周末，再经 DATA / InternalData 查询 `/data/trading-days`（Choice 上交所日历）。只有日期一致、`isTradingDay=true` 才创建。休市正常跳过，日历超时、HTTP/Schema/日期错误则记录 `market_briefing_calendar_unavailable` 并停止本轮，不视为休市。日历失败可能使当日定时生成漏跑，需要在服务恢复后人工补发。Workflow 内不增加休市 step。`collect-equity` 与 `collect-primary` 仍独立校验交易日与行情日期，行情滞后由 step 重试。
- Workflow 只保留一组七个并行模块 step，直接写在 `worker/market-briefing-runner.ts` 的原生 `await Promise.allSettled([...])` 中：今日聚焦 `collect-focus-news`、公开市场操作 `collect-open-market`、固收市场 `collect-fixed-income`、权益市场 `collect-equity`、一级发行 `collect-primary`、二级行情 `collect-secondary`、东财债券 `collect-inventory`。
- 每个模块自己完成抓取、DTO 校验、解析、业务换算和结果组装，返回已校验的报告字段。不依赖其他模块 step 的输出。一级发行独立读取交易日期。二级与东财各自补全所需债券信息，东财另自取今日成交作收益率回退。共享接口可由不同模块独立请求，不设跨模块缓存或前置步骤。
- 今日聚焦在原 `collect-focus-news` 内顺序读取最多四批 DM 新闻，每批通过 `/data/news?detail=true&pageSize=10&offset=…` 返回正文，总上限 40 条。四批固定同一 `endTime`，按 ID 检查重复；Data 内详情最多五个并发。模块内完成筛选和提示材料组装，股票收评由权益模块独立获取，不创建独立新闻 Workflow。
- 模块 step 最多重试 3 次，30 秒起指数退避。行情模块单步超时 3 分钟，今日聚焦采集超时 10 分钟。AI step 最多重试 2 次，1 分钟起指数退避、超时 15 分钟。采集 adapter 不做业务重试，任何批次失败则整个模块失败，由原 step 重试。
- 七个模块全部结束后，显式依次 `await generate-focus → archive-report`。AI 消费今日聚焦新闻及六个行情模块已完成的规范数据投影，关闭 adapter 内部重试。归档只合并已经解析完成的模块字段、校验完整报告并保存原 `market-briefing/YYYY-MM-DD.json`，不再解析上游数据。任一必需模块失败不影响其他模块完成，但不生成或归档残缺报告。
- 当日成交、期货及报价不支持历史重放。每个未完成的采集 step 校验上海当天，跨日恢复未完成采集会失败，不能以当前行情冒充历史报告。已完成数据步骤与归档步骤可由平台恢复。

- Workflow 只生成并归档报告，成功返回 reportDate、finalizedAt、focus。失败直接保留原错误。终态由 Cloudflare Event Subscriptions → Messenger 统一发送 email＋Telegram，接收人、幂等和渠道重试在 Messenger 管理。

## 读取与页面

- `GET /api/market-report?date=YYYY-MM-DD` 只读取并校验指定日期的 R2 定稿，512 KiB 上限不变。缺失返回 404 `REPORT_NOT_FINALIZED`，损坏返回 503。
- 不带 date 时，所有年度统一按周一至周五选日，不再依赖 Choice、DATA 或按年度维护的休市日历。上海时间 17:00 前选严格早于当天的最近工作日。17:00 起工作日选当天，周末仍选周五。法定节假日若落在周一至周五也按工作日处理。所选日期缺少定稿返回 404，不改读更早报告。
- 前端打开、换日期和刷新只 GET 定稿，绝不请求原始行情、不触发 AI、不回退现场生成。数据不存在显示整页错误和重试操作。文字版与视觉版消费同一已归档规范数据，今日聚焦支持有写权限用户直接编辑，无编辑或保存控件。文字版同步展示当前聚焦。AI 仅由用户点击统一星标生成按钮触发，失败保留原稿。
- 日期、视图切换、刷新、导出图片和复制保留。header 导出冻结当前日期、报告及聚焦，并发下载 3 倍像素 PNG 与 PUT 报告 JSON 到原 R2 定稿 key。只读用户仅下载。两个结果独立反馈，任何一项失败不取消另一项。导出、生成期间暂停日期和标签切换、刷新及编辑。控件具有可辨识的主次、选中、hover、active、键盘 focus 与 disabled 状态，继续使用既有报告尺寸与品牌令牌。
- `PUT /api/market-report` 与 `POST /api/market-briefing` 分别服务人工导出归档及主动重新生成，沿用原写权限。主动生成由统一 AI 客户端携带 `Accept: text/event-stream`，接收纯文本 `progress` summary 与完整 JSON `result`，进度只显示在全局 AI 面板。旧 `/api/market-resources/*` 继续仅为已有客户端的公开只读兼容通道。

## 业务规则

- 今日聚焦优先使用给定新闻，联网搜索必须少用、慎用，仅在缺少形成核心判断所必需的信息时补充。材料足够时直接写作，不要求联网核验给定材料。获得必要信息后停止搜索，缺乏支持的判断保留不确定性。Web Search 工具保持可用，稳定 `instructions` 使用直接研究指令，不含日期或 skill 包装。user input 包含新闻和同日行情证据卡。输出格式由严格 JSON Schema `{stock: string, bond: string}` 约束，Workflow 按股、债顺序拼接 `1、` 和 `2、`。
- 写作以约120字为目标，每条100—140字、上限160字。明确当日定性、选择一至两个主因，结尾直接给方向与主要约束。取消强制条件式展望、对称情景和机械“关注”尾句。不以更强语气代替事实核验。行业、期限和收益率方向服从报告截面，新公布消息不得倒推为此前行情原因。
- 行情证据由 `market-briefing-evidence.ts` 投影：指数/成交、行业前三后三、资金利率、国债期限、期货及当日OMO。保持空值与OMO到期金额符号，提供债券价格方向辅助校验。行业数据日期不符时同时排除对应指数、成交及行业数据。不投影人工 `focus_text`、公司债持仓、未带可信时点的旧 `stock_paragraphs`。
- 手动重新生成复用同日R2定稿的行情字段，定稿不存在时沿用新闻输入。损坏或存储错误仍失败，不默默降级。Workflow直接传递已完成模块数据，不重抓行情。两条路径均不将人工点评作为生成答案。
- JSON Schema仍为非空 `{stock,bond}`，不设置模型端字符串maxLength，避免结构化解码硬截断句子。模型完整返回后再检查160字上限及完整收句。失败不返回/归档坏稿，Workflow按现有step策略重试，手动生成保持页面原稿。
- 利率债列表中的个别收益率缺失按 `null` 接收，保留其他有效行情。规范报告继续保留空收益率，不转为零，也不将整批国债行情标记为资源失败。
- 原始列表的空容器、空行与缺少定位字段的记录不拖累其他记录。成交笔数、两融余额、发行规模、剩余期限和债券分类允许缺失。非空错型仍由单资源错误边界处理，不能将未知科创标志当作普通公募公司债。
- 两融保留最新日期，分别计算有完整两期值的指标。行业与指数保留各自部分值，图表只绘制具备所需数值的项目。交易日缺失时一级发行仍查询报告当日，上一交易日比较留空，不猜测节假日。
- 一级发行规模缺失仍保留明细，相关合计/环比留空，文字显示“规模暂缺”。发行金额合计不依赖期限解析，`3+2`、`5+2` 等含权期限或期限缺失不阻断已知规模的汇总。OMO 任一金额缺失时当日净额和含该日的累计留空，不把部分合计写成完整净投放。定稿 Schema 和文字反向编辑同时支持这些空值。
- OMO 文字输出按报告日过滤规范字段 `operation_date`。排序和数字格式由视觉版与文字版共享派生层统一维护。报告日没有正值投放记录时，文字版明确显示“今日未开展逆回购操作”。
- 一级发行只使用报告日和上一交易日数据。同日、同类型、同发行人的多期限合并、东财排除和缺失票息规范由共享加工层完成。视觉与文字版直接消费 `primary_issues`。
- 二级成交的债券基础信息批量补全、结构化公募公司债类型、五年期限和东财排除由共享加工层完成。普通公募公司债固定以 `bondType=37`、`bondOfferingType=1` 且 `sciTechInnoBondStatus=0` 判断，不根据简称字母猜测。视图派生层继续使用 Theil-Sen / MAD 残差过滤不可比成交。
- 东财存量债的 Bid/Ofr 只有严格大于零才视为有效报价。零值归一为空，不进入文字字段、图表散点或 tooltip，但债券本身及其估值、成交信息继续展示。
- 东财存量债成交收益率须大于零且偏离该券估值不超过 500bp，防止净价（如 100）混入收益率。收藏成交无效时仅回退有效的今日成交。均无效则成交及利差留空，债券、估值和报价保留。回退成交的利差按所用收益率与估值重算。

交易日历来源：[上交所2026年休市安排](https://www.sse.com.cn/disclosure/dealinstruc/closed/c/c_20251222_10802510.shtml)。

## 验证与恢复

`tests/market-report.test.mjs` 直接执行无 date 的 GET handler，覆盖 Choice 不可达/503/异常日历仍读取准确 R2 定稿、缺失不回退、17:00 切日及未来年度无需日历配置。`tests/report-date.test.mjs` 覆盖周末全天、节假日按工作日选日、跨年与闰日。浏览器固定报告夹具只验证展示与交互。不能证明真实 DATA/Choice/R2 可用。发布后须程序化请求生产 `/api/market-report` 及显式日期接口核对 HTTP 状态和 `report_date`。

Cloudflare 流程图由静态语法分析生成，并不回放实际执行。`completeAll(...).then(...)` 曾使解析器把依赖步骤全部标为 `starts=1`，因此 Workflow 编排使用原生 Promise 批次与直接 await。发布后通过 `GET /accounts/{account}/workflows/market-briefing/versions/{version}/graph` 核对唯一并行组恰有七个模块 step，及其后 AI、归档两个串行 step。测试通过不能替代平台图核验。见 [Cloudflare 流程图文档](https://developers.cloudflare.com/workflows/build/visualizer/)。

手动触发使用 `pnpm exec wrangler workflows trigger market-briefing '{"reportDate":"YYYY-MM-DD"}' --id market-briefing-YYYY-MM-DD`。运行失败时先检查失败步骤，同日可执行 `pnpm exec wrangler workflows instances restart market-briefing <id>`。通知投递失败在 Messenger 管理页重试，不重启业务 Workflow。跨日不能补跑实时行情。休市日期应在新年度交易所公告发布后更新 `src/lib/server/market-calendar.ts`。

Workflow 结果通知由 Messenger 订阅平台事件。渠道尝试和人工重试见 [消息投递](messenger.md)。

## 写作回放与质量验收

`node scripts/evaluate-market-briefing.mjs --request=<Gateway原始请求JSON> --date=YYYY-MM-DD --report=<同日归档JSON> --output-dir=<仓库外目录>` 通过统一AI adapter实际调用模型，使用进程 `CF_AIG_TOKEN`。`--report` 可省略以固定原始新闻，`--baseline` 使用历史instructions作对照。测试凭据不放参数或提交文件。历史材料只存本地评估目录。

脚本仅提取请求中的user文本。不调用搜索、Data、R2写入、Workflow或消息。归档仅投影行情，不读人工点评。脚本要求新闻包含报告日且没有未来日期，允许此前背景材料。

同目录同输入同prompt使用原子启动记录防止重复调用，已完成结果直接复用。新一轮评估使用新目录，不依据观察超时重发活请求。结果保留完整输出、输入及prompt哈希、Gateway log id、token计数、字数和形式检查。同文件旁保存无headers的实际材料和instructions，便于逐项复核。

回放必须先确认资料截止时间，历史归档补充行情的试验与固定新闻试验分开统计。

字数和无条件词只证明形式。内容评审须同时检查事实/时序、具体主因、传导、判断与精炼。此时不能把盘后复盘时间当作其中事件时间。此时不能忽略材料末尾的行情卡，也不能要求模型复刻人工稿的输入外信息。

出现硬事实错误的候选不作为完成验收。人工修改仍通过原导出归档路径。后续对比应同时保存所用log id与修改稿，日期相同并不证明修改起点相同。

## 调度入口

17:00 工作日定时触发由 Messenger 的唯一分钟 Cron 匹配原 UTC `0 9 * * MON-FRI`，经私有 `ScheduledTasks` 调用 `worker/scheduled-tasks.ts`。传入原计划时间后复用 `startMarketBriefing`，交易日检查和同日实例幂等保持不变。Dashboard 不再配置 Cron。

### 新闻子请求超限恢复（2026-10-23）

新闻采集从一次摘要加最多 40 次详情 Service Binding 调用，改为原 Workflow 最多四次 Data 批量调用。Data 每批最多 20 次列表扫描与 10 次正文请求，单批失败不返回部分正文。六个行情模块的调用预算仍须独立核查，不能把普通 step 或降低并发解释为重置请求额度。
