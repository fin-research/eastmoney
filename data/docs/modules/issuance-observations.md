# 发行资料前瞻观察

Data 在既有券商发行 step 中归档有限的 Choice 响应，供后续研究核验资料的实际可见时间。范围仅限当前 `BondIssueDetail` CTR、四字段定价 CSS，以及 `RAISEWAY/MATURITYDATE` CSS。代码池、字段、窗口、分批、无效代码二分和重试都不扩展。

常规 live 沿用原请求：每个子批收到响应后先尝试归档，再继续原解析和入库。付费 step 仍为 `retries.limit=0`。

## 证据含义

- `response_received_at` 是实际收到该子批响应或失败的 UTC 时间，独立于 `scheduled_date`。
- 成功响应的 `observed_at` 等于实际接收时间。失败没有值观察，`observed_at=null`。`archived_at` 是首次归档时间。成功空表与 Choice 无数据错误分别保存。
- `TENDERANNCDATE` 保留原始值。`final_coupon_published_at=null`，因为公告日、计划日期和采集时间都不是真实的首次发布时间。
- 分别保存：原请求的债券与发行日上下文、返回代码、缺券、字段 absent/null/empty/value、重复或异常代码、定价隔离判断。原始值只保留请求字段白名单，不归档上游任意属性、鉴权和错误正文。
- 有效但字段未齐的券，沿原 90 天/64 券定价规则继续查询。资料齐全或发行方式已检查后停止。因此本目录不能证明首次公开时间、全池后续修订或发行前条款版本。
- Quant 当前的历史和生产模型不消费此目录。

## Data 自有 R2 目录

既有 `EASTMONEY` binding 写 `data-observations/bond-issuance/{workflowInstance}/`，不写 Quant 的 `quant-trial/` 和 Dashboard 的 `fund-reports/`，没有数据库表或 migration。存储所有权见[共享 DATABASE](../../../docs/DATABASE.md#r2-与检索边界)。

| 对象 | 内容 |
| --- | --- |
| `contents/{sha256}.json` | 有限规范化响应或有限失败类别。哈希不含接收和归档时间 |
| `requests/{source}/{requestHash}.json` | 稳定的来源、字段、选项、排序后代码、原发行日上下文、内容引用、实际时间和质量审计 |
| `live-manifest.json` | 本实例实际请求的完整归档结果，含失败请求的稳定 identity。缺失时无法证明请求集合完整 |
| `applications/{uuid}.json` | 独立的 live 写库摘要或 replay 应用结果，不修改观察记录 |

- 对象只做条件创建，读取后核验内容。同键同内容保留原 `observed_at`。同键不同内容报告冲突，原记录不改写，新响应标为未成功归档。
- live 归档失败不阻断既有入库，也不追加上游请求。数据库失败不会删除已归档响应。
- 单对象上限 8MiB，实例恢复最多 4096 个请求。每个响应归档用两次条件写入并读回校验，另存一份请求 manifest 与应用 receipt，R2 有额外的操作和容量成本。
- 归档内容未持久化前崩溃、manifest 丢失或部分写入失败，都是证据缺口，不能声称可无损恢复。
- 这不是通用付费缓存。手工创建新的 live 实例仍会产生原有付费调用。

## 显式恢复

仅通过既有私有 Workflow 的管理触发，没有 HTTP 归档或恢复 API：

```bash
pnpm exec wrangler workflows trigger economic-indicator-sync \
  '{"issuanceReplayOf":"原实例ID"}'
```

`issuanceReplayOf` 在任何常规经济、Quant 或交易日查询前进入独立 replay 分支，不调用上游，重试为 0。不传该字段就是原全量日常流程。

- 恢复只读指定原实例的目录，校验规范请求、原发行日、响应哈希、时点和 manifest。按发行 CTR 先建券、CSS 后补资料，同来源按原接收时间和稳定键排序。
- 只处理原成功的子批，失败批不转为空数据。父批的无效代码错误与其成功叶批分别保留。
- CTR 只插入缺失的券，现有整券行跳过，不比较也不覆盖字段。定价和方式只补空，保留已有非空值，检查日期不倒退。当前库的发行日已纠正时，报告上下文冲突并跳过旧资料。
- `application_status` 表示校验和写库是否成功。`coverage_status` 表示请求集合及恢复后的有限字段是否完整，不代表模型全量覆盖。manifest 缺失或不完整时为 unknown，总 status 为 partial。原请求缺券单独披露。
- 恢复后仍为空的必要字段、定价隔离、单券无效或无数据、上游失败都保留为缺口。
- 应用 receipt 报告插券、现值跳过、补空/保留/冲突字段、隔离、上下文冲突和最终字段缺口。CTR 整行跳过时 `conflicting_fields=null`，表示未比较。
- 平台 Completed 后仍要查看返回的 status 与 receipt。

## 验证

Data 所有的跨项目协议样例为 `tests/fixtures/issuance-observations-v1.json`。`tests/helpers/issuance-observation-fixture.ts` 调用实际的有限请求、规范化、哈希与质量实现生成它，测试核对固定样例并逐记录通过 `readObservation`。样例涵盖中文、科学计数浮点、原始短日期、缺失和隔离字段。所有值、实例、时间、ETag 和版本均为合成，不证明生产可得性。消费者复制其原始字节，并保存所有方版本和样例 SHA。

测试覆盖：

- 原付费请求数量，归档与数据库故障相互独立。
- 同键重放与冲突，原子条件创建。
- 失败与空值分离，实际晚到时点。
- 二分后成功叶批保留。
- 真实 PGlite 的零上游恢复和现值保护。
- Workflow 入口测试确认恢复时不进入常规付费 runner。workerd 本地 R2 binding 验证条件创建、字节与时间保持。

生产验收分别记录代码版本、实际日常归档实例和内容/时间校验。验收不为此自动触发付费的全量同步。
