# 市场点评

入口：`/market-briefing`、`/market-briefing/text`。业务计算和报告 Schema 不变，生成由 Dashboard 的 `market-briefing` Workflow 持有。今日聚焦的生成、编辑和写作规则见 [今日聚焦](market-focus.md)。

## 定时生成

- Messenger 按 UTC `0 9 * * MON-FRI`（北京时间工作日 17:00）经 Dashboard 私有 `ScheduledTasks` 启动，Dashboard 不配置 Cron。调度所有权见 [共享架构](../../../docs/ARCHITECTURE.md#用户通知中台)。
- `MARKET_BRIEFING` 绑定 `MarketBriefingWorkflow`，平台名 `market-briefing`，实例 ID 为 `market-briefing-YYYY-MM-DD`，同日重复调用不重复创建。
- 创建实例前，按计划触发时间的上海日期检查周末，再经 DATA / InternalData 查 `/data/trading-days`（Choice 上交所日历）。只有日期一致且 `isTradingDay=true` 才创建。休市正常跳过。日历超时或 HTTP / Schema / 日期错误记录 `market_briefing_calendar_unavailable` 并停止本轮，不视为休市，服务恢复后须人工补发。
- 七个并行模块 step 写在 `worker/market-briefing-runner.ts` 的原生 `Promise.allSettled([...])` 中：今日聚焦 `collect-focus-news`、公开市场操作 `collect-open-market`、固收市场 `collect-fixed-income`、权益市场 `collect-equity`、一级发行 `collect-primary`、二级行情 `collect-secondary`、东财债券 `collect-inventory`。
- 每个模块独立完成抓取、DTO 校验、解析、业务换算和结果组装，返回已校验的报告字段。模块之间不依赖输出，也不设跨模块缓存。
- `collect-equity` 与 `collect-primary` 独立校验交易日与行情日期，行情滞后由 step 重试。一级发行独立读交易日期。二级与东财各自补全所需债券信息，东财另取今日成交作收益率回退。
- `collect-focus-news` 顺序读取最多四批 DM 新闻（总上限 40 条），每批 `/data/news?detail=true&pageSize=10&offset=…`。四批固定同一 `endTime`，按 ID 检查重复，Data 内详情最多五个并发。
- 新闻采集最多四次 Data 批量调用。六个行情模块的调用预算须独立核查，不能靠调大 step 并发或重试来绕开请求额度。
- 七个模块结束后依次 `await generate-focus → archive-report`。归档只合并已解析的模块字段，校验完整报告并保存到 `market-briefing/YYYY-MM-DD.json`，不再解析上游数据。任一必需模块失败不影响其他模块完成，但不生成也不归档残缺报告。
- 重试：模块 step 最多 3 次、30 秒起指数退避，行情模块单步超时 3 分钟，聚焦采集 10 分钟。AI step 最多 2 次、1 分钟起指数退避，超时 15 分钟。采集 adapter 不做业务重试，任一批次失败则整个模块失败，由 step 重试。
- 当日成交、期货和报价不支持历史重放。未完成的采集 step 会校验上海当天，跨日恢复会失败，不能用当前行情冒充历史报告。已完成的数据步骤和归档步骤可由平台恢复。
- Workflow 只生成并归档报告，成功返回 `reportDate`、`finalizedAt`、`focus`，失败保留原错误。终态由 Cloudflare Event Subscriptions → Messenger 统一发 email + Telegram，接收人、幂等和渠道重试见 [通知管理](messenger.md)。

## 读取与页面

- `GET /api/market-report?date=YYYY-MM-DD` 只从 R2 桶 `market-briefing` 读取并校验该日定稿，上限 512 KiB。缺失返回 404 `REPORT_NOT_FINALIZED`，损坏返回 503。人工 PUT、主动生成和 Workflow 归档都用同一个桶。
- 不带 date 时，优先向 DATA 交易日服务查上海时间 17:00 规则对应的日期，失败时回退本地 `knownMarketClosure`（`src/market-calendar.ts`）。所选日期缺定稿返回 404，不改读更早报告。
- 前端打开、换日期和刷新只 GET 定稿，不请求原始行情、不触发 AI、不现场生成。无数据显示整页错误和重试。文字版与视觉版消费同一份已归档数据，文字版同步展示当前聚焦。
- 日期、视图切换、刷新、导出图片和复制保留。header 导出冻结当前日期、报告和聚焦，同时下载 3 倍像素 PNG 并 PUT 报告 JSON 到定稿 key，只读用户仅下载。两个结果独立反馈，任一失败不取消另一项。导出与生成期间暂停日期和标签切换、刷新及编辑。
- `PUT /api/market-report` 和 `POST /api/market-briefing` 分别用于人工导出归档与主动重新生成，沿用原写权限。旧 `/api/market-resources/*` 仅作已有客户端的公开只读兼容通道。
- prototype-lab 静态版复用同一视觉和文字组件，打包为 SPA，入口 `https://aiwork.dfcfs.cn/prototype-lab/market-briefing--i2a0/`，日期页 `/{YYYY-MM-DD}`。默认日期按上海时间 17:00 和本地休市表计算，与服务端实时日历可能暂时不同。报告由浏览器以 `credentials: omit`、`cache: no-store` 直接读 `https://market-briefing-data.hasbai.xyz/market-briefing/{YYYY-MM-DD}.json`，不经 Gateway 或 Dashboard。该站只读。

## 报告数据规则

- 利率债列表中个别收益率缺失时按 `null` 接收，保留其他有效行情。规范报告保留空收益率，不转为零，也不把整批国债标记为资源失败。
- 原始列表的空容器、空行和缺定位字段的记录不拖累其他记录。成交笔数、两融余额、发行规模、剩余期限和债券分类允许缺失。非空错型由单资源错误边界处理，未知科创标志不得当作普通公募公司债。
- 两融保留最新日期，分别计算有完整两期值的指标。行业与指数各自保留部分值，图表只画有所需数值的项目。交易日缺失时一级发行仍查报告当日，上一交易日比较留空，不猜测节假日。
- 一级发行：
  - 只用报告日和上一交易日数据。同日、同类型、同发行人的多期限合并、东财排除和缺失票息规范由共享加工层完成，视觉与文字版直接消费 `primary_issues`。
  - 规模缺失仍保留明细，相关合计/环比留空，文字显示“规模暂缺”。合计不依赖期限解析，`3+2`、`5+2` 等含权期限或期限缺失不阻断已知规模的汇总。
- OMO 任一金额缺失时，当日净额和含该日的累计留空，不把部分合计写成完整净投放。文字输出按报告日过滤 `operation_date`，报告日没有正值投放记录时显示“今日未开展逆回购操作”。定稿 Schema 和文字反向编辑都支持这些空值。
- 二级成交的债券基础信息批量补全、结构化公募公司债类型、五年期限和东财排除由共享加工层完成。普通公募公司债固定以 `bondType=37`、`bondOfferingType=1` 且 `sciTechInnoBondStatus=0` 判断，不按简称字母猜测。视图派生层用 Theil-Sen / MAD 残差过滤不可比成交。
- 东财存量债的 Bid/Ofr 严格大于零才有效，零值归一为空，不进文字、散点或 tooltip。债券本身及其估值、成交信息继续展示。
- 东财存量债成交收益率须大于零且偏离该券估值不超过 500bp，防止净价（如 100）混入。收藏成交无效时仅回退有效的今日成交，均无效则成交与利差留空，债券、估值和报价保留。回退成交的利差按所用收益率与估值重算。
- 视觉版与文字版共享派生层（OMO 排序、数字格式）。原始资源字段变化须同步 `worker/market-briefing-runner.ts`、`src/market-report-resources.ts`、`src/report-view.ts`、`src/text-report.ts` 和测试。

## 运维

- 休市表在新年度交易所公告发布后更新 `src/market-calendar.ts`，来源：[上交所 2026 年休市安排](https://www.sse.com.cn/disclosure/dealinstruc/closed/c/c_20251222_10802510.shtml)。
- 发布后须程序化请求生产 `/api/market-report` 及显式日期接口，核对 HTTP 状态和 `report_date`。
- Cloudflare 流程图由静态语法分析生成。`completeAll(...).then(...)` 会让解析器把依赖步骤全标为 `starts=1`，所以编排用原生 Promise 批次和直接 `await`。发布后通过 `GET /accounts/{account}/workflows/market-briefing/versions/{version}/graph` 核对：唯一并行组恰有七个模块 step，其后是 AI、归档两个串行 step。见 [Cloudflare 流程图文档](https://developers.cloudflare.com/workflows/build/visualizer/)。
- 手动触发：`pnpm exec wrangler workflows trigger market-briefing '{"reportDate":"YYYY-MM-DD"}' --id market-briefing-YYYY-MM-DD`。失败时先看失败步骤，同日可 `pnpm exec wrangler workflows instances restart market-briefing <id>`。通知投递失败在 Messenger 管理页重试，不重启业务 Workflow。跨日不能补跑实时行情。
