# Ingest 内部架构

本文件拥有调度与模块依赖。跨服务 binding、路由和职责见[共享架构](../../docs/ARCHITECTURE.md)，D1/R2 读写所有权见[共享数据库](../../docs/DATABASE.md)。

## 运行入口与采集契约

- [index.ts](../src/index.ts) 的 fetch 只提供 `GET /health`，其他路径返回 404。`runScheduledCollection` 并行编排研报、央行资讯与政策三条增量链路，并在工作日北京时间 09:20 启动当日公开市场播报 Workflow。
- Workflow binding 见 [wrangler.jsonc](../wrangler.jsonc)。Messenger 的 `scheduler.ts` 维护触发时间：UTC `*/5 0-9 * * MON-FRI`，即上海工作日 `[08:00, 18:00)`。
- 采集前，按 `scheduledTime` 的上海日期检查周末和 DATA `/data/trading-days` 的上交所日历。休市则正常跳过。日历异常时记录 `ingest_calendar_unavailable` 并停止本轮，等待下一次定时调用，不默认放行。
- 研报列表固定 `pageSize=100` 并精确复核标签，只请求 `fields=sentimentId,newsId,title,time,tags`。公开市场播报用 `date` 过滤，不要求 `important=true`。
- 列表与详情经 [data-fetcher.ts](../src/data-fetcher.ts) 的 DATA / InternalData 读取。研报另读仅关注的公众号列表，与 news 按标题和上海日期去重后直接启动 Workflow，见[研报模块](modules/articles.md)。
- 并行分支必须等待完成，一个分支失败不能使另一个已启动的分支悬空。

## 按 Workflow 分流

| 链路 | 业务与步骤 | 数据规则 |
|---|---|---|
| 研报采集、ArticleWorkflow | [研报模块](modules/articles.md) | [article / article_node / article_claim](DATABASE.md#article_node-与-article_claim) |
| 中央政策、PolicyWorkflow | [政策模块](modules/policies.md) | [政策队列与关系](DATABASE.md#政策跟踪) |
| 央行资讯、TelegramWorkflow | [通知模块](modules/telegram.md) | [投递记录](DATABASE.md#telegram_delivery) |
| 公开市场播报、OmoWorkflow | [公开市场播报](modules/open-market.md) | 不写 D1 |

OmoWorkflow 的日实例 ID 为 `omo-YYYY-MM-DD`。Policy 与 Telegram 同一槽位重复创建时，确认既有实例状态，不自动重启。

## 依赖规则

- `article.ts` 定义外部契约和稳定 key，业务模块不自行解析未校验的响应。
- `ingest.ts` 编排去重和 Workflow 启动。`index.ts` 组合 adapter，不复制 HTTP 或存储实现。
- `policy.ts` 拥有政策认领恢复、归并与双向关系，`policy-archive.ts` 拥有政策归档。
- `feature-extraction.ts` 拥有特征 Prompt/Schema。`ai-gateway.ts` 是统一 AI adapter，规则见[共享 AI](../../docs/AI.md)。
- 资源由 Env binding 注入，测试用可替换 adapter 与 Workers runtime。
