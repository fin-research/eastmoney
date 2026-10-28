# 经济指标同步

Data 拥有 `economic-indicator-sync` / `EconomicIndicatorSyncWorkflow`。Messenger 私有 `ScheduledTasks` 每日上海 00:00（UTC `0 16 * * *`）触发。先按计划时间的上海日期检查周末，再用 Choice 上交所日历确认交易日。仅交易日创建 Workflow，休市正常跳过，日历异常停止本轮并记录 `economic_indicators_calendar_unavailable`。`src/sync/` 维护采集目录、Choice/DM 标准化、Neon 写入和 Quant 输入。主、子实例的上游请求直接经本 Worker 的 `handleRequest` 进入现有路由和 VPC adapter，不调用自身 Service Binding，不开放公网 HTTP 触发端点。

`public.edb`、`public.quant_input`及券商研究输入表 的 migration 与维护脚本随写入方迁至 Data，沿用 `public.edb_schema_migration`，不重建表或重放已登记 migration。Dashboard 只读 EDB。R2 `eastmoney/fund-reports/` 的上传仍归 Dashboard，Data 读取并规范化。有限发行观察另写 Data 自有 `data-observations/bond-issuance/`，见[前瞻观察](issuance-observations.md)。

同步目录 `economic-indicator-definitions.ts` 仅包含代码、频率、回看窗口。Dashboard 的标签、单位与展示换算独立维护。新增指标须同时核对消费端使用的代码。

## 增量任务隔离与诊断

交易日上海 00:00 的主 Workflow 按依赖编排八个业务组，拉取、规范化、Neon upsert 均在所属 durable step 内完成。最后一个 `汇总同步结果` step 保存总结果和 Quant 日汇总。DM 组在独立子实例执行，其他七组在主实例执行：

- `同步 Choice 经济指标`：保留回看窗口、代码族及每批最多 8 个指标的上游分批，在同一 step 并发请求。收齐成功批次后共享发布日期代理映射并统一入库。
- `同步 DM 资金面`：Data 的 `dm-funding-sync` / `DmFundingSyncWorkflow` 子实例执行 DR001、DR007、R007、SHIBOR O/N、1W、3M 六个请求，在同一 step 并发拉取、统一入库。主流程创建子实例后等待一次 `dm-funding-result` 事件，最长15分钟，不轮询状态。子实例在数据步骤完成后独立发送结果；通知步骤最多重试两次，只重发结果，不重取数据。事件可在父流程开始等待前缓冲。返回结果校验父子实例 ID、计划时间和 DM 组结构后合入主汇总。业务 partial/failed 仍保留成功行数与逐请求失败。保留等待超时及平台原始错误，不终止或重建子实例。子实例 ID 由主实例 ID 的 SHA-256 固定派生；创建响应丢失时仅查询一次状态以认领同 ID 实例。旧子实例参数没有 `notifyParent` 时保留原输出，不发送新事件。
- 权益组等待 Choice 宏观组完成入库，不等待 DM 子流程；存续债估值仅等待发行资料组完成，以读取提交后的债池；日期复用资金日报的持久化上交所交易日历，不依赖曲线成功。依赖组失败仍保留原失败结果，其他可用来源继续执行。
- `同步 Quant 权益行情与估值`、`同步 Quant 一级市场`、`同步 Quant 券商发行与利差`、`同步 Quant 资金日报`：各自独立执行。权益组改用按中美交易日历与库内缺口裁剪的 CSS 截面，不再每日重复请求已耗尽的权益 CSD。先核对 CSS 实时额度，缺口只插入而不覆盖历史。二级市场 `BondTradingStatistics` 因账户无权限退出每日自动同步，历史数据和手动回填入口保留，见 [Quant 输入](quant-inputs.md)。
- `同步中债券商曲线`：独立查询中债公开接口，验证指定AAA证券公司债到期曲线身份及日期。回查目标日及此前13个自然日，候选仅含周一至周五。已具备七个必需期限的日期不再查询；其余日期成功后立即幂等入库。空响应不写入，也不立即重试，窗口内下次继续回查。瞬时错误最多追加一次重试，失败后停止并报告未完成日期。

此来源不调用Choice，不重复写入来源字段。曲线没有完整历史时只查询目标日。最新完整日期距目标日超过14天时，停止自动补数，改走受控历史恢复。

候选日期不代表官方一定发布报价。七个必需期限齐全也不证明全部密集节点齐全；本步骤不修复该类缺口。14天窗口最多10个候选日、20次公开请求，已完整日期不消耗请求。

Choice 经济指标和 DM 资金面以整组为重试边界：首次加两次重试，等待 1 分钟、2 分钟。每次尝试等待组内全部请求结束。仍有失败时前两次抛错交给平台重试，最后一次将成功来源统一入库并返回失败列表。组内入库失败会重做该组拉取，其他已完成组不受影响。

DM 子实例最多执行 18 次上游 fetch，与主实例的宏观、权益、发行、曲线请求隔离。普通 durable step 和重试不能当作独立子请求额度。此次隔离不保证 Quant 极端无效代码二分批次的整个请求预算。成功空窗口保留历史。

沿用 advisory lock 和事务 upsert，不更改发布日期及观察日口径。

失败诊断保留 Workflow ID、语义步骤、attempt、具体请求 ID/接口/参数与脱敏错误。非 2xx 响应至多 24,000 字符并标记截断。网络、JSON、Schema 错误保持可区分。持久化 step 只返回紧凑的行数、来源状态和失败摘要，不保存原始拉取数据。

最终输出保持 `status=complete|partial|failed` 和逐请求统计，`groups` 汇总全部八个业务 step 的名称、状态、入库量、缺失数据与错误。缺口查询不单独创建 step。一级市场仅查询窗口内未落库的日期，现有日期字段缺口只在返回结果报告。任一经济来源或 Quant 输入失败均反映为 `partial`。

全部经济来源失败时先保存汇总，再使 Workflow Errored。不能把平台 Completed 等同于全部刷新成功。纯数据缺口与执行错误通过 Quant `failures.kind` 区分，详细口径见 [Quant 输入](quant-inputs.md#执行与缺口诊断)，整体缺口仍保持 partial。Quant 的付费查询继续不自动重试。

失败审计在业务 step 内保存，不再增加逐来源 failure step。

## 同名 Workflow 切换

保留 `economic-indicator-sync` 名称及 class。切换前确认无运行、排队、暂停或等待实例。停止 Dashboard 午夜 Cron，再部署 Data 并核对 Workflow 的 `script_name=eastmoney-data`，最后部署已移除该 Workflow 的 Dashboard。不要删除 Workflow，保留历史实例和命名空间。

当前定时触发已集中到 Messenger。部署后核对 Data/Dashboard 不配置 Cron，并核对两个 Worker 的线上版本。旧的已完成实例仍代表旧代码，不能重新启动作为新代码验收。

## 维护

在 Data 仓库运行 `pnpm edb:db:migrate`、`pnpm edb:update -- --apply --incremental` 或显式 `--full`。全历史只作为受控维护，不在 Cron 中执行。实际指标清单、分批规则和发布日期证据以 `src/sync/` 为准。

显式 `issuanceReplayOf` 管理恢复在常规日常流程前单独分流，只读原观察并保守补空，不调用任何上游。它不是重新收费采集的局部模式，命令与状态见[前瞻观察](issuance-observations.md#显式恢复)。

## EDB Data HTTP响应原文

日更EDB每次请求在 `eastmoney/data-observations/edb-responses/<workflow>/<request>/attempt-<n>.json` 保存独立证据，版本为 `edb-response-v1`。保存EDB Data HTTP响应原文，并按现有规则脱敏。此证据不是Choice RPC或SDK原始字节。保存请求参数、计划时间、尝试次数、捕获时间、HTTP状态、完整/截断标记、接收字节哈希和脱敏后正文哈希。日期、NULL、零及缺失字段保留在响应正文；日期映射与入库规则不变。

归档失败只记录固定错误和请求/尝试标识，成功响应仍校验并入库；组与总结果为 `partial`，通过 `archiveFailures` 与来源失败分开。归档失败不触发付费重取。

原来源错误和整组有限重试保持不变，每次尝试使用不同对象键。对象仅创建、不覆盖；冲突列为归档失败。DM不新增此归档，CSS原有严格归档契约不变。

原始正文不进入成功步骤汇总；`archivedResponses` 统计最终尝试成功归档数。较早尝试的归档失败保留在日志中，不累加到最终汇总。旧实例不会追补原响应，此变更不能证明旧日期记录的来源语义。
