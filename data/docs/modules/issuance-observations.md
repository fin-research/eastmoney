# 发行资料前瞻观察

Data 在既有券商发行 step 中归档有限的 Choice 响应，供后续研究核验实际可见时间。仅包括当前 `BondIssueDetail` CTR、四字段定价 CSS，以及 `RAISEWAY/MATURITYDATE` CSS。不扩展代码池、字段、窗口、分批、额度查询、无效代码二分或重试。常规 live 仍使用原请求，每个子批收到响应后先尝试归档，再继续原解析和入库。付费 step 仍 `retries.limit=0`。

## 证据含义

- `response_received_at` 是实际收到该子批响应或失败的 UTC 时间，独立于 `scheduled_date`。
- 成功响应的 `observed_at` 等于实际接收时间。失败没有值观察，`observed_at=null`。`archived_at` 是首次归档时间。成功空表与 Choice 无数据错误分别保存。
- `TENDERANNCDATE` 保留原始值。`final_coupon_published_at=null`，不拿公告日、计划日期或采集时间替代真实首次发布时间。
- 原请求债券及发行日上下文、返回代码、缺券、字段 absent/null/empty/value、重复/异常代码和定价隔离判断分别保存。原始值仅保留请求字段白名单，不归档上游任意属性、鉴权或错误正文。
- 有效但字段未齐的券沿原90天/64券定价规则继续查询。资料齐全或发行方式已检查后会停止。因此本目录不能证明首次公开时间、全池后续修订或发行前条款版本，不能补造历史可得性。Quant 当前历史/生产模型尚不消费此目录。

## Data 自有 R2 目录

既有 `EASTMONEY` binding 写 `data-observations/bond-issuance/{workflowInstance}/`。不写 Quant 的 `quant-trial/`、Dashboard 的 `fund-reports/`，不新增数据库表或 migration。存储所有权见[共享 DATABASE](../../../docs/DATABASE.md#r2-与检索边界)。

| 对象 | 内容 |
| --- | --- |
| `contents/{sha256}.json` | 有限规范化响应或有限失败类别。哈希不包含接收/归档时间 |
| `requests/{source}/{requestHash}.json` | 稳定来源/字段/选项/排序后代码与原发行日上下文、内容引用、实际时间和质量审计 |
| `live-manifest.json` | 本实例实际请求的完整归档结果，包括失败请求的稳定 identity。缺失时不能证明请求集合完整 |
| `applications/{uuid}.json` | 独立的 live 写库摘要或 replay 应用结果。不修改观察记录 |

仅条件创建，读取后核验内容。同键同内容保留原 `observed_at`。同键不同内容报告冲突，原记录不改写，新响应标为未成功归档。live 归档失败不阻断既有入库，也不追加上游请求。数据库失败不会删除已归档响应。正常 live 不是通用付费缓存，手工创建新的 live 实例仍可能产生原有付费调用。

单对象上限8MiB，实例恢复最多4096个请求，沿用上游响应大小上限。每个响应归档使用两个条件写入并读回校验，另存一次请求 manifest 与应用 receipt。R2有额外操作/容量成本。归档内容未持久化前崩溃、manifest丢失或部分写入失败均为证据缺口，不能声称可无损恢复或自动重新付费补抓。

## 显式恢复

仅通过既有私有 Workflow 的管理触发，不提供 HTTP 归档或恢复 API：

```bash
pnpm exec wrangler workflows trigger economic-indicator-sync \
  '{"issuanceReplayOf":"原实例ID"}'
```

`issuanceReplayOf` 在任何常规经济、Quant、额度或交易日查询前进入独立 replay 分支。不调用上游，重试仍为0。不传该字段就是原全量日常流程。

恢复只读指定原实例的 Data 自有目录，校验规范请求、原发行日、响应哈希、时点和 manifest。按发行 CTR 先建券、CSS 后补资料，同来源依原接收时间/稳定键排序。只处理原成功子批，失败批不能转换为空数据。父批无效代码错误与其成功叶批分别保留。

CTR仅插缺失券，现有整券行跳过且不比较/覆盖字段。定价和方式仅补空，保留已有非空值，检查日期不倒退。若当前数据库发行日已纠正，则报告上下文冲突并跳过旧资料。

`application_status` 说明校验/写库执行是否成功。`coverage_status` 说明请求集合及恢复后的有限字段是否完整，不能解释为模型全量覆盖。manifest不完整/缺失则为unknown，总status为partial。原请求缺券单独披露。

恢复后最终必要字段仍空、定价隔离、单券无效/无数据及上游失败保留缺口。应用 receipt 报告插券、现值跳过、补空/保留/冲突字段、隔离、上下文冲突和最终字段缺口。CTR现值整行跳过时`conflicting_fields=null`，不伪称已比较。即使平台 Completed，仍须查看返回status与receipt。

## 验证

Data 所有的跨项目协议样例为 `tests/fixtures/issuance-observations-v1.json`，由 `tests/helpers/issuance-observation-fixture.ts` 调用实际有限请求、规范化、哈希与质量实现生成。测试核对固定样例并逐记录通过 `readObservation`。它覆盖中文、科学计数浮点、原始短日期、缺失及隔离字段。所有值、实例、时间、ETag及版本均为合成，不证明生产可得性。消费者复制其原始字节并保存所有方版本和样例SHA，不能把合成上传时间当成服务端证据。

测试覆盖原付费请求数量、归档/数据库故障独立、同键重放/冲突、原子条件创建、失败与空值分离、实际晚到时点、二分成功叶批保留、真实PGlite零上游恢复及保护现值。Workflow入口测试禁止恢复时进入正常付费 runner。workerd 本地 R2 绑定验证条件创建和字节/时间保持。它是合成运行时验收，不是生产观察或新前向研究证据。生产验收须分别记录代码版本、实际日常归档实例和内容/时间校验。不为了验收自动付费触发全量同步。
