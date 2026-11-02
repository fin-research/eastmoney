# D1 数据规则

D1 schema 以 [migrations](../migrations) 为事实来源。本文件维护 Ingest 的表粒度、幂等和写入步骤。生产共享表所有权与两仓库迁移协同见[共享数据库](../../docs/DATABASE.md#共享-d1)。

## `article`

- `id` 是 DM `sentimentId`，也是文章主键。增量同时按标题（去首尾空白）与上海自然日去重。
- `news_id` 是上游兼容 ID。`link` 只在为空或变化时更新。
- `author`、`summary`、`importance`、`prompt_version` 是经 Schema 校验的结构化特征。

研报正文、R2 内容、AI Search 状态和上游原始 JSON 不写入 D1。政策正文留在 `policy_news`。

## `keyword`

- 主键 `(article_id, ordinal)`，删除文章时级联清理。保存 `topic`、`fact`、`interpretation`、`impact`。
- 同一文章重跑抽取时，用一个 D1 `batch()` 删除旧关键词并写入新特征与新关键词，避免半更新。

## `telegram_delivery`

- `article_id`：待发送或已推送的 DM `sentimentId`，也是抓取去重主键。
- `discovered_at`：Cron 首次发现并由 Workflow 入库的时间。`workflow_instance_id`：首次入库该资讯的 Workflow，并发实例不发送不属于自己的记录。
- `sent_at`、`telegram_message_id`：历史直发记录的成功时间和消息 ID，新记录为空。
- `messenger_id`、`submitted_at`：提交给 Messenger 的 ID 和时间，不代表 Telegram 已发送。
- 只有标题以全角 `中国央行：` 开头且精确含 `经济数据&政策` 标签的资讯会写入。
- Workflow 第一步写待发送记录，第二步提交 Messenger 并更新提交字段。第二步重试时，已有 Telegram 消息 ID 或 Messenger 提交 ID 的记录被跳过。最终发送状态归 Messenger。

## 写入规则

- 轮询每组 20 个候选查询现有 ID、日期和标题，以避开 D1 参数上限，不读正文。
- Cron 去重后直接启动 Workflow，不在采集端预占 D1 记录。
- ArticleWorkflow 第一步用 `INSERT … SELECT … WHERE NOT EXISTS` 原子保护标题与上海自然日，用 `ON CONFLICT(id) DO NOTHING` 保护 ID。相同 ID 的步骤重试可继续，不同 ID 重复则结束 Workflow。
- 已存在文章在普通轮询中不更新，避免每五分钟写放大。不扫描未特征化记录，不对账，不自动重启实例。
- 订阅来源的首次 insert 保存列表长 link；news 来源的首次 insert 不存 link，由详情步骤补充。正文在 Workflow 内读取，不作为启动参数，不写 D1。
- 元数据保存后，空白正文正常跳过，不触发失败告警。最终接口失败仍保留记录供列表查重。
- Telegram 抓取在 Workflow 外按 `telegram_delivery.article_id` 去重。无新增不创建 Workflow，新增批次只创建一个。

## 政策跟踪

- `policy_event`：一条已归并的政策事件或政策包，保存规范标题、累计摘要、累计发布部门、政策日期、首末资讯时间和 `importance`。重要性以境内资金面、货币市场和利率影响为中心，取值 `important`、`related`、`general`。同一集中发布的一揽子安排不按文件拆卡。
- `policy_news`：`中央政策` 资讯队列及政策证据。抓取后以 `pending` 入库并由 Workflow 认领，归并完成后变为 `grouped` 并关联一个 `policy_event`。超时认领由后续 Cron 接管。
- `policy_article`：政策与研报的多对多关系，只存关系状态、关联方式和时间戳。`manual` 表示人工关联或排除，自动 upsert 不覆盖。
- `policy_article_decision`：Ingest 独占的组合判定缓存，主键 `(policy_id, article_id)`，存 `input_hash`、正负 `related` 与 `updated_at`。两个方向共用，父记录删除时级联清理，政策合并不迁移来源判定。缓存与正向 AI 关联同批写入，负判定不删除已有关系。Dashboard 不读此表，本地同步脚本不含它。
- `commentary`：Dashboard 维护的标准点评。Ingest 只读其是否存在，以保护已有点评的政策卡片不被自动并入其他卡片。本仓库 `0020` 只为独立本地环境建镜像。生产与已有历史库须先执行 Dashboard `1021` 改名。
- 自动识别近期多张卡片属于同一政策包时，保留覆盖面最完整的卡片。先迁移其他卡片的 `policy_news` 和 AI 研报关系，再删除空卡片。含人工研报关系或研究点评的卡片不作为合并来源。

## Migration

- 结构变化新增 migration，不改写历史文件。运行 `pnpm db:migrate:local` 后执行全部测试。
- 远端 `pnpm db:migrate:remote` 只在明确的 schema 交付任务中执行。
- Dashboard 读取同一生产 D1 的文章与关键词。字段或约束变化须同步检查其镜像 migration、同步脚本和热点证据查询。
