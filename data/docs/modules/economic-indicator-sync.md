# 经济指标同步

Data 拥有 `economic-indicator-sync` / `EconomicIndicatorSyncWorkflow`。Messenger 私有 `ScheduledTasks` 在每日上海 00:00（UTC `0 16 * * *`）触发。流程先按计划时间的上海日期检查周末，再用 Choice 上交所日历确认交易日。仅交易日创建 Workflow，休市正常跳过。日历异常时停止本轮并记录 `economic_indicators_calendar_unavailable`。

`src/sync/` 维护采集目录、Choice/DM 标准化、Neon 写入和 Quant 输入。主、子实例的上游请求直接进入本 Worker 的 `handleRequest`，复用现有路由和 VPC adapter，不调用自身 Service Binding，也没有公网 HTTP 触发端点。

`public.edb`、`public.quant_input` 和券商研究输入表的 migration 与维护脚本在 Data，沿用 `public.edb_schema_migration` ledger。Dashboard 只读 EDB。R2 `eastmoney/fund-reports/` 的上传归 Dashboard，Data 读取并规范化。有限发行观察写 Data 自有的 `data-observations/bond-issuance/`，见[前瞻观察](issuance-observations.md)。

同步目录 `economic-indicator-definitions.ts` 只含代码、频率和回看窗口。Dashboard 的标签、单位和展示换算独立维护，新增指标须同时核对消费端使用的代码。

## 增量任务隔离与诊断

交易日的主 Workflow 按依赖编排八个业务组。拉取、规范化和 Neon upsert 在所属 durable step 内完成，最后的 `汇总同步结果` step 保存总结果和 Quant 日汇总。DM 组在独立子实例执行，其他七组在主实例执行。

- `同步 Choice 经济指标`：按回看窗口和代码族分批，每批最多 8 个指标，当前 9 批。每批一个 durable step（`同步 Choice 经济指标 choice-N`），逐批串行，同一时间只有一个 EDB 请求，入库在本批 step 内完成。每批在 Data 入口计入一次 EDB 限流，日更批数不超过 `CHOICE_OTHER_LIMIT` 每分钟阈值，由测试守护。发布日期代理与依赖指标同批，各批只用本批响应解析发布日期，测试守护同批关系。结果仍汇总为一个 `同步 Choice 经济指标` 组。
- `同步 DM 资金面`：由 `dm-funding-sync` / `DmFundingSyncWorkflow` 子实例执行 DR001、DR007、R007、SHIBOR O/N、1W、3M 六个请求，同一 step 内并发拉取并入库。
  - 主流程创建子实例后等待一次 `dm-funding-result` 事件，最长 15 分钟，不轮询状态。事件可在父流程开始等待前缓冲。
  - 子实例完成数据步骤后发送结果。通知步骤最多重试两次，只重发结果，不重取数据。
  - 主流程校验父子实例 ID、计划时间和 DM 组结构后合入汇总。业务 partial/failed 保留成功行数和逐请求失败。等待超时和平台原始错误如实保留，不终止或重建子实例。
  - 子实例 ID 由主实例 ID 的 SHA-256 派生。创建响应丢失时只查询一次状态，认领同 ID 实例。
- 权益组等待 Choice 宏观组入库，不等待 DM 子流程。存续债估值只等待发行资料组完成，以读取已提交的债池。日期复用资金日报的持久化上交所交易日历，不依赖曲线成功。依赖组失败时保留原失败结果，其他来源继续。
- `同步 Quant 权益行情与估值`、`同步 Quant 一级市场`、`同步 Quant 券商发行与利差`、`同步 Quant 资金日报`、`同步券商存续债估值`各自独立执行，规则见 [Quant 输入](quant-inputs.md)。权益组按中美交易日历和库内缺口裁剪 CSS 截面，缺口只插入不覆盖历史。Workflow 不读取 Choice 额度，用量在开发时规划。`BondTradingStatistics` 因账户无权限退出每日同步，见 [Quant 输入](quant-inputs.md#日常更新)。
- `同步中债券商曲线`：独立查询中债公开接口，验证 AAA 证券公司债到期曲线的身份和日期，不调用 Choice。
  - 回查目标日及此前 13 个自然日，候选只含周一至周五。已具备七个必需期限的日期不再查询，其余日期成功后立即幂等入库。
  - 空响应不写入也不立即重试，窗口内下次继续回查。瞬时错误最多追加一次重试，失败后停止并报告未完成日期。
  - 窗口最多 10 个候选日、20 次公开请求。曲线没有完整历史时只查目标日。最新完整日期距目标日超过 14 天时停止自动补数，改走受控历史恢复。
  - 七个必需期限齐全不证明密集节点齐全，本步骤不修复该类缺口。

Choice 以单批为重试边界，DM 以整组为重试边界。首次加两次重试，等待 1 分钟、2 分钟。失败批次单独重试，已成功的批次不重取、不重复计费。重试至少间隔 1 分钟，落入新的限流窗口。批次耗尽重试后返回失败详情，其他批次不受影响。入库失败只重做该批。DM 组每次尝试等待组内全部请求结束，仍有失败时前两次抛错交给平台重试，最后一次将成功来源统一入库并返回失败列表。

Free 套餐下 CPU 按 step 计，每 step 10 ms；subrequest 按实例预算，不假设 step 或重试重置，见 [CPU 预算](../CPU_BUDGET.md)。每个 Choice 批次只发一次 Data 内部请求，估算每次尝试至多 4 个内部 subrequest（限流、会话 DO、归档、Hyperdrive），无外部 subrequest，响应数百行内，CPU 估约 1–3 ms，均待生产 Trace 核对。批次串行使最坏耗时线性增长：每批最多 3 次尝试，约 9 分钟，9 批全失败约 81 分钟，权益组等待 Choice 组结算的时间同样上限。DM 子实例最多执行 18 次上游 fetch，与主实例的宏观、权益、发行、曲线请求隔离。Quant 无效代码二分的整体请求预算需另行核查，各 Quant 组仍按组一个 step。成功的空窗口保留历史。写入沿用 advisory lock 和事务 upsert，不更改发布日期和观察日口径。

失败诊断保留 Workflow ID、语义步骤、attempt、请求 ID/接口/参数和脱敏错误。非 2xx 响应至多保留 24,000 字符并标记截断。网络、JSON 和 Schema 错误保持可区分。持久化 step 只返回紧凑的行数、来源状态和失败摘要，不保存原始拉取数据。

最终输出含 `status=complete|partial|failed` 和逐请求统计，`groups` 汇总八个业务组的名称、状态、入库量、缺失数据和错误。缺口查询不单独创建 step。一级市场只查询窗口内未落库的日期，现有日期的字段缺口只在返回结果中报告。任一经济来源或 Quant 输入失败都反映为 `partial`。

全部经济来源失败时，先保存汇总，再使 Workflow Errored。平台 Completed 不等于全部刷新成功。纯数据缺口与执行错误通过 Quant `failures.kind` 区分，见 [Quant 输入](quant-inputs.md#执行与缺口诊断)，整体缺口仍为 partial。Quant 的付费查询不自动重试。

失败审计在业务 step 内保存，没有逐来源的 failure step。

## 维护

在 Data 项目运行 `pnpm edb:db:migrate`、`pnpm edb:update -- --apply --incremental`，或显式 `--full`。全历史只作受控维护，不在 Cron 中执行。指标清单、分批规则和发布日期证据以 `src/sync/` 为准。

- 保留 `economic-indicator-sync` 名称和 class。不要删除 Workflow，以保留历史实例和命名空间。已完成的旧实例代表旧代码，重启它不能验收新代码。
- 部署后核对 Data 和 Dashboard 均未配置 Cron，并核对两个 Worker 的线上版本。
- 显式 `issuanceReplayOf` 恢复在日常流程前单独分流，只读原观察并保守补空，不调用任何上游，命令与状态见[前瞻观察](issuance-observations.md#显式恢复)。

## EDB Data HTTP响应原文

日更 EDB 的每次请求在 `eastmoney/data-observations/edb-responses/<workflow>/<request>/attempt-<n>.json` 保存独立证据，版本为 `edb-response-v1`。内容是 EDB Data HTTP 响应原文，按现有规则脱敏，不是 Choice RPC 或 SDK 的原始字节。

- 记录请求参数、计划时间、尝试次数、捕获时间、HTTP 状态、完整/截断标记、接收字节哈希和脱敏后正文哈希。日期、NULL、零和缺失字段保留在响应正文，日期映射与入库规则不变。
- 归档失败只记录固定错误和请求/尝试标识，成功响应仍校验并入库。组与总结果为 `partial`，通过 `archiveFailures` 与来源失败分开。归档失败不触发付费重取。
- 每次尝试使用不同对象键，对象只创建、不覆盖，键冲突列为归档失败。原来源错误和整组有限重试不变。
- DM 不做此归档，CSS 沿用原有严格归档契约。
- 原始正文不进入成功步骤汇总。`archivedResponses` 统计最终尝试的成功归档数，较早尝试的归档失败只留在日志。
- 旧实例不会追补原响应，该证据不能说明旧日期记录的来源语义。
