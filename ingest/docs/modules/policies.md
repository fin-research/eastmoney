# 政策采集、归并与研报关联

源列表精确匹配 `中央政策`，每次 `pageSize=100`。页面展示、人工关系和研究点评属于 Dashboard [政策跟踪](../../../dashboard/docs/modules/policy-tracking.md)。共享表所有权只读 [项目组数据库](../../../docs/DATABASE.md#共享-d1)。

## PolicyWorkflow

```text
Cron → pending policy_news → 认领未占用/已超时记录
     → policy-{scheduledTime} Workflow
     → 有界并发补齐 DM 正文
     → AI 按政策事件/政策包归并并判定境内资金/利率重要性
     → D1 更新规范 policy_event、迁移碎片证据、更新 policy_news
     → R2 policy/ 归档
     → 匹配政策日期 -1 至 +14 日的已有研报
```

- 待处理资讯认领和超时恢复由 `policy.ts` 管理，不把归并移到页面加载。
- 政策正文保留在 D1。事件重要性为 `important` / `related` / `general`，不按泛行业热点替代境内资金与利率影响。
- 自动研报关系只使用 article 的标题、摘要、机构、发布时间和结构化关键词。政策输入保留规范字段和资讯标题证据，移除采集首末时间。两个方向统一使用固定 `decisions: [{ candidateId, related }]` Schema；应用端校验候选 ID 合法、唯一、完整覆盖，失败沿用 adapter 重试。
- `policy_article_decision` 按政策与研报组合保存正负判定。指纹包含双方实际输入、Prompt 版本、模型和 effort，不含触发方向、批次列表及采集时间。两个方向复用未变化判定，仅将未命中的候选批量送给模型；输入或版本变化后重新判断。无候选或全部命中时不调用模型，不主动回填历史记录。
- 每个政策批次成功后立即将判定与正向 AI 关联在同一 D1 batch 写入，其他政策失败重跑时可复用已完成结果。人工 `linked` / `excluded` 在读取与写入时均优先；负判定只记入缓存，沿用既有规则，不删除历史 AI 关系。并发首次未命中仍可能同时调用模型，不引入锁。
- 政策聚合按共同改革目标和集中发布安排判断。同一政策包可含不同部门、文件和政策工具。只有宽泛行业主题相同不能合并。近期碎片卡片可自动归并到总览卡片，但含人工研报关系或研究点评的卡片不得作为被合并来源。
- 仅输出接收本批资讯或实际合并卡片的分组。无新资讯且无合并来源的已有卡片不输出。Prompt 与结构化 Schema 同时限制无操作分组，应用端继续校验全量资讯唯一覆盖和人工保护。聚合步骤每次尝试预算 11 分钟，覆盖两次最多 305 秒的 Gateway 请求。
- 研报特征入库时另触发过去 14 天政策候选匹配。政策入库与研报入库两方向都须保留。
- D1 表粒度、状态、保护条件和事务细节见 [DATABASE 政策跟踪](../DATABASE.md#政策跟踪)。
- R2 key、中文标点处理、`type`、`published_at` 与索引边界只按 [研究归档协议](../../../docs/DATABASE.md#研究归档协议) 维护。

## 实现与验证

[policy.ts](../../src/policy.ts) 拥有认领、Schema、Prompt、归并和双向匹配。[policy-archive.ts](../../src/policy-archive.ts) 拥有政策 Markdown 与 R2 adapter。[index.ts](../../src/index.ts) 只编排步骤。AI 参数按 [共享 AI](../../../docs/AI.md)。

结构变化同时核对两仓库 migration、本地镜像和 Dashboard 读取方。默认测试见 [DEVELOPMENT](../DEVELOPMENT.md)，专项从 [tests](../../tests) 的 policy 测试进入。
