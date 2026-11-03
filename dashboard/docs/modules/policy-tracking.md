# 政策跟踪

入口：`/trading-research/policy-tracking`。

## 接口

- `GET /api/policies?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&category=...`：读取 Ingest 已聚合的政策时间轴，含 `important` / `related` / `general` 三档重要性、原始政策资讯、已关联研报和一对一点评。不调用 AI。
- `GET /api/policies/articles?q=...`：按标题、机构或摘要检索可关联研报。
- `PUT /api/policies/{id}/articles`：人工确认完整研报 ID 集合。未选中的现有自动关系记为人工排除，后续 Workflow 不覆盖。

点评撰写与修订见 [标准点评](commentary.md)，政策卡片只保留跳转。资讯、研报、点评详情页见 [详情](research-details.md)。

## 数据

- `policy_event`、`policy_news` 由 Ingest 的 Policy Workflow 写入，Dashboard 只读。`importance` 面向境内资金/利率研究。`policy_news` 保存 DM 原文和政策原文链接。
- `policy_article` 只存关系状态、关联方式（`ai` / `manual`）和时间戳。人工关联或排除写为 `manual`，后续 AI 不覆盖。
- 政策聚合只由 Ingest 执行，政策点评只由用户在页面手动生成。表归属见 [共享数据库](../../../docs/DATABASE.md#共享-d1)。
