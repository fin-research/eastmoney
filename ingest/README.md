# 研报文章增量采集

`ingest` 是 Cloudflare Worker，定时读取 `市场解读` 研报，只处理新增文章，并把可检索内容和结构化特征送入研究数据链路。

## 处理流程

1. 工作日北京时间 08:00–18:00 每 5 分钟读取文章列表并批量去重。
2. Workflow 获取正文。微信公众号优先直连下载，失败时回退 DM 正文。
3. 经 AI Gateway 抽取作者、摘要、重要性和权益/利率债关键词。
4. 元数据和关键词写入 D1，Markdown 正文归档到 R2。
5. AI Search 通过 R2 数据源独立同步。Workflow 在 R2 归档完成后结束。

归档与索引边界见[共享存储](../docs/DATABASE.md#研究归档协议)。政策与央行通知见 [AGENTS 模块分流](AGENTS.md#context-routing)。

验证命令与发布流程见 [DEVELOPMENT](docs/DEVELOPMENT.md)。

## 文档

- [AI Agent 入口](AGENTS.md)
- [项目组共享规则](../AGENTS.md)
- [系统架构](docs/ARCHITECTURE.md)
- [D1 数据规则](docs/DATABASE.md)
- [安全边界](docs/SECURITY.md)
- [开发、维护与发布](docs/DEVELOPMENT.md)
