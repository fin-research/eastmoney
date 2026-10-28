# 资讯、研报与点评详情

三个深链复用政策跟踪的来源关系，各自只读取所属内容。接口通则见 [API](../API.md)，关联和人工点评操作见 [政策跟踪](policy-tracking.md)。

| 页面 / API | 来源与实现 |
|---|---|
| `/news/[id]` / `/api/news/[id]` | D1 已归档 `policy_news` 的 DM 正文及政策原文链接。[handler](../../src/routes/api/news/[id]/+server.ts) |
| `/articles/[id]` / `/api/articles/[id]` | Dashboard 通过 DATA binding 获取并校验研报详情，复用 [data-news.ts](../../src/lib/server/data-news.ts)。[handler](../../src/routes/api/articles/[id]/+server.ts) |
| `/commentaries/[id]` / `/api/commentaries/[id]` | 读取 D1 `commentary`，与列表、修订和版本共用标准实体。[handler](../../src/routes/api/commentaries/[id]/+server.ts) |

- 页面加载不生成模型内容。生成和编辑由政策模块的显式操作负责。
- 政策原文链接与 D1 归档的 DM 正文分开表达。不能把存在外部原文链接误当作已取得原文正文。
- 研报正文不回写 D1。保留已有 ID 校验、错误状态与认证边界，不做任意 URL 代理。
- 详情返回政策跟踪的正式工作台路径。旧入口跳转与查询/锚点保留见 [工作台](../TRADING_RESEARCH_WORKBENCH.md#页面范围)。

共享表所有权只在 [项目组数据库](../../../docs/DATABASE.md#共享-d1) 维护。
