# Neon 与 Cloudflare 资源审计

审计日期：2026-09-20 夜间至 2026-09-21 凌晨（上海时间）。月累计窗口为 UTC `09-01 00:00` 至 `09-20 16:00`。完整业务日窗口为 UTC `09-19 16:00` 至 `09-20 16:00`。跨日累计不能与单日额度直接比较。GraphQL 为自适应统计，不是账单。

结论：主要问题是分钟通知扫描制造的空闲数据库唤醒、重复账号目录调用和 CPU 超限传播。现有存储、读写行数和消息队列远未达到容量瓶颈。本次将生产修改集中在 Dashboard 的一个 PR，通过业务入口消除无效调用，不升级付费计划、不删除历史资源或改动其他仓库。

## 额度与用量

Cloudflare 订阅/账单 API 返回 403，无法确认账户套餐或发票。本表以官方 Free 档额度作保守参照。`usage_model: standard` 不能证明订阅是 Paid。线上确实出现了 CPU 超限。Neon 组织 API 明确返回 `free` / `free_v3`。

| 资源 | 官方额度参照 | 实际观测 | 判断 |
|---|---|---|---|
| Neon eastmoney 计算 | 100 CU·小时/项目/月 | 月累计约 32.21 CU·小时，固定 0.25 CU | 当前有余量。全天常驻 30 天约需 180 CU·小时，持续分钟轮询不可长期维持 |
| Neon eastmoney 存储 | 0.5 GB/项目。API 上限 536,870,912 bytes | 项目逻辑存储约 132.6 MiB。当前数据库约 109.5 MiB | 约占 API 上限 26%，两种大小口径不能混用 |
| Neon eastmoney 出网 | 5 GB/项目/月 | 各分支累计约 0.36 GB | 非主要成本项 |
| Neon 分支 | 10/项目 | eastmoney 与 hasbai 各 8 个 | 各剩 2 个。历史分支已闲置，不自动删除用户数据 |
| Neon hasbai | 独立项目额度 | 9.05 CU·小时、32.6 MiB | 已纳入盘点。不属于本项目生产改动 |
| Workers 请求 | 100,000/账户/UTC 日 | 月累计 74,059。UTC 单日峰值 9,840 | 请求量不是瓶颈，不能将内部调用数直接当账单请求数 |
| Workers CPU | Free 常规 HTTP 每次 10 ms | Gateway 完整业务日 879 次 `exceededResources`，失败样本 CPU 分位数均为 10 ms | 优先处理。成功样本可超 10 ms，不代表余量有保证 |
| D1 读取/写入 | 5,000,000 / 100,000 行/日 | 账户 UTC 单日峰值 24,837 / 3,388 行 | 约 0.50% / 3.39%。不是全表扫描额度危机 |
| D1 容量 | Free 单库 500 MB、账户 5 GB | eastmoney 约 2.09 MiB，messenger 约 0.29 MiB | 不需要拆库或清理历史 |
| Hyperdrive | 100,000 statements/日 | 月累计约 19,377。UTC 单日峰值 7,361 | 语句额度低。缓存与无效轮询值得优化 |
| R2 | Standard 10 GB·月、Class A 100 万/月、B 1,000 万/月免费层 | 所有桶当前 payload 约 351.5 MB。月累计各类操作合计 60,043 | 不需要迁移存储。操作总数不是同一计价类型 |
| Queues | Free 10,000 operations/日 | 月累计 671。单日峰值 629 | 无排队容量问题 |
| Workers AI | 10,000 neurons/日 | 月累计 10,568.01，UTC 单日峰值 7,280.33 | 峰值占 72.80%，批量重新索引是比日常问答更接近额度的行为 |
| Workers Builds | Free 3,000 分钟/月 | 月累计 524.56 分钟，峰值日 71.46 分钟 | 约 17.49%，无需削弱 CI 验收 |

官方来源：[Neon plans](https://neon.com/docs/introduction/plans)、[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)、[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[D1](https://developers.cloudflare.com/d1/platform/pricing/)、[Hyperdrive](https://developers.cloudflare.com/hyperdrive/platform/pricing/)、[R2](https://developers.cloudflare.com/r2/pricing/)、[Queues](https://developers.cloudflare.com/queues/platform/pricing/)、[Builds](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)。价格和额度是本次检索快照，后续以控制台和官方更新为准。

## 性能与失败证据

1. **空闲提醒扫描**：Postgres 统计在 `2026-09-20 06:14:17 UTC` 重置。首次取样提醒 SQL 调用 584 次，累计仅 62.066 ms。后续为 605 次、65.067 ms，返回总行数为 0。生产只有一条有效规则，未来/当日未完成任务为 0。SQL 本身很快，持续唤醒和连接往返才是浪费。不要依据“调用次数占比”误判为数据库 CPU 热点。
2. **身份服务扇出**：代码在每个扫描开始就获取完整通知账号目录，包括周末。Gateway 对每个成员顺序获取用户和角色。完整业务日 Gateway 879 次 CPU 超限，Dashboard 851 次异常，Messenger 882 次内部错误。计数接近且调用链对应，说明故障会沿服务绑定传播，但不是逐条关联追踪的证明。实时 tail 捕获一次成功的目录调用，CPU 19 ms、墙钟约 6.2 秒，说明单次目录成本仍需关注。
3. **数据库查询和连接池**：无持续超过 30 秒的活动查询，无本次发现的临时块落盘。融资首页聚合平均约 33.9 ms、授信历史聚合约 84.6 ms。Data 的一次 quant_input 去重读取约 433 ms，但只有一次样本，不据此盲建索引。主要表为 quant_input 36 MB、edb 16 MB，死元组比例低。Hyperdrive 池峰值仅 1 个已用连接、短暂 1 个等待客户端，不需要提高 20 连接上限。
4. **Hyperdrive 缓存**：月累计 clienthit 2,315、hit 379、miss 5,479、transaction 8,639。交易、RLS 上下文及写后读不能通过统一拉长缓存 TTL 提速。本次不修改全局 Hyperdrive 缓存，也不把权限数据库旧配置的存在当作持续收费证据。最初带 `isFree` 分组的查询返回空。去掉该维度后取得有效统计，空结果不能解释成零使用。
5. **Workflow 与消息**：近七日 Article 重试 24 次、市场点评 34 次、EDB 10 次。旧 EDB 错误为 DM `/cfets-histories` 503，最新三次自动运行已成功。旧 OMO 错误来自 09:25 截止逻辑，后续新版本手动运行成功。保留错误历史，不重放会触发外部消息的任务。Messenger inbox 无未完成通知或 Workflow 事件。两条历史 Web Push 失败均为 `PUSH_TRANSPORT_ERROR`，各累计 12 次尝试，不能宣称真实投递已恢复。
6. **AI 与可观测性**：本月 embedding 6,603 次、约 980.6 万输入 token，记录成本约 $0.116。custom-codex 477 次，其中 41 次错误，约 469.2 万输入/51.3 万输出 token。自定义 Provider 成本为 0 表示缺少成本映射，不能认定免费。Dashboard traces 原为 100%，改为 10% 以减少采集开销。logs 保留 100%。[Tracing 文档](https://developers.cloudflare.com/workers/observability/traces/)仍需按当前 Beta/计费规则解释，不把采样下降直接换算为已节省账单。

Durable Objects 月内记录 289,484 行读取、54,001 行写入，未观测到 CPU/内存超限。这是账户聚合，不能全部归到 CreditAgent。AI Search ingestion 数据集为空，不能由此判定索引健康或完全无用量。Workers AI 的 neuron 额度按[官方定价](https://developers.cloudflare.com/workers-ai/platform/pricing/)核对，批量重建索引应按剩余额度分批。

## 本次实施

- 交易提醒先检查工作日和节点起止时刻的五分钟窗口，再读取实时账号资格。未到期、午夜和周末不做完整目录扇出。实际投递资格和用户隔离不变。
- 融资 SQL 候选集为空时，在 D1 记录下一整点检查时间，最多将空闲扫描从每天 1,440 次降低到 24 次，减少约 98.3%。这是已验证的调用次数上界，不是已结算 CU 节省。Hyperdrive 空闲连接回收、其他页面/同步流量仍会影响休眠。
- 所有融资写请求在执行前后失效检查点，generation 防止并发扫描覆盖失效状态。已有候选、无有效收件人、发送失败、查询失败与 dry-run 不进入空闲缓存。跨小时到期正常扫描。
- Dashboard 的 1020 migration 只新增单行调度元数据。不改变 Neon schema、RLS、业务日期、去重键或提醒周期。通过 CLI/直接 SQL 修改业务后，最多下一整点重查。需要立即生效时按[提醒模块](../modules/financing-sop.md#空闲扫描检查点)失效 D1 检查点。
- 增加只读审计脚本和聚合证据快照，后续可在相同时间口径复测，不新增 Cron 监控消耗。

## 验证与发布

本地 `pnpm check:quick` 通过（0 errors，8 条原有 UI warnings）。26 项相关测试通过，覆盖一小时 60 次扫描只打开一次 Neon、下个整点、业务失效、并发/失败失效、无有效收件人、失败重试、交易起止窗口、周末和实时资格失败关闭。1020 已通过本地 D1 与 SQLite 实际 SQL 检查。确认远端仅有该待应用 migration 后，已通过 `pnpm db:migrate:remote` 成功应用。完整 CI、合并组 SHA 和生产部署由此 PR 的交付记录给出。本地结果不替代合并队列验收。

发布顺序：先应用 1020，再合并已通过 CI 的 PR，核对 Cloudflare 自动部署。随后只读检查 D1 检查点、Cron tail、Gateway 请求/错误和 Neon endpoint 是否进入 idle。检查 Neon 休眠时使用控制面 API，不运行 SQL 把数据库唤醒。回滚仅需恢复前一 Worker 版本，新增表可保留，原分钟扫描立即恢复。

## 保留限制与后续条件

- 历史 Observability 查询缺少权限，Neon 日志 API 在该区域不可用。本次使用 GraphQL 指标、实时 tail、Workflow 步骤错误和 pg_stat_statements 补证。不能宣称检查了所有历史日志、完整账单或已证明所有异常根因。
- Gateway 单次完整目录读取仍可能超 CPU。本次先减少 Dashboard 无效调用。若在真实提醒窗口仍出现超限，应在 Gateway 所有方对目录投影/上游批量读取另行优化，并保留实时停用与角色撤销验证。不能把用户资格跨请求长期缓存来规避权限校验。
- 不删除历史 Neon 分支、不自动重发失败通知、不增加收费套餐。两个 Neon 项目均应在新增第三个并行验证分支前处理分支容量。删除需先确认对应任务及回滚用途。

证据：[Cloudflare 聚合快照](cloud-resource-audit-2026-09-21.json)、[Neon 诊断快照](neon-resource-audit-2026-09-21.json)。复测：`node --use-env-proxy scripts/audit-cloud-resources.mjs <from-ISO> <to-ISO> <output.json>`，凭据只通过环境变量注入。
