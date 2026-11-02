# 共享数据库与存储

本文件拥有跨项目存储归属、读写边界和迁移协同。字段和约束以各项目 migration 与 repository 为准，不复制 DDL。领域事务、业务日期和对象 key 见模块文档。

## 共享 D1

Dashboard 与 Ingest 的 `DB` 指向同一个生产 D1 `eastmoney`，以两边 wrangler 配置中的 database ID 为准（[Dashboard](../dashboard/wrangler.jsonc)、[Ingest](../ingest/wrangler.jsonc)）。两个项目的本地 D1 和 migration 目录相互独立。

| 数据事实 | 写入职责 | 读取与约束所有方 |
|---|---|---|
| `article`、`keyword` | Ingest 增量发现与 ArticleWorkflow 特征覆盖 | [Ingest 数据规则](../ingest/docs/DATABASE.md)、[Dashboard 热点](../dashboard/docs/modules/market-hotspots.md) |
| `policy_event`、`policy_news` | Ingest 队列认领、政策归并与正文归档 | [Ingest 政策模块](../ingest/docs/modules/policies.md)、[Dashboard 政策跟踪](../dashboard/docs/modules/policy-tracking.md) |
| `policy_article` | Ingest 自动匹配。Dashboard 人工关联或排除 | 人工决定优先，自动 upsert 不覆盖。规则见政策模块 |
| `policy_article_decision` | Ingest 独占的政策与研报组合正负判定缓存 | Ingest 双向关联复用，Dashboard 不读。规则见 [Ingest 数据规则](../ingest/docs/DATABASE.md#政策跟踪) |
| `commentary`、`commentary_workspace`、`commentary_revision`、`commentary_pdf` | Dashboard 标准点评、工作区、历史版本与 PDF 索引 | Ingest 只读 `commentary` 是否存在，以保护已有点评的政策不被自动合并 |
| `hotspot_snapshot` | Dashboard 手动生成后追加 | [热点快照](../dashboard/docs/modules/market-hotspots.md) |
| `trading_workflow_config` / `trading_workflow_progress` | Dashboard 共享节点配置。按用户和日期保存调度进度，用 revision 条件写 | [交易流程](../dashboard/docs/TRADING_RESEARCH_WORKBENCH.md#交易流程)。询价行、名单和备注留在浏览器本地 |
| `telegram_delivery` | Ingest TelegramWorkflow | [通知模块](../ingest/docs/modules/telegram.md) |

研报正文不存 D1。政策正文留在 `policy_news`，供详情与点评取材。

修改共享结构时，同时检查 [Dashboard migrations](../dashboard/migrations)、[Ingest migrations](../ingest/migrations)、[本地同步脚本](../dashboard/scripts/sync-remote-d1.mjs)和实际查询。两套 migration 对应同一个生产库，核对实际 DDL 和已执行状态，避免重复执行非幂等变更。不改写历史 migration。

点评表由 Dashboard `1021_unify_commentary.sql` 在生产库直接改名，保留正文、政策关联、历史版本和 R2 key。Ingest `0020_mirror_commentary.sql` 只用于独立本地初始化，在生产库执行会建出空表。

## 消息投递 D1

`messenger` D1 由 Messenger 独占。业务方只能经私有服务绑定访问。

- 投递：`messages`、`attempts`、`retry_audit`。Queue `messenger` 只携带消息 ID。
- 工作流事件：`workflow_events`。Queue `messenger-workflow-events` 接收平台事件，先写入 inbox 并冻结通知快照。
- 用户通知：`notification_settings`、`push_subscriptions`、`notifications`、`notification_schedule`。订阅主键为 Auth0 subject，联系邮箱可不同于登录邮箱。Web Push 的 endpoint/auth/p256dh 不进日志或管理详情。

无法写入 inbox 的平台事件重试后进入死信队列 `messenger-workflow-events-dlq`。Dashboard 的 `reminder_deliveries` 和 Ingest 的 `telegram_delivery` 保留历史与业务提交关联，新渠道结果以 Messenger 为准。Messenger 不直接读 Dashboard D1 或融资 Neon，只调用私有 `NotificationSource`。迁移和接口见 [Messenger](../messenger/README.md)。

## Neon 领域与迁移所有权

Dashboard 维护业务 Neon schema 的 migration。Data 维护 `public.edb` 与 Quant 原始输入的 migration。Gateway 保留 `authorization` schema 的历史 migration。Quant 本地只读输入，线上结果经所有方的发布函数写入。同一数据库或 binding 不构成跨领域写入授权。

| 领域 | Schema / 对象 | Migration 所有方 | 读写边界与领域入口 |
|---|---|---|---|
| 二级池 | `bond` | [postgres-migrations](../dashboard/postgres-migrations) | Dashboard 导入与 repository。[二级池](../dashboard/docs/modules/secondary-bond-pool.md) |
| 授信 | `credit` | [credit-migrations](../dashboard/credit-migrations) | Dashboard 本地导入、报表和自动保存。[授信](../dashboard/docs/modules/credit-workbench.md) |
| 融资业务 | `financing` | [financing-migrations](../dashboard/financing-migrations) | Dashboard 融资 adapter。[融资数据](../dashboard/docs/modules/financing-data.md) |
| 融资模型 | `financing_model` | [financing-model-migrations](../dashboard/financing-model-migrations) | Quant Workflow 原子发布。Dashboard 管理人工结论和研究快照，见[下节](#融资模型跨仓库写入) |
| 历史应用权限 | `authorization.permission` / `role_permission` | [gateway](../gateway/authorization-migrations)、[dashboard](../dashboard/authorization-migrations)（内容相同） | 运行时不读写，不删表、不重放。权限来源为 Auth0。[Gateway 开发](../gateway/docs/DEVELOPMENT.md) |
| 客户主数据 | `public.client` / `client_alias` | financing migration。credit migration 维护领域关联 | [客户与授信关联](../dashboard/docs/modules/clients.md) |
| 经济观测 | `public.edb` | [edb-migrations](../data/edb-migrations) | Data 回填与增量 Workflow 写入。Dashboard 研究和负债周报只读。[同步](../data/docs/modules/economic-indicator-sync.md) |
| 债券模型非债券级输入 | `public.quant_input` | [edb-migrations](../data/edb-migrations) | Data 按字段和观察日维护行情与公司输入。同日 LCR/NSFR 以资金日报覆盖工作簿。[Quant 输入](../data/docs/modules/quant-inputs.md) |
| 券商债一级/二级研究输入 | `public.bond_issuance` / `bond_history` / `bond_industry_curve` | [edb-migrations](../data/edb-migrations) | Data 写入。发行表每券一行，二级历史只存交易所债券的整数代码与观察值。Quant 只读并计算主体利差。[Quant 输入](../data/docs/modules/quant-inputs.md) |

Dashboard 业务数据与 Data 经济指标同步使用 `HYPERDRIVE`。Gateway 不绑定数据库，角色权限由 Auth0 管理并缓存（见 [AUTH](AUTH.md)）。Dashboard 的业务 RLS 和事务权限上下文不变。

Auth0 独占用户、角色、成员关系和角色权限，应用库只关联 Auth0 ID。融资负责人、经办人和周报生成人直接存 Auth0 ID。

## 融资模型跨仓库写入

- Quant 线上 BondInferenceWorkflow 把结果冻结到 R2 `eastmoney/quant-trial/runs/{date}/{instanceId}/result.json`，核对 SHA-256 后调用 Dashboard 所有的 `financing_model.publish_online_result(jsonb,text)`。该函数在一个事务内写公共运行行和类型化表，原始 JSON 只存 R2。接受的版本和表结构见 [financing-model-migrations](../dashboard/financing-model-migrations)。
- 同日保留稳定 ID、人工结论、决策记录和卖方快照。晚到的旧结果不覆盖较新结果。历史相对利差行保留，新页面只列新版运行，且不把旧分位转换为票面。来源版本、训练日、有效期和归档 key 存原生列。
- Dashboard 从类型化列重建快照。人工结论只增量更新，卖方研究追加快照。Quant 不写人工内容。两融没有生产写入。
- Quant 本地 CLI 生成 `issuance-forecast-v1` 票面和可加总贡献，不直接上传。
- Data 拥有行情与一级定价字段的采集和回填，Quant 只读。字段、隔离和缺失规则见 [Quant 输入](../data/docs/modules/quant-inputs.md)。契约变化时，同时核对 Data 来源、Quant Python/JS 一致性和 Dashboard 的迁移、读取、展示。交付以真实 Workflow 发布和 API 核验为准。

## R2 与检索边界

| 存储 | 写入所有方 | 消费者与详细契约 |
|---|---|---|
| R2 `article` 的 `report/`、`policy/` | Ingest 业务 Workflow | AI Search `research` 独立索引。Quant 辅助工具只读研报。[归档协议](#研究归档协议) |
| R2 `eastmoney` | Dashboard 写业务归档和 `credit/` 公开授信材料。Quant 独占 `quant-trial/`。Data 只读 `fund-reports/`，独占 `data-observations/bond-issuance/` | 市场定稿、二级池、资金日报、负债周报快照和授信问答。[Dashboard 存储](../dashboard/docs/DATABASE.md) |
| CreditAgent SQLite Durable Object | Dashboard | 历史授信助手会话。不替代 Neon 授信日报或通用 AI 侧栏会话 |
| 本地 Excel / 模型产物 | Quant 或受控导入脚本 | 不提交 Git |

- 资金日报的规范化字段另存 `public.quant_input`，保留静态缺口和上一交易日余额的原标签，不覆盖资金计划表口径。Dashboard 保留原始日报的上传和读取。
- Data 的发行观察写入自有目录 `data-observations/bond-issuance/`，当前模型不消费，其他所有方不覆写。请求、内容、可见时间和恢复规则见[发行观察](../data/docs/modules/issuance-observations.md)。
- Data 没有 D1 绑定。CAMEL 的 Cache API 会话缓存不是共享数据库或全局锁，规则见 [CAMEL 模块](../data/docs/modules/camel.md)。

### 研究归档协议

- 研报对象为 `report/yyyy-mm-dd/标题.md`，政策为 `policy/yyyy-mm-dd/标题.md`，日期按上海时区计算。稳定 key 与归一化以 [article.ts](../ingest/src/article.ts) 和 [policy-archive.ts](../ingest/src/policy-archive.ts) 为准。
- `type` 为文本 `研报` 或 `政策`。`published_at` 保留原始发布时间，不用重跑或迁移时间替代。其余检索元数据由归档实现维护。
- 写入前统一复用既有的中文标点补空格处理。特征抽取仍读原正文。
- R2 归档完成不等于索引完成。Ingest 不绑定 AI Search，不上传 builtin Item，不在 Workflow 内轮询索引。AI Search 独立同步。检索参数见 [AI Search](AI.md#ai-search)。
- 研究库（R2 `article`）与公开授信材料库（`eastmoney/credit/`）分开，检索与下载规则不通用。

## 迁移约定

- 结构变化进入所有方既有的 migration。命令见目标项目 `AGENTS.md` 指向的开发文档，根目录不放统一 migration 或脚本。
- 原融资 migration 沿用既有 ledger，不因合并仓库重建表、重放历史或复制生产数据。
- 直连凭证只经本地未跟踪的环境变量注入，不进入文档、源码、日志或测试夹具。
- 默认本地开发和纯文档任务不隐含远端迁移或数据重写。迁移前检查约束、索引、事务回滚与读写契约。
- 汇报数据库调整时，列出改动的表、列、索引和数据行。写明迁移前后的核对结果，并区分已执行和未执行的验证与发布步骤。
- 先满足当前业务需求。新增审计表、来源字段、版本表或兼容层，须说明具体读写用途和成本。
