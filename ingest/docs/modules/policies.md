# 政策采集、归并与研报关联

源列表精确匹配 `中央政策`，每次 `pageSize=100`。页面展示、人工关系和研究点评属于 Dashboard [政策跟踪](../../../dashboard/docs/modules/policy-tracking.md)。共享表所有权见[共享数据库](../../../docs/DATABASE.md#共享-d1)。

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

- 待处理资讯的认领和超时恢复由 `policy.ts` 管理，归并不放在页面加载中。
- 政策正文保留在 D1。事件重要性为 `important` / `related` / `general`，以境内资金与利率影响为准，不用泛行业热点替代。
- 归并按共同改革目标和集中发布安排判断。同一政策包可含不同部门、文件和政策工具，仅行业主题相同不能合并。近期碎片卡片可自动并入总览卡片，含人工研报关系或研究点评的卡片不作为被合并来源。
- 只输出接收本批资讯或实际合并卡片的分组。Prompt 与 Schema 同时限制无操作分组，应用端校验全量资讯唯一覆盖和人工保护。聚合步骤每次尝试预算 11 分钟，覆盖两次最长 305 秒的 Gateway 请求。

## 研报关联

- 双向触发：政策入库时匹配已有研报，研报特征入库时匹配过去 14 天的政策候选。两个方向都须保留。
- 自动关联只用 article 的标题、摘要、机构、发布时间和结构化关键词。政策输入保留规范字段和资讯标题证据，去掉采集首末时间。两个方向用固定的 `decisions: [{ candidateId, related }]` Schema，应用端校验候选 ID 合法、唯一、完整覆盖，失败沿用 adapter 重试。
- `policy_article_decision` 按政策与研报组合缓存正负判定。指纹含双方实际输入、Prompt 版本、模型和 effort，不含触发方向、批次列表和采集时间。两个方向复用未变化的判定，只把未命中的候选送给模型。无候选或全部命中时不调用模型，不主动回填历史。
- 每个政策批次成功后，判定与正向 AI 关联在同一 D1 batch 写入，其他政策失败重跑时可复用。人工 `linked` / `excluded` 在读写时均优先。负判定只记入缓存，不删除已有 AI 关系。并发首次未命中可能同时调用模型，不加锁。
- D1 表粒度、状态和保护条件见 [DATABASE 政策跟踪](../DATABASE.md#政策跟踪)。R2 归档见[研究归档协议](../../../docs/DATABASE.md#研究归档协议)。

## 实现与验证

[policy.ts](../../src/policy.ts) 拥有认领、Schema、Prompt、归并和双向匹配。[policy-archive.ts](../../src/policy-archive.ts) 拥有政策 Markdown 与 R2 adapter。[index.ts](../../src/index.ts) 编排步骤。AI 参数见[共享 AI](../../../docs/AI.md)。

结构变化同时核对两仓库 migration、本地镜像和 Dashboard 读取方。专项测试见 [tests](../../tests) 的 policy 测试。
