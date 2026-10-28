# Choice 上游额度与 Data 限流

Choice 的周流量额度由上游账户控制。Data Worker 的分钟限流只约束请求速率。两者计量对象不同，调用前必须单独核对周额度和预计数据消耗。

## 上游周额度

上游阈值、计量单位、已用量及重置时间会变化。2026-09-21 的后台截图只显示了部分函数阈值，不能用作当前预算。实际取数前按下文查询对应账户和函数的实时额度。

## Data Worker 的分钟限流

[Data 配置](../data/wrangler.jsonc) 使用 Cloudflare Workers 原生 Rate Limiting binding。实际发起上游请求前计数。REST、GraphQL、MCP 和内部调用共用同一来源/函数计数器。一个 API 请求触发的每次上游请求均单独计数。

参数校验失败且未发起上游请求则不计数。触限时 REST 返回 `429`、`RATE_LIMITED` 和 `Retry-After: 60`。GraphQL 保留其字段错误契约。

| 上游调用 | 绑定与 key | Data 阈值 |
| --- | --- | ---: |
| Choice CSD、CSS | `CHOICE_FAST_LIMIT`，按函数分别计数 | 各 10,000 次/分钟 |
| Choice CTR、EDB、DATASTATISTICS、TRADEDATES | `CHOICE_OTHER_LIMIT`，按函数分别计数 | 各 10 次/分钟 |
| DM | `DM_LIMIT`，按来源计数 | 600 次/分钟 |
| 东方财富网页/行情（不含 Choice） | `EASTMONEY_LIMIT`，按来源计数 | 120 次/分钟 |
| 中国货币网 SHIBOR | `CHINAMONEY_LIMIT`，按来源计数 | 60 次/分钟 |
| CAMEL 内部请求 | `CAMEL_LIMIT`，按来源计数 | 60 次/分钟 |

后面四项是 Data 自设的入口保护阈值，不是已核实的上游合同额度。CAMEL 当前没有公开 Data 资源，但其内部 VPC 请求已纳入限流。Cloudflare 的计数按 location 分布且最终一致，不能当作全局精确计费或周额度保护。详见 [Cloudflare Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。

## Agent 取数前的计划

任何 Choice 取数，包括试探、补数、失败重试、子代理任务和后台批量任务，必须先完成以下步骤。文档修改、静态测试和离线回放不得顺带取数。

1. **查实际额度。** 通过已授权的用户 Bearer 或任务所有方私有绑定查询 `GET /data/choice/data-statistics`。旧 Quant 机器应用已退役，不能用于额度查询。核对请求 `funcName` 和返回 `FUNCENAME` 与本次函数及 CTR 报表一致。可查询 `FUNCENAME,PERIOD,STARTDATE,ENDDATE,THRESHOLD,USEDDATA,USEDRATIO,AVAILABEDATA`。

   `startDate/endDate` 必须成对提供。记录查询时间、计量单位、周期、总额、已用、剩余与重置时点。请求一段周日期不代表后台必按该区间计量。额度、单位或函数标识未查实，不发起实际取数。
2. **定范围、盘缓存。** 列明去重后的证券、字段、日期、频率、查询口径及成功原始响应。只请求缓存缺口，不因展示变化、脚本重启或输出截断重复抓取。公司任务不得隐含扩成全市场。
3. **算共享预算。** 列出需求数据点、缓存命中、待补数据点、预计调用数和有限重试量。按证券 × 字段 × 日期估算矩形规模，再依据上游真实计量单位折算。请求次数和数据点额度分别核算，保留其他业务额度。所有代理共享同一任务预算，子代理只领取明确范围与上限。
4. **按计划执行。** 历史序列优先一次 CSD 取所需区间。只有确认接口规模或超时约束时才拆批，并记录原因。CSS 每次只返回一个 `EndDate` 截面，按日循环必须先预算整个日期集。不能因 CSS 阈值较大就代替 CSD 的历史能力。成功响应落盘为检查点，再按实际消耗调整剩余计划。
5. **触限即停。** 遇分钟 `429`、周额度不足或权限错误，保留错误、缓存和缺口清单。不得无界重试、轮换账号或换函数规避额度。不得将权限/额度错误填零或解释为无数据。恢复后重新查询额度并制定续取计划。

额度查询入口的参数和响应事实以 [Data Choice 路由](../data/src/choice/routes.ts) 与 [Choice RPC 契约](../choice/docs/API.md) 为准。计划和原始额度证据存于任务的忽略目录，不提交账户详情或真实业务数据。
