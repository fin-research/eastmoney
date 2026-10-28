# 研究辅助与统一 EDB

入口：`/trading-research/research`、`GET /api/economic-indicators`。Dashboard 通过 Hyperdrive 只读 `public.edb`，不执行采集或定时同步。

- 展示定义与派生：[economic-indicators.ts](../../src/lib/trading-research/economic-indicators.ts)。
- 最近 18 个月观测查询：[economic-indicators-repository.ts](../../src/lib/server/economic-indicators-repository.ts)。
- Choice/DM、每日 00:00 Workflow、回填及 migration：[Data 经济指标同步](../../../data/docs/modules/economic-indicator-sync.md)。

主键为 `(indicator_code, observation_date)`，同时保存上游发布日期 `published_date` 与同步时间 `synced_at`。页面按发布日期显示。前端只做展示换算、利差派生与抽样。页面和负债周报不直接请求付费上游，不在读端以通用离群规则隐藏观测。异常源值精确剔除由 Data 写入前处理。

存储所有权见 [共享数据库](../../../docs/DATABASE.md#neon-领域与迁移所有权)，研究曲线单位见 [工作台](../TRADING_RESEARCH_WORKBENCH.md#研究)，负债周报口径见 [负债周报](liability-report.md)。
