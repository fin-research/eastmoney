# 研报采集与 ArticleWorkflow

源列表精确匹配 `市场解读`，每次 `pageSize=100`。Data 的顶层 array 与 `fields` 消费见[调度架构](../ARCHITECTURE.md)，共享研报表和归档协议见[共享数据库](../../../docs/DATABASE.md#共享-d1)。

## 采集

另读 DATA `/wechat-articles?onlySubscription=true&pageSize=100&fields=sentimentId,title,accountName,time,url`，只采集生产 DM 账户已关注、上海日期自 2026-10-01 起的公众号文章。两个列表独立失败，同轮重复优先保留 news 路径。休市积压在下一个交易日补采。目前没有已验证的翻页游标，超过 100 条的积压不保证覆盖。

每轮批量查询已有 ID，以及相同标题（仅去首尾空白）与上海自然日。去重后直接启动 Workflow，元数据批次最多 100 条、序列化最多 900 KiB。实例 ID 用稳定的 ASCII `article-{articleId}`，已存在时保持原状态。创建失败由下一轮扫描重试。D1 去重与写入规则见 [DATABASE](../DATABASE.md#写入规则)。

DM 只保留可提取文字，不含图片和图表，本链路不做 OCR。

## ArticleWorkflow

```text
D1 article metadata (atomic title/date deduplication)
 → DM detail
 → optional WeChat download and cleanup
 → AI feature extraction
 → D1 article + article_node + article_claim
 → AI match against policies from the previous 14 days
 → prepareAiSearchMarkdown: strip metadata, images and link destinations; Chinese punctuation spacing
 → R2 Markdown + search metadata
 → Workflow archived
```

- 订阅来源在 Workflow 内取 DM 正文，使用列表长 URL，跳过公众号抓取。默认 source 走 news 链路。
- DM 详情步骤幂等更新原文 link。公众号下载是独立的可重试步骤，失败时回退 DM 已清洗正文。
- 正文明确为空时返回 `status: skipped` / `reason: empty-content`，不执行 AI、关联和归档。字段缺失、类型错误和 HTTP/JSON 异常按步骤重试，最终失败后人工处理。
- AI 特征抽取用统一 adapter 和 Zod Schema，规则见[共享 AI](../../../docs/AI.md)。Adapter 失败交给 Workflow 步骤重试，残缺结果不保存。一次调用同时输出节点（无方向的市场概念）和因果主张（节点之间“原因变化 → 结果变化”，区分已发生与预期），主张的校验与丢弃规则见 [DATABASE](../DATABASE.md#article_node-与-article_claim)。老文章的回填见[图谱回填](../DATABASE.md#图谱回填)。
- 返回 `status: archived` / `indexing: r2-source`。索引完成须独立检查 `completed`。

`prepareAiSearchMarkdown` 是研报和政策共用的归档入口，在唯一一次存储前处理，AI 特征抽取仍用原文。原因：原始中文 Markdown 可能触发 AI Search 的 `file_content_empty`。

- 去除正文前的旧 `Source / Published / URL` 英文元数据头。移除内联与引用式图片、HTML 图片和链接目标，保留链接文字、标题、表格和段落。“数据来源”等研究引用保留。
- 按 CommonMark 源位置处理嵌套括号、图片外层链接和引用定义。损坏的公众号 URL 中的空格整体消费，避免留下查询参数片段。
- 清洗与中文标点补空格整体幂等。清洗覆盖 DM 回退和已缓存的正文，不依赖公众号下载是否成功。

归档对象、检索元数据和索引边界只按[研究归档协议](../../../docs/DATABASE.md#研究归档协议)维护。与政策的双向关联见[政策模块](policies.md)。

## 实现与验证

- [article.ts](../../src/article.ts)：列表/详情契约、日期和稳定 key。
- [ingest.ts](../../src/ingest.ts)：列表查重、直接启动 Workflow 和元数据存储。
- [index.ts](../../src/index.ts)：ArticleWorkflow 步骤。[wechat.ts](../../src/wechat.ts)：公众号下载和清洗。
- [feature-extraction.ts](../../src/feature-extraction.ts)：Prompt / Zod 特征、节点与主张。[graph-backfill.ts](../../src/graph-backfill.ts)：图谱回填 Workflow。
- [tests](../../tests)：按 article、ingest、feature-extraction、wechat 与 Workflow 相关测试选择。
