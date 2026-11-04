# Quant 本地量化模型

## Project Overview

本项目维护本地 Python 量化训练和债券融资择时的独立线上推理。线上选用三档建议 `timing-advice-v1`，模型包 `778e5cd2116288b99576`。旧票面模型暂停。两融模型封存于 `archive/`，不参与当前研究报告和默认流程。

`online/` 是独立 Workflow：只读线上输入，在 R2 `quant-trial/` 归档成功结果，再发布到生产模型表。它没有公网 API。

研究目标已暂停，不继续候选搜索、调参或新实验。票面冻结研究已停止，完整结果与失败按原样保留，不在原冻结目录追加候选、调参、重试或训练。运行状态与待办见 [ONLINE_INFERENCE](docs/ONLINE_INFERENCE.md)。

- 运行环境：macOS Apple Silicon、Python 3.12、`uv`
- 主要技术：pandas、scikit-learn、LightGBM、SHAP、TimesFM（仅封存两融）
- 外部数据：本地 Excel、Neon 只读、统一 data API（Choice）。研报工具只读 Cloudflare R2

## Mandatory Rules

- 修改前先搜索现有实现、类型、特征注册表和测试，不建平行 pipeline、重复特征或重复评估口径。
- 共享特征只经 `data/feature_engineering.py` 的注册表和 `build_feature_bundle()` 构建，不复制 `FeatureEngineer` 内部逻辑。
- 特征、标签和验证切分不得含未来信息。债券市场特征按发行日 T-1 对齐。
- 本地训练与线上推理分离。Workflow 经 Dashboard migration 所有的 `financing_model.publish_online_result` 原子发布，同日保持稳定 ID 和人工内容。Quant 不改 schema，不写人工结论或卖方观点。`neon_upload.py` 已退役，本地不上传。
- 线上采用 `timing-advice-v1` 独立三档契约。旧 `issuance-coupon` / `issuance-forecast-v1` 暂停，历史结果仍可读；更早的相对利差结果不兼容，不重算。状态与证据见 [ONLINE_INFERENCE](docs/ONLINE_INFERENCE.md#当前三档发行建议)。
- 激活模型前，Python 与 JS 的特征、预测、贡献和结构化结果必须一致。模型、真实输入和验收证据只放忽略目录或受控 R2。
- `README.md` 是唯一的最终研究报告，维护规则见 [RESEARCH_REPORT](docs/RESEARCH_REPORT.md)。离线迭代不要求追加报告内容。
- 每轮研究的代码和记录放在 `.Codex/research/<iteration-id>/` 的 `code/` 与 `records/`，并关联输入、结果和证据位置。不改写历史日期、分母、失败结果和来源。运行中的冻结文件保持原路径和内容。
- `main.py` 保持薄 CLI，编排放 `application/`。数据层和模型层不依赖应用层。根 `margin.py` 只提示归档入口。
- 保留 `backtest.py`、`model/ood.py` 和 `query_weekly_research.py`。两融封存于 `archive/`，用户未明确解除封存前不修改、不重训、不恢复到默认流程。清理接口前先用 `rg` 确认仓库内无调用，并核对文档入口。
- 默认主流程只读 Neon。仅显式定价元数据补取（`--primary-research --refresh-pricing-metadata`）调用 Choice 并消耗额度。任何 Choice 取数先按[共享额度与取数计划](../docs/CHOICE.md)执行，试探、补数、重试和子代理任务也一样。公司任务不扩大为全市场。
- 卖方观点由 Dashboard 通过 AI Search 生成。债券 pipeline 不调用 `query_weekly_research.py`、R2 或 AI Search。该工具只读 R2 `article` 桶。
- 凭证不进入源码、日志、测试夹具或提交。Neon 只用参数化 SQL 和 `DATABASE_URL`。

## Commands

```bash
uv run python main.py                 # 债券票面主流程（受模型资格检查）
uv run python query_weekly_research.py --json   # 本周研报
uv run python -m unittest discover -s tests -v
```

完整验证清单见 [DEVELOPMENT](docs/DEVELOPMENT.md#validation)，CI 见 [TESTING](docs/TESTING.md)。两融封存说明与显式复现见 [archive](archive/README.md)。

## Context Routing

只加载当前任务相关文档，跨模块仅加读受影响部分。

- 债券 CLI、pipeline、特征与训练：[ARCHITECTURE](docs/ARCHITECTURE.md)、[DOMAIN](docs/DOMAIN.md)。票面回测与利率研究：[ISSUANCE_BACKTEST](docs/ISSUANCE_BACKTEST.md)、[RATE_RESEARCH](docs/RATE_RESEARCH.md)。
- 训练导出与独立 JS 推理 Workflow：[ONLINE_INFERENCE](docs/ONLINE_INFERENCE.md)。结构化结果写入加读[共享模型写入契约](../docs/DATABASE.md#融资模型跨仓库写入)和 [Dashboard 融资模型](../dashboard/docs/modules/financing-model.md)。
- 行业曲线短期延续预测与信号：[TIMING_NOWCAST](docs/TIMING_NOWCAST.md)。
- 研究报告：[README.md](README.md) 与 [RESEARCH_REPORT](docs/RESEARCH_REPORT.md)。完整融资择时报告用[报告 skill](skills/bond-financing-timing-report/SKILL.md)。
- Data 发行观察的只读接入：[ISSUANCE_OBSERVATIONS](docs/ISSUANCE_OBSERVATIONS.md)。事前方案与预测登记：[PROSPECTIVE_REGISTRY](docs/PROSPECTIVE_REGISTRY.md)。两者均未接入生产。
- 环境、凭据、Choice API、R2 研报与 Git：[DEVELOPMENT](docs/DEVELOPMENT.md)。
- 两融：仅在用户要求历史复现或解除封存时读 [archive](archive/README.md) 及其局部规则。
- 跨服务变化读[共享架构](../docs/ARCHITECTURE.md)。Neon 输出或 R2 契约变化读[共享数据库](../docs/DATABASE.md)。

Quant 没有公网 API，也没有线上生成式 AI 调用。业务数据库 migration 由 Dashboard 维护，因此不设 DESIGN、API 或 DATABASE 文档。

## 权限与测试

权限验收规则见[项目组 AUTH](../docs/AUTH.md#程序化权限测试)，测试规范见 [TESTING](docs/TESTING.md)。
