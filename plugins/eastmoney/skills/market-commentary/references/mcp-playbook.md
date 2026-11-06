# MCP 取数手册

> 工具名前缀取决于安装方式：作为 eastmoney 插件安装时为 `mcp__plugin_eastmoney_eastmoney__`，单独配置 MCP 服务器时为 `mcp__eastmoney__`；OpenCode / AiWork 为 `eastmoney_`。以 ToolSearch 查到的实际名称为准，匹配短名即可。

取数只用已配置的 `eastmoney` MCP 服务器，不另加服务器、账号或密钥，也不引用本机其他项目。

## 工具名与 schema

下文的“工具”列写的是短名；完整名为 `mcp__plugin_eastmoney_eastmoney__<短名>`，例如 `omo` → `mcp__plugin_eastmoney_eastmoney__omo`，`news_list` → `mcp__plugin_eastmoney_eastmoney__news_list`。这个命名是预期，运行时以实际工具列表为准：

1. 本手册用到的短名：`trading_days`、`omo`、`cfets`、`bond_top_case`、`futures_latest`、`industry`、`margin`、`primary_issues`、`today_trades`、`favorite_quotes`、`bond_infos`、`news_list`，archive 另需 `market_report`。若它们未直接出现，用 ToolSearch 一次性加载（`select:` 列出完整名，或用关键词 `eastmoney`），并读取各自 schema。
2. 短名缺失、被改名，或参数、字段与下表不符时，停止并报告差异，保留原错误信息；不要猜不存在的参数。
3. `provenance` 里的 `tool` 填实际调用的工具名或短名均可（脚本按 `_短名` 后缀匹配，见 input-output.md）。

## 当日 live

记录 `started_at`，固定一次新闻截止时间 `cutoff_at` 为当时真实时间，均为带时区 ISO 时间。`report_date` 是上海当天。行情查询在随后采集区间内完成，不能把新闻截止时间冒充所有行情的精确报价时间。记录每个工具完成时间，结束记 `completed_at`。若跨上海午夜，整次 live 不再有效。

先调用 `trading_days({date:report_date})`，核对返回日期、交易日为真，使用其 `previousTradingDate`，不能手算周五或忽略节假日。然后采集下列资源。可独立读取的行情有限并发（建议2—3），新闻批次顺序执行。

| raw.resources 键 | 工具 | 参数与稀疏字段 |
|---|---|---|
| omo | omo | `startDate` 为报告日减35自然日，`endDate=report_date`；fields=`operationDate,operationName,duration,interestRate,operationAmount` |
| dr | cfets | `date=report_date,source="DR"`；fields=`bondCode,weightedYield,weightedYieldUpDownValueBp` |
| dibo | cfets | 同上但 `source="DIBO"` |
| governmentBonds | bond_top_case | `date=report_date`；fields=`ordinateName,abscissaName,bondCode,tradeNum,yield,yieldSubYtdCloseBp` |
| futures | futures_latest | 无 date；fields=`contractCode,lastPrice,upDownValuePct` |
| industry | industry | `date=report_date`；fields=`dataDate,equities,industries,turnoverYi,turnoverChangeYi` |
| margin | margin | `date=report_date`；fields=`DIM_DATE,TOTAL_RZRQYE,TOTAL_RZYE,TOTAL_RQYE` |
| primary | primary_issues | `date=report_date,startDate=previousTradingDate`；字段见下文 |
| todayTrades | today_trades | `limit=300`；fields=`bondUniCode,remainingTenor,cbYte,tradeYield,tradeYieldSubCb` |
| favoriteQuotes | favorite_quotes | `limit=100`；fields=`bondUniCode,bondShortName,remainingTenor,remainingTenorDay,cbYield,bidYield,bidEntryPrice,ofrYield,ofrEntryPrice,tradeEntryPrice,tradeYieldSubCb` |
| bondInfos | bond_infos | `codes` 为成交与收藏报价的所有非空、非0 `bondUniCode` 去重后逗号连接；fields=`bondUniCode,bondShortName,comShortName,bondType,bondOfferingType,sciTechInnoBondStatus` |

一级 fields=`bidStartDate,issueStartDate,biddingTime,comShortName,issuerShortName,issuerShortNameCn,comFullName,issuerName,publicOffering,publicOfferingText,offeringType,issueWay,raisingMode,bondTypeText,bondShortName,issueTenor,planIssueAmount,issueCouponRate`。

较长代码列表按工具当前限制分批，合并 `bondInfos`，每批保留 provenance。成交/报价没有代码时 `bondInfos=[]` 是本地已知空集，provenance 记 `tool="bond_infos",args={codes:"",skipped_empty_codes:true}`，不用发送空 codes 请求。若有代码但基础信息缺失，继续补查；仍缺则停止完整报告。

不要遗漏字段投影：请求这些 fields 后才能进行单位与业务校验。正常空列表保留为空；错误响应不能解包成空列表。MCP 响应通常是 `structuredContent.data`，有时另包一层 `structuredContent` 或只提供 JSON 文本。只剥离传输 envelope；raw.resources 内保存业务 DTO，不保存 MCP content block。

`industry.dataDate` 必须为报告日。MCP 没有股市摘要类工具：`stock_paragraphs` 由你根据同日 `industry` 的指数、成交、行业及新闻撰写。

## 新闻（live 与 archive 共用）

顺序调用：

```json
{"date":"<报告日>","important":true,"detail":true,"pageSize":10,"offset":0,"endTime":"<固定cutoff_at>","fields":"sentimentId,title,time,tags,important,content,link"}
```

短名 `news_list`。不足10条停止；满10条继续 offset=10、20、30，最多40条。每批保存 `{offset,endTime,items}`，同一次采集的 endTime 完全一致。重复 ID、分页失败、无正文全部剔除后为空都停止完整报告。达到40条是“最近40条上限”，不声称覆盖全天所有新闻。

正文为空的单条记录可以跳过；不得以标题臆造正文。主要新闻需核对新闻时间、事件时间与行情时间：盘后首次公布的消息只能解释后续预期。

## 历史 archive

1. 调用 `market_report({query:{date:report_date}})`。核对同日、`finalized_at` 非空，保留完整返回为 `snapshot`。404/尚未定稿不能换日或填当前行情。
2. 默认 `cutoff_at` 选该日快照的 `generated_at`；用户指定更晚历史截止时可采用，但必须披露。截止不得早于快照生成时间，不得晚于当前时间。按同一截止抓新闻。历史研究不得纳入截止之后才发布的材料。
3. `snapshot` provenance 记录调用参数和本次真实 `fetched_at`。不调用 `today_trades/favorite_quotes/futures_latest`。包内脚本剔除旧文字及聚焦，只使用定稿行情与新取新闻。

## 验证来源

prepare 会检查业务 DTO、必要资源、上海日期、行业日期、上一交易日、新闻边界和债券信息补全。它不证明取数记录本身真实：模型必须保存实际工具返回，不编造成功结果。带 date 的工具未返回逐行时点时，只能声明按所记录日期请求、于采集区间取得，不能额外声称交易所收盘认证。
