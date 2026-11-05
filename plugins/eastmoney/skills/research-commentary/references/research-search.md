# 研报检索细则（eastmoney MCP）

写文字快评前读本文件。它规定如何通过 eastmoney MCP 的 `research_search` 检索研报并采用原文。该工具只读，检索 Cloudflare AI Search 的 `research` 索引，返回真实片段、来源元数据及排序信息，通过已授权的 MCP 连接调用，无需另行登录。

## 0. 先确认工具

- 在 Claude Code 中，该工具名通常是 `mcp__plugin_eastmoney_eastmoney__research_search`。工具可能是延迟加载的：先用 ToolSearch 查询 `select:mcp__plugin_eastmoney_eastmoney__research_search`，查不到再按关键词 `eastmoney research` 搜索，并按工具短名 `research_search` 匹配，因为服务器在配置里的命名可能不同。
- 以运行时拿到的 schema 为准，不凭本文件的示例或记忆臆造参数。如果 schema 与本文件不一致（字段改名、嵌套变化、新增必填项），按实际 schema 调用，并向用户简要报告差异，不要猜测字段含义。
- 不得把 `policy_articles` 的 SQL 关键词检索、普通网页搜索或模型记忆当作 RAG 替代品。

## 1. 检索步骤

0. 问题涉及传导、因果或“某事件影响什么”时，先调用 eastmoney MCP 的 `knowledge_graph`（`query.focus` 填事件或资产名，可部分匹配；`days` 取 1 到 90，或用 `start` 与 `end` 指定上海日期范围；默认 14 天）。边是各机构研报的主张，不是已证实的因果：`observed` 为正文称已发生，`expected` 为预期，`contested` 表示多空冲突。取返回的节点名、`claims[].title` 和 `publishedAt` 作为后续检索词与日期依据，引用时写明 `articleIds` 对应的研报。该工具无结果或不可用时，直接进入下列检索，不声称已核对传导图。

1. 用户提供的材料优先参考。
2. 用户指定截止日期或时间窗口时按其要求；否则以用户时区（默认 Asia/Shanghai）的当前日期为截止日，先检索最近 7 个自然日。必须在 `body.ai_search_options.retrieval.filters.published_at` 设置 `$gte` 和 `$lt`：起始日 00:00（含）到截止日次日 00:00（不含），先按用户时区计算，再转为 Unix 毫秒数值。指定精确截止时点时，不引用晚于该时点的材料。不传日期字符串，不靠相关性排序或事后筛选来控制日期。
3. 每次显式设置 `max_num_results=50` 获取候选片段；按来源 key 去重后，最终最多采用 5 篇相关研报。研报检索设置 `type: {"$eq":"研报"}`；需要单独核实政策原文时，另用 `type: {"$eq":"政策"}`。默认 `retrieval_type:"hybrid"`，保留向量与关键词融合检索；用户明确指定 vector 时按其要求。不要擅自关闭查询改写、重排或修改相关性门槛。
4. 查询包含事件名、政策或数据名称，以及资金面、债市或融资传导渠道。无适用结果时，可调整查询，或扩至最近 30 个自然日并同步修改日期过滤，核对旧观点是否仍适用；不自动引用更旧的材料。逐条核对片段的 `item.metadata.published_at`、`type`、`source/author`、`item.key` 和正文。重复片段合并阅读，保留归因及条件；片段不等于完整研报。
5. 从实际返回的正文片段中选取贴合事件、时点和口径的关键短句。适合采用的研报表述保留原文，不做同义词替换；预测仍表述为机构判断，不改成已发生事实。需要补充上下文时继续用 RAG 检索，不要从截断摘要推断未返回的原文。
6. 工具未暴露、权限拒绝、上游失败或无相关材料时，简短说明“AI Search 研报 RAG 当前不可用”或实际检索范围与结果，不声称已检索成功，不降级成 SQL 关键词检索。仍可基于用户提供的已核实材料完成快评。

## 2. 调用示意

字段位置以运行时 schema 为准，下面只表达意图。`query` 是查询字符串，日期和类型过滤放在 `ai_search_options.retrieval.filters`，填入本次计算的实际边界：

```
mcp__plugin_eastmoney_eastmoney__research_search({
  body: {
    query: "<事件/政策名称 + 资金面·债市·融资传导渠道>",
    ai_search_options: {
      retrieval: {
        retrieval_type: "hybrid",
        max_num_results: 50,
        filters: {
          type: { "$eq": "研报" },
          published_at: { "$gte": <起始日00:00 毫秒>, "$lt": <截止日次日00:00 毫秒> }
        }
      }
    }
  }
})
```

毫秒时间戳可用 Bash 计算（以 Asia/Shanghai 为准）：

```sh
node -e "const d=s=>new Date(s+'T00:00:00+08:00').getTime();console.log(d('2026-10-26'),d('2026-11-03'))"
```

## 3. 兼容入口（仅限特例）

仅当当前会话没有 `research_search`、但已连接同一研报 RAG 的 `search` 工具时，可临时调用它（原 schema 使用顶层 `query` 和 `ai_search_options`），日期、类型和 50 条检索参数保持不变。这只是兼容手段，不表示 eastmoney 工具目录已更新；`research_search` 被权限拒绝或执行失败时不要切换到它。
