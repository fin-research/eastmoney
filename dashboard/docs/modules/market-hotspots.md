# 市场热点

入口：`/trading-research/market-hotspots`。公共规则见 [文档分流](../../AGENTS.md#context-routing)。仅在任务涉及本模块时读取。

## 接口

- `GET /api/rag/hotspots`：返回最近快照。无快照为 404。不接受范围参数。
- `POST /api/rag/hotspots`：生成并追加快照。前端携带 `Accept: text/event-stream` 时返回统一 `progress/result/error` SSE，普通 JSON 请求成功为 201。
- 滚动请求：`{"mode":"rolling","rollingCount":20}`，数量必须为 8–100 的整数。
- 日期请求：`{"mode":"range","startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD"}`。

## 业务规则

- `GET` 只读取最近一次成功生成的快照，不根据当前筛选重新解释历史结果，也不调用模型。
- `POST` 才按证据范围生成并追加快照。滚动模式默认最近 20 篇。日期范围模式最多读取最近 100 篇已完成特征抽取的文章。
- 输出为 8–15 个热点。热度由模型给出 0–100 分，应用只做 Schema、范围和单来源最高 60 分校验，不重新计算权重。
- D1 只提供标题、摘要、重要性和关键词等结构化证据。文章正文不进入热点查询。
- 页面必须完整展示热点总结与证据文本，不使用截断。证据 ID 位于正文上方。

## 数据流

`ingest` 写入的 D1 `article` / `keyword` → Worker 读取证据 → AI Gateway → 追加 `hotspot_snapshot` → 页面读取最近快照。

## 存储：D1：文章证据、政策跟踪与热点快照

生产绑定为 `DB`，数据库名 `eastmoney`。当前运行时关注：

- `article`：文章元数据、摘要和重要性。不保存正文。
- `keyword`：按 `(article_id, ordinal)` 保存结构化主题、事实、解读和影响。
- `hotspot_snapshot`：追加保存完整热点响应、输入指纹、生成时间、模型和已经解析的证据范围。
- `policy_event` / `policy_news`：由 ingest 的 Policy Workflow 写入规范政策卡片与原始资讯证据。`policy_event.importance` 保存面向境内资金/利率研究的 `important`、`related`、`general` 三档重要性，Dashboard 只读展示。`policy_news` 保留 DM 原文和政策原文链接，供点评生成与统一新闻资讯详情读取，Dashboard 不修改这些字段。
- `policy_article`：政策与 article 的多对多关系，只保存关系状态、关联方式和时间戳，不保存模型置信度或关联理由。Dashboard 人工关联或排除写为 `manual`，后续 AI 不覆盖。
- `commentary`：通用标准化点评，类型覆盖时事快评、政策跟踪和海外事件。当前政策页以 `policy_id UNIQUE` 保证每项政策至多一条点评，并保存 AI 初版和人工修订状态。

`daily_hotspot` 与 `hotspot_cache` 是历史 migration 中的旧结构，不应作为新功能的运行时入口。最新读取统一走 `hotspot_snapshot`。

规则：

- D1 结构修改写入 `migrations/`，并检查共享同一生产数据库的 `ingest` 写入契约。
- 本地开发默认使用本地 D1。`pnpm dev` 不同步远端数据。
- `pnpm db:sync:remote` 仅做显式的有限增量同步。不要把它加入普通启动流程。
- 快照为追加记录，不原地覆盖历史生成结果。
- 政策聚合只由 ingest Workflow 执行。政策点评只由页面人工点击生成，不设自动生成任务。
