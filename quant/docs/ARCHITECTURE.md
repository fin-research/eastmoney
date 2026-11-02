# Architecture

Quant 由本地 Python 研究与训练，加独立私有推理 Workflow（`online/`）组成。线上主线是三档建议 `timing-advice-v1`。票面模型暂停，两融封存于 `archive/`。跨项目调用见[共享架构](../../docs/ARCHITECTURE.md)，模块阅读入口见 [AGENTS](../AGENTS.md#context-routing)。

## 线上三档建议

```text
Data 同步 → Neon public.edb（资金利率）、public.bond_industry_curve（AAA 证券公司债 3Y）
  → Workflow 读取此前 90 日快照 → 冻结到 R2 quant-trial/runs/
  → online/timing-advice.mjs 推理 → R2 结果
  → financing_model.publish_online_result → Dashboard 页面、业务指标、人工记录与卖方观点
```

Python 实现是 `model/timing_advice.py`，JS 实现是 `online/timing-advice.mjs`，两端须逐特征、逐概率一致（`online/verify-timing.mjs`）。`scripts/adopt_timing_model.py` 从指定研究目录按固定算法一次拟合并导出模型包。运行与发布见 [ONLINE_INFERENCE](ONLINE_INFERENCE.md)。

## 票面研究管线（暂停）

```text
Data 同步 → Neon edb + quant_input → data/online_inputs.py → 共享特征
  → issuance_training（真实票面事件 × 已知起点，事件等权）
  → short_coupon / issuance_unified（所有发行人、期限、提前期共用一个模型）
  → issuance_output（T+1/T+14/T+30 票面与可加贡献，无人工规则）
  → issuance_export → Python/JS 一致性 → R2 不可变包 → Workflow 发布
```

`main.py` 是唯一的薄 CLI。`application/arguments.py` 定义参数，`application/cli.py` 校验互斥并分派到按职责划分的应用，模型与数据适配器不依赖应用层。根 `pipeline.py`、`online_pipeline.py` 只保留历史导入边界。默认票面流程与 `--online train/infer` 用同一算法，生产发布由 Workflow 完成。

模型包和校准包版本不可变，行情与一级资料每日读取。更新通过重新导出、核验和激活完成。共享特征的唯一实现是注册表，JS 镜像必须通过真实历史对照。回测协议见 [ISSUANCE_BACKTEST](ISSUANCE_BACKTEST.md)。

`research_sources.py` 登记全部 Python 应用、模型、数据与客户端、脚本、JS 镜像和依赖锁，作为研究源码身份。任何新增、删除或修改都改变身份，旧研究不补写新哈希。结构迁移后在新目录登记原来源并完整复现，不用适配器白名单接受训练语义漂移。

## 研究接入

- 发行观察：`online/observation-contract.mjs`、`observation-store.mjs`、`observation-slice.mjs` 分别维护协议、有限只读存储和时点选择，依赖方向为切片指向协议与存储。未接入训练面板或生产 Workflow。见 [ISSUANCE_OBSERVATIONS](ISSUANCE_OBSERVATIONS.md)。
- 离线登记：应用层编排纯协议和不可覆盖的本地台账，Node 入口复用统一推理函数，原 bundle 只读。未锚定的本地时刻不构成前向证据。见 [PROSPECTIVE_REGISTRY](PROSPECTIVE_REGISTRY.md)。

## 所有权

Data 拥有原始定价字段的采集与回填。Dashboard 拥有结构化结果表和 migration。字段与人工内容保护见[共享数据库](../../docs/DATABASE.md#融资模型跨仓库写入)。

## 产物与报告

`artifacts.py` 提供确定性 JSON 和模型树导出，不依赖数据、评分或历史报告。`model` 与 `data` 包只在请求公共属性时加载具体模块，现行模块导入不隐式加载历史回测所用的评分、训练和 OOD。

`README.md` 是唯一的完整研究报告。`reports/` 保存安全聚合证据和源码审阅，检查程序核对证据、源码与正文，不生成第二份报告。`online/build-report.mjs` 只把 README 复制到静态目录。维护规则见 [RESEARCH_REPORT](RESEARCH_REPORT.md)。

## 封存研究

两融整体移至 `archive/`，依赖为显式的 `archived-margin` 可选组。历史复现使用独立模块入口，见 [archive](../archive/README.md)。封存两融仍复用 `data/feature_engineering.py` 的公共特征组，但只能选全市场与日历组。

## 共享边界

- 债券模型使用给定发行方案与真实一级历史，不用公司业务变量，两融不用发行人专有数据。
- `query_weekly_research.py` 是只读辅助工具，只从 R2 拉取研报，不参与训练、结构化快照或卖方观点生成。
- `online/` 无公网 API，另有只供命名绑定调用的静态报告入口。它只读 Neon 输入，在 R2 `quant-trial/` 归档，以结构化契约发布。
