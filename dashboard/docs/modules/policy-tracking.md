# 政策跟踪

入口：`/trading-research/policy-tracking`。公共规则见 [文档分流](../../AGENTS.md#context-routing)。仅在任务涉及本模块时读取。

## 接口

- `GET /api/policies?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&category=...`：读取 ingest Workflow 已聚合的政策时间轴，包含 `important` / `related` / `general` 重要性、原始政策资讯、已关联研报和一对一点评。不调用 AI。
- `GET /api/policies/articles?q=...`：按标题、机构或摘要检索可关联 article。
- `PUT /api/policies/{id}/articles`：人工确认完整研报 ID 集合。未选择的现有自动关系记为人工排除，后续 Workflow 不覆盖。
- 点评撰写与人工编辑统一到[标准点评](commentary.md)，政策卡片保留跳转。
- 点评统一使用 `/api/commentaries` 与 `/api/commentaries/{id}`；修订须带 `updatedAt`，旧政策点评写入入口已移除。
- `GET /api/news/{id}`：按 DM `sentiment_id` 读取已聚合政策资讯的标题、时间、DM 原文、政策原文链接与关联政策。对应统一新闻资讯页面 `/news/{id}`。
- `GET /api/articles/{id}`：读取研报 D1 元数据、已关联政策，并通过 `DATA` Service Binding 读取正文。对应独立页面 `/articles/{id}`。
- `GET /api/commentaries/{id}`：按点评 ID 读取标准化点评与对应政策。对应独立页面 `/commentaries/{id}`。
