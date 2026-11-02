# 资讯、研报与点评详情

三个详情页各自只读所属内容。接口通则见 [API](../API.md)，政策关联和人工点评操作见 [政策跟踪](policy-tracking.md)。

| 页面 / API | 来源与实现 |
|---|---|
| `/news/[id]` / `/api/news/[id]` | D1 已归档 `policy_news` 的 DM 正文及政策原文链接。[handler](../../src/routes/api/news/[id]/+server.ts) |
| `/articles/[id]` / `/api/articles/[id]` | 经 DATA binding 取研报详情并校验，复用 [data-news.ts](../../src/lib/server/data-news.ts)。[handler](../../src/routes/api/articles/[id]/+server.ts) |
| `/commentaries/[id]` / `/api/commentaries/[id]` | 读 D1 `commentary`，与列表、修订和版本共用标准实体。[handler](../../src/routes/api/commentaries/[id]/+server.ts) |

- 页面加载不生成模型内容，生成和编辑由政策模块的显式操作负责。
- 政策原文链接与 D1 归档的 DM 正文分开表达：有外部链接不代表已取得原文正文。
- 研报正文不回写 D1。
- 详情的返回链接指向政策跟踪工作台路径，旧入口跳转见 [工作台](../TRADING_RESEARCH_WORKBENCH.md#页面范围)。
