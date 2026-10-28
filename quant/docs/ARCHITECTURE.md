# Architecture

quant 以本地 Python 训练为基础，运行独立的债券JS推理Workflow。当前主线为债券模型。两融已整体封存。跨项目调用见 [共享架构](../../docs/ARCHITECTURE.md)，模块阅读按 [AGENTS](../AGENTS.md#context-routing) 选择。

## 债券融资择时

```text
Data daily sync / historical backfill → Neon edb + quant_input
  → data/online_inputs.py → shared funding/rate_dynamics/calendar features
  → issuance_training: real coupon events × known origins / equal event weight
  → short_coupon: static/history regressions and original Huber control / monthly checkpoints
  → issuance_unified: one selected model for all issuers, terms and horizons
  → issuance_output: T+1/T+14/T+30 coupons / no manual action rules / additive contributions
  → issuance_export → Python/JS parity → immutable R2 bundle
  → BondInferenceWorkflow → live inputs / issuance.mjs
  → immutable R2 result → financing_model.publish_online_result
  → existing Dashboard report, business metrics, schemes, sell-side and manual records
```

`main.py` 是唯一薄CLI。`application/arguments.py` 定义参数，`application/cli.py` 验证互斥并分派到按职责划分的应用。输入固定、预测导出、回测及曲线/一级研究分别编排，模型与数据适配器不依赖应用层。根 `pipeline.py`、`online_pipeline.py` 只保留原导入边界。默认票面流程与 `--online train/infer` 使用同一算法。生产发布仍由Workflow完成。

模型和校准包版本不可变，行情与一级资料每日读取。训练与校准更新通过重新导出、核验和激活完成。Python/JS必须逐特征、预测、TreeSHAP和完整业务字段一致。单次一致不证明冻结模型在整个有效期内最优。共享特征唯一实现仍是注册表，JS镜像必须通过真实历史对照。

`research_sources.py` 保守登记全部当前 Python 应用、模型、数据/客户端、脚本、包初始化、JS镜像及依赖锁。新增、删除和修改文件均改变研究身份，同时固定 Python 与计算库实际版本。旧研究不补写新哈希。结构迁移后必须在新目录登记原来源并完整复现，不能用适配器白名单接受训练语义漂移。

独立发行观察读取由 `online/observation-contract.mjs`、`observation-store.mjs` 和 `observation-slice.mjs` 分别维护协议、有限只读存储和时点选择。依赖方向为切片 → 协议/存储。当前未接入训练面板或生产Workflow，不能把工程观察当作已验证标签。接口与证据边界见 [观察时间切片](ISSUANCE_OBSERVATIONS.md)。

独立离线研究登记由应用层编排纯协议和不可覆盖本地台账。Node入口直接复用统一推理函数，原bundle仅只读。方案版本、预期请求、执行结果和合成标签独立保存，未锚定的本地时刻不能形成前向证据。职责、CLI与固定规则见[离线台账](PROSPECTIVE_REGISTRY.md)。

Data拥有原始定价字段采集与回填。Dashboard拥有结构化结果表及migration。字段与人工内容保护见 [共享数据库](../../docs/DATABASE.md#融资模型跨仓库写入)。

`main.py --issuance-backtest` 复用统一真实票面面板，对所有发行条件共同训练。按提前期报告真实票面误差。既有模型仅作共样本基准。没有真实发行的日期不生成评价标签。完整协议和资源限制见 [优化路线图](../PLAN.md) 与 [回测](ISSUANCE_BACKTEST.md)。

## 产物与报告

`artifacts.py` 统一确定性 JSON 和模型树导出，不依赖数据、评分或历史报告。`model/export.py` 保留受冻结源码引用的薄导入边界。`model` / `data` 包只在请求公共属性时加载具体模块。历史回测继续显式使用原评分、训练和 OOD。现行模块导入不再隐式加载它们。

`README.md` 是唯一完整研究报告。`reports/` 保留安全聚合证据及源码审阅。检查程序核对证据、源码与正文，不生成第二份报告。

`online/` 构建只复制该单一文件到静态目录。私有报告入口与模型 Workflow 分离。报告所有权和维护契约见 [RESEARCH_REPORT](RESEARCH_REPORT.md)。

## 封存研究

两融整体移至 `archive/`，依赖为显式 `archived-margin` 可选组。历史复现使用独立模块入口，不进入默认业务流程或当前 README.md。模型、实验、原始结论与封存前源码指纹保留，见 [归档](../archive/README.md)。

## 共享边界

- 封存两融仍复用 `data/feature_engineering.py` 中的公共特征组，但两融只能选择允许的全市场与日历组。
- 债券模型使用给定发行方案与真实一级历史，不使用公司业务变量。两融禁止依赖发行人专有数据。
- `query_weekly_research.py` 是保留的只读辅助工具，只从 R2 拉取研报，不参与模型训练、结构化快照或卖方观点生成。
- `online/` Workflow无公网API，另有仅供命名绑定调用的静态报告入口。只读Neon输入，在R2 `quant-trial/` 归档，以新结构化契约发布。见 [ONLINE_INFERENCE](ONLINE_INFERENCE.md)。
