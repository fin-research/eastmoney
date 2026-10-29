# 共享数据库与存储

本文件拥有跨项目存储归属、读写边界和迁移协同。字段和约束以各仓库 migration 与 repository 为事实来源，不复制完整 DDL。领域事务、业务日期和具体对象 key 继续由模块文档维护。

## 共享 D1

Dashboard 与 Ingest 的 `DB` 指向同一个生产 D1 `eastmoney`，以双方 [Dashboard 配置](../dashboard/wrangler.jsonc) / [Ingest 配置](../ingest/wrangler.jsonc) 的 database ID 为准。各自本地 D1 与 migration 目录独立。

| 数据事实 | 写入职责 | 读取与约束所有方 |
|---|---|---|
| `article`、`keyword` | Ingest 增量发现与 ArticleWorkflow 特征覆盖 | [Ingest 数据规则](../ingest/docs/DATABASE.md)、[Dashboard 热点](../dashboard/docs/modules/market-hotspots.md) |
| `policy_event`、`policy_news` | Ingest 队列认领、政策归并与正文归档 | [Ingest 政策模块](../ingest/docs/modules/policies.md)、[Dashboard 政策跟踪](../dashboard/docs/modules/policy-tracking.md) |
| `policy_article` | Ingest 自动匹配。Dashboard 人工关联或排除 | 人工决定优先，自动 upsert 不覆盖。规则见上述政策模块 |
| `policy_article_decision` | Ingest 独占的政策与研报组合正负判定缓存 | Ingest 双向关联复用；Dashboard 不读取或同步。规则见 [Ingest 数据规则](../ingest/docs/DATABASE.md#政策跟踪) |
| `commentary`、`commentary_workspace`、`commentary_revision`、`commentary_pdf` | Dashboard 标准点评、工作区、历史版本与 PDF 索引 | Ingest 只读 `commentary` 是否存在，保护已有点评的政策不被自动合并 |
| `hotspot_snapshot` | Dashboard 手动生成后追加 | [热点快照](../dashboard/docs/modules/market-hotspots.md) |
| `trading_workflow_config` / `trading_workflow_progress` | Dashboard 共享节点配置。按用户、日期保存调度进度 | [交易流程](../dashboard/docs/TRADING_RESEARCH_WORKBENCH.md#交易流程)。询价行、名单和备注仍在浏览器本地 |
| `telegram_delivery` | Ingest TelegramWorkflow | [通知模块](../ingest/docs/modules/telegram.md)。不作为 Dashboard 业务数据 |

研报正文不存 D1。政策正文保留在 `policy_news`，供详情与点评取材。原始上游 JSON 和 AI Search 索引状态不作为研报表字段。

共享结构变更必须同时检查 [Dashboard migrations](../dashboard/migrations)、[Ingest migrations](../ingest/migrations)、[本地同步脚本](../dashboard/scripts/sync-remote-d1.mjs) 和实际查询。两套 migration 不代表两个生产数据库：按共享对象核对实际 DDL 和生产已执行状态，避免在同一库重复执行非幂等变更。保留各仓库本地独立初始化能力（如 Ingest 的点评表镜像）。不改写历史 migration。

点评统一由 Dashboard `1021_unify_commentary.sql` 在生产执行一次直接改名，保留正文、政策关联、历史版本和既有 R2 key。Ingest `0020_mirror_commentary.sql` 供独立本地初始化；生产不得先应用该镜像创建空表，须先完成所有方改名并协同发布两端查询。

## 消息投递 D1

独立 `messenger` D1 由 Messenger 独占，保存 messages、attempts、retry_audit、workflow_events。业务方只能通过私有服务绑定访问。Queue `messenger` 只携带消息 ID。独立 `messenger-workflow-events` 接收平台事件，先写入 workflow_events inbox 并冻结通知快照。

Cron 恢复查询或入队失败，无法写入 inbox 的消息经重试后保留到独立死信队列。Dashboard 的 reminder_deliveries、Ingest 的 telegram_delivery 保留历史与业务提交关联。新渠道结果以 Messenger 为准。迁移和接口见 [Messenger](../messenger/README.md)。

## Neon 领域与迁移所有权

业务 Neon schema migration 由 Dashboard 维护，`public.edb` 与 Quant 原始输入 migration 由 Data 维护。`authorization` schema 的历史 migration 由 Gateway 保留。当前授权不读写旧表。原 Financing migration 已迁入 Dashboard。Quant 本地只读输入，线上结果经所有方发布函数写入。相同数据库或 binding 不构成跨领域任意写入授权。

| 领域 | Schema / 对象 | Migration 所有方 | 读写边界与领域入口 |
|---|---|---|---|
| 二级池 | `bond` | [postgres-migrations](../dashboard/postgres-migrations) | Dashboard 导入与 repository。[二级池](../dashboard/docs/modules/secondary-bond-pool.md) |
| 授信 | `credit` | [credit-migrations](../dashboard/credit-migrations) | Dashboard 本地导入、报表和自动保存。[授信](../dashboard/docs/modules/credit-workbench.md) |
| 融资业务 | `financing` | [financing-migrations](../dashboard/financing-migrations) | Dashboard 融资 adapter。[融资数据](../dashboard/docs/modules/financing-data.md) |
| 融资模型 | `financing_model` | [financing-model-migrations](../dashboard/financing-model-migrations) | Quant Workflow 原子发布。Dashboard 管理人工结论和研究快照，见下一节 |
| 历史应用权限 | `authorization.permission` / `role_permission` | [authorization-migrations](../gateway/authorization-migrations) | 旧表保留回溯。运行时权限来源为 Auth0，Gateway Cache API 保存 JSON。[Gateway 开发](../gateway/docs/DEVELOPMENT.md) |
| 客户主数据 | `public.client` / `client_alias` | financing migration。credit migration 维护领域关联 | [客户与授信关联](../dashboard/docs/modules/clients.md) |
| 经济观测 | `public.edb` | [edb-migrations](../data/edb-migrations) | Data 回填 / 增量 Workflow 写入，Dashboard 研究和负债周报只读。[同步](../data/docs/modules/economic-indicator-sync.md) |
| 债券模型非债券级输入 | `public.quant_input` | [edb-migrations](../data/edb-migrations) | Data 按字段和观察日维护行情及公司输入。同日 LCR/NSFR 以资金日报覆盖工作簿。[Quant 输入](../data/docs/modules/quant-inputs.md) |
| 券商债一级/二级研究输入 | `public.bond_issuance` / `bond_history` / `bond_industry_curve` | [edb-migrations](../data/edb-migrations) | Data 将发行字段直接写入每券一行的发行表，二级历史仅存交易所债券的整数代码与观察值。Quant 只读并计算主体利差。[Quant 输入](../data/docs/modules/quant-inputs.md) |

Dashboard 业务数据与 Data 经济指标同步使用 `HYPERDRIVE`。Gateway 不再绑定 `AUTHORIZATION_DB`。应用角色权限统一保存在 Auth0，Gateway 使用 Cloudflare Cache API 缓存 JSON（1 小时）。旧 authorization 表及 migration 保留，不删表、不重放。Dashboard 的业务 RLS 与事务权限上下文保持不变。

Auth0 独占用户、角色、成员关系及角色权限。应用业务库只关联 Auth0 ID。融资负责人、经办人和周报生成人直接使用 Auth0 ID，不重建已删除的本地人员、角色或审计表。

## 融资模型跨仓库写入

- Quant 本地 CLI 生成 `issuance-forecast-v1` 票面和可加总贡献，不直接上传。当前 Huber 稳健中心不支持预期节约，相关字段为空。旧相对利差序列化/上传模块只保留历史，不是当前运行入口。
- Quant线上BondInferenceWorkflow将结果冻结在R2 `eastmoney/quant-trial/runs/{date}/{instanceId}/result.json`，核对SHA-256后调用Dashboard所有的`financing_model.publish_online_result(jsonb,text)`。当前迁移同时接受`issuance-lgb-v1`和`issuance-lgb-v2`，以一个事务写入schema v4公共运行行及`issuance_run/forecast/market_path/shap/validation`五张类型化表，原始JSON只存R2。
- 同日保留稳定ID、人工结论、决策记录和卖方快照。晚到旧结果不覆盖较新结果。历史相对利差行保留，新页面仅列新版运行，不能将旧分位转换为票面。来源版本、训练日、有效期及归档key存原生列。
- Dashboard从类型化列重建快照。人工结论只增量更新，卖方研究追加快照。Quant不写人工内容。两融没有生产写入。
- Data拥有行情与真实一级定价字段的采集/回填，Quant只读。字段、隔离及缺失规则见[Quant输入](../data/docs/modules/quant-inputs.md)。契约变化同时核对Data来源、QuantPython/JS一致性和Dashboard迁移/读取/展示，交付以真实Workflow发布与API核验完成。

## R2 与检索边界

| 存储 | 写入所有方 | 消费者与详细契约 |
|---|---|---|
| R2 `article` 的 `report/`、`policy/` | Ingest 业务 Workflow | AI Search `research` 独立索引。Quant 辅助工具只读研报。[归档协议](#研究归档协议) |
| R2 `eastmoney` | Dashboard 写业务归档及 `credit/` 公开授信材料。Quant 独占 `quant-trial/`。Data 只读资金日报并独占 `data-observations/bond-issuance/` | 市场定稿、二级池、资金日报、负债周报快照及授信问答。[Dashboard 存储](../dashboard/docs/DATABASE.md) |
| R2 `credit` | 历史授信材料保留，不再进入生产问答链路 | 公开原件迁往 `eastmoney/credit/` 后，AI Search `credit` 仅索引新目录。[授信问答](../dashboard/docs/CREDIT_ASSISTANT.md) |
| CreditAgent SQLite Durable Object | Dashboard | 历史授信助手的用户会话。不替代 Neon 授信日报或当前 AI 侧栏会话 |
| 本地 Excel / 模型产物 | Quant 或受控导入脚本 | 不提交到 Git，不把原文件或凭证迁入共享文档 |

资金日报规范化字段另存 `public.quant_input`，保留静态缺口和上一交易日余额的原标签，不覆盖资金计划表口径。原始 HTML 的归档和读取契约不变。

Data 通过 Hyperdrive 维护上述 EDB/Quant 原始输入，R2 `eastmoney` 读取 `fund-reports/`，并仅在 Data 自有 `data-observations/bond-issuance/` 归档有限发行观察。Dashboard 保留原始日报上传所有权。前瞻观察由 Data 写入。Quant 后续可按新冻结协议只读，当前模型尚不消费，不允许跨所有方覆写。

字段/不可变请求、内容、可见时间与显式恢复见[发行观察](../data/docs/modules/issuance-observations.md)。这不是旧通用来源附表或完整历史条款版本。Data 无 D1 绑定。CAMEL 的 Cache API 会话缓存不是共享数据库或全局锁，规则在 [CAMEL 模块](../data/docs/modules/camel.md)。

Choice 的 SDK 运行文件也不构成业务存储。

### 研究归档协议

- 研报对象为 `report/yyyy-mm-dd/标题.md`，政策为 `policy/yyyy-mm-dd/标题.md`，日期按上海时区计算。稳定 key 与归一化以 [article.ts](../ingest/src/article.ts)、[policy-archive.ts](../ingest/src/policy-archive.ts) 为准。
- `type` 为文本 `研报` / `政策`。`published_at` 保留原始发布时间，不用重跑或迁移时间替代。其余检索元数据由归档实现维护。
- 写入前统一复用既有中文标点补空格处理，特征抽取仍读取原正文。
- R2 归档完成不等于索引完成。Ingest 不绑定 AI Search、不上传 builtin Item、不在 Workflow 内轮询索引。AI Search 独立同步。检索参数和日期硬过滤只由 [AI Search 规范](AI.md#ai-search) 维护。
- R2 `article` 的研究库与 `eastmoney/credit/` 的公开授信材料库分开，不能套用同一检索和材料下载规则。

## 迁移与验证边界

- 新增结构变化进入所有方既有 migration。运行命令只读目标仓库 `AGENTS.md` 指向的开发文档，不在根目录复制脚本或创建统一 migration。
- 每次数据库调整须按实际执行情况汇报。列明改动的表、列、索引和数据行，以及迁移前后核对结果、空间变化、受影响的读写方。分别列出已执行与未执行的验证和发布步骤。没有运行的迁移、回填和验收不能写成已完成。先满足当前业务需求，不增加没有明确用途的审计表、来源字段、版本表或兼容层。确需新增时说明具体读写用途和成本。
- 直连凭证只通过本地未跟踪环境注入，不进入文档、源码、日志或测试夹具。
- 先检查受影响领域的约束、索引、事务回滚与读写契约，再按具体任务验证迁移/回填。默认本地开发、纯文档任务不隐含远端迁移或数据重写。
- 原融资 migration 沿用既有 ledger，不因仓库合并重建表、重放历史或复制生产数据。身份统一迁移的跨 schema 原子步骤由 Dashboard 专题维护。

## 用户通知存储扩展

Messenger 0003 新增 notification_settings、push_subscriptions、notifications、notification_schedule，仍独占 messenger D1。messages 增加 webpush 渠道且保留全部历史与关联。订阅主键为 Auth0 subject，联系邮箱可不同于登录邮箱。推送 endpoint/auth/p256dh 不进入日志或管理详情。

Dashboard 1019 新增 trading_workflow_progress，保存用户/日期隔离的 enabled、completed、branches 调度状态，使用 revision 条件写。此前“每日进度仅本地”的边界改为调度字段入库，询价行、名单和备注仍本地。Messenger 不直接读 Dashboard D1 或融资 Neon，仅调用私有 NotificationSource。
