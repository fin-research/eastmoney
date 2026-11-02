# Choice 上游额度与 Data 限流

Choice 周流量额度由上游账户控制。Data 的分钟限流只约束请求速率。两者计量对象不同，取数前须分别核对。

## 上游周额度

阈值、计量单位、已用量和重置时间会变化，取数前按下文第 1 步查询实时额度。

## Data 分钟限流

[Data 配置](../data/wrangler.jsonc)使用 Cloudflare Workers 原生 Rate Limiting binding。REST、GraphQL、MCP 和内部调用共用同一来源或函数的计数器。每次上游请求单独计数。参数校验失败而未请求上游时不计数。

触限时 REST 返回 `429`、`RATE_LIMITED` 和 `Retry-After: 60`。GraphQL 保留字段错误契约。

| 上游调用 | 绑定与 key | 阈值（次/分钟） |
| --- | --- | ---: |
| Choice CSD、CSS | `CHOICE_FAST_LIMIT`，按函数 | 各 10,000 |
| Choice 其他函数 | `CHOICE_OTHER_LIMIT`，按函数 | 各 10 |
| DM | `DM_LIMIT`，按来源 | 600 |
| 东方财富网页/行情（不含 Choice） | `EASTMONEY_LIMIT`，按来源 | 120 |
| 中国货币网 SHIBOR | `CHINAMONEY_LIMIT`，按来源 | 60 |
| CAMEL 内部请求 | `CAMEL_LIMIT`，按来源 | 60 |

后四项是 Data 自设的入口保护阈值，不是上游合同额度。Cloudflare 的计数按 location 分布且最终一致，不能当作全局精确计费或周额度保护。见 [Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。

## Agent 取数计划

任何 Choice 取数都先完成下列步骤。取数包括试探、补数、失败重试、子代理任务和后台批量任务。改文档、静态测试和离线回放不取数。

1. **查实际额度。** 用已授权的用户 Bearer 或任务所有方的私有绑定调用 `GET /data/choice/data-statistics`。
   - 请求 `funcName` 与返回 `FUNCENAME` 须同本次函数一致。
   - 可查字段：`FUNCENAME,PERIOD,STARTDATE,ENDDATE,THRESHOLD,USEDDATA,USEDRATIO,AVAILABEDATA`。`startDate` 与 `endDate` 成对提供。
   - 记录查询时间、计量单位、周期、总额、已用、剩余和重置时点。
   - 额度、单位或函数标识未查实时不取数。
2. **定范围、盘缓存。** 列出去重后的证券、字段、日期、频率和查询口径，以及已缓存的成功响应。只请求缓存缺口。公司级任务不扩成全市场。
3. **算共享预算。** 按证券 × 字段 × 日期估算数据点，再按上游真实计量单位折算。请求次数与数据点额度分别核算，并为其他业务保留余量。所有代理共享同一预算，子代理只领取明确的范围和上限。
4. **按计划执行。** 历史序列优先用一次 CSD 取整段区间。仅在接口规模或超时要求时拆批，并记录原因。CSS 每次只返回一个 `EndDate` 截面，按日循环前先预算整个日期集。成功响应落盘为检查点，再按实际消耗调整剩余计划。
5. **触限即停。** 遇分钟 `429`、周额度不足或权限错误时，保留错误、缓存和缺口清单。额度恢复后重新查询并续取。不要轮换账号或换函数来规避额度，也不要把权限或额度错误当作“无数据”而填零。

参数和响应以 [Data Choice 路由](../data/src/choice/routes.ts)与 [Choice RPC 契约](../choice/docs/API.md)为准。计划和额度证据存入任务的忽略目录，不提交账户详情或真实业务数据。
