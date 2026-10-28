# Quant 本地量化模型

本地研究使用普通checkout。数据、模型和运行产物保留在本地忽略目录，可按研究需要更新。下文旧工作树路径只用于历史证据追溯，不要求新建worktree。已发布模型的身份与哈希仍按发布规则保存。
## Project Overview

本仓库维护本地 Python 量化训练与债券择时线上推理。当前生产选用三档概率建议，旧真实票面模型保持暂停。`online/` 独立 Workflow 只读线上输入，在 R2 `quant-trial/` 归档成功结果并发布到同一生产模型表，不提供公网 API。两融模型已封存于 `archive/`，不参与当前研究报告或默认流程。

- 运行环境：macOS Apple Silicon、Python 3.12、`uv`
- 主要技术：pandas、scikit-learn、LightGBM、SHAP、TimesFM
- 外部数据：本地 Excel、统一 data API（Choice）。研报工具只读 Cloudflare R2

## Mandatory Rules

- 修改前先搜索现有实现、类型、特征注册表和测试。不要建立平行 pipeline、重复特征或重复评估口径。
- 只修改当前任务需要的文件，保留已有改动。不得用删除测试、关闭检查或忽略错误的方式让任务通过。
- 本地训练与线上推理分离。`online/` Worker 不设置公网路由，只读输入表、读写 R2 `quant-trial/`。成功归档通过 Dashboard migration 所有的 `financing_model.publish_online_result` 原子发布到生产模型表，保留同日稳定 ID 和人工内容。Quant 不直接改 schema、不写人工结论或卖方观点。旧本地上传不再由当前CLI调用，不得覆盖新模型结果。
- 当前上线采用 `timing-advice-v1` 独立三档契约；旧 `issuance-coupon` / `issuance-forecast-v1` 保留历史兼容并继续暂停。不兼容读取旧模型结果，不重算旧成绩。上线状态与证据见[运行与研究状态](PLAN.md)。必须通过 Python/JS 特征、预测、贡献及结构化结果一致性后才能激活模型。模型/真实输入/验收证据只在忽略目录或受控 R2 中，禁止提交 Git。部署与命令见 `docs/ONLINE_INFERENCE.md`。
- `README.md` 是面向人类汇报的唯一最终研究报告，只介绍最终线上模型。报告从头完整说明业务问题、数据、方法、训练验证、结果及局限。模型暂停时如实说明状态。禁止写入每轮改进介绍、任务进度、工作流水账或候选模型试验记录。
- 每轮研究的代码和记录按独立目录组织，默认使用 `.Codex/research/<iteration-id>/`。目录内分别保存 `code/` 和 `records/`，关联输入、结果及证据位置。禁止改写历史日期、分母、失败结果和来源。运行中的冻结文件保持原路径和内容。
- 离线迭代不要求向 `README.md` 追加内容。最终线上模型、数据口径或上线状态变化时，按[研究报告规范](docs/RESEARCH_REPORT.md)同步完整报告。审阅后的安全聚合证据可提交；原始证据不可提交。
- Excel 是本地数据事实，文件被 `.gitignore` 排除。不得提交数据文件、模型产物、凭证或 `.env`。
- 所有时序特征、标签和验证切分必须避免未来信息。债券市场特征按发行日 T-1 对齐。两融标签终点不得跨入评估窗口。
- 共享特征统一通过 `data/feature_engineering.py` 的注册表和 `build_feature_bundle()` 构建。不要直接复制 `FeatureEngineer` 内部逻辑。
- `main.py` 保持薄 CLI。应用编排放在 `application/`，数据/模型层不得反向依赖应用层。根 `margin.py` 仅提示归档入口。
- 保留 `backtest.py`、`model/ood.py` 和 `query_weekly_research.py`。两融已整体封存到 `archive/margin_flow/` 和 `archive/margin.py`，未经用户明确解除封存不修改模型、重训或恢复到默认流程。清理接口前先用 `rg` 证明没有仓库内调用，并核对文档中的业务入口。
- data API 的 Choice 更新会消耗外部额度。默认主流程只读Neon。显式定价元数据补取才调用Choice。
- 任何 Choice 取数均须先按[共享额度与取数计划](../docs/CHOICE.md)核实余额、计量单位并制定共享预算。试探、补数、重试和子代理任务也不例外。公司任务不得自动扩大为全市场。
- `query_weekly_research.py` 只读 R2 `article` 桶。任何日志、测试和文档都不得显示凭证值。
- 卖方观点由 dashboard 通过 AI Search 生成。债券 pipeline 不得调用 `query_weekly_research.py`、R2 或 AI Search 拼接卖方观点。
- Neon 写入只使用参数化 SQL 和 `DATABASE_URL`。连接串不得进入源码、日志、测试夹具或提交。

## Commands

```bash
# 债券票面主流程与线上训练导出
uv run python main.py
uv run python main.py --no-upload

# 本周研报
uv run python query_weekly_research.py --json

# 默认验证
uv run python -m unittest discover -s tests -v
uv run python -m compileall -q main.py pipeline.py issue_timing.py issue_report.py backtest.py margin.py query_weekly_research.py application model data choice archive reports research_sources.py tests
uv run ruff check .
uv run ruff check . --select C901,PLR0912,PLR0915
uv run python scripts/check_repository_data_safety.py
python3 scripts/build_report.py --check
uv lock --check
git diff --check
```

涉及债券完整流程时，再运行 `uv run python main.py`。两融封存说明与显式复现见 [archive](archive/README.md)，本次不要求 TimesFM 完整回归。

## Context Routing

跨项目执行与工作树规则见 [项目组 AGENTS](../AGENTS.md)，未在上下文中时读取一次。按下列任务入口选读。两融代码任务还需读取其局部 `AGENTS.md`。

- 债券 CLI、pipeline、特征与训练：按任务读取 [ARCHITECTURE](docs/ARCHITECTURE.md)、[DOMAIN](docs/DOMAIN.md)。票面回放、优化及利率研究分别读 [ISSUANCE_BACKTEST](docs/ISSUANCE_BACKTEST.md)、[PLAN](PLAN.md)、[RATE_RESEARCH](docs/RATE_RESEARCH.md)。
- 债券训练导出与独立 JS 推理 Workflow：[ONLINE_INFERENCE](docs/ONLINE_INFERENCE.md)。结构化结果/Neon 写入加读[共享模型写入契约](../docs/DATABASE.md#融资模型跨仓库写入)与 [Dashboard 融资模型](../dashboard/docs/modules/financing-model.md)。
- 当前研究报告：[README.md](README.md) 与 [维护/构建](docs/RESEARCH_REPORT.md)。
- Data 发行观察的独立只读接入：[观察时间切片](docs/ISSUANCE_OBSERVATIONS.md)。当前未接入模型或生产 Workflow。
- 事前方案、预测登记及请求覆盖审计：[离线研究台账](docs/PROSPECTIVE_REGISTRY.md)。本地时间未锚定，不计真实前向成绩。
- 两融封存：只在用户要求历史复现或解除封存时读 [archive](archive/README.md)，再读其中局部规则。
- Choice API、R2 研报辅助、环境、数据、凭据、验证与 Git：[DEVELOPMENT](docs/DEVELOPMENT.md)。实际 Choice 取数加读[共享额度计划](../docs/CHOICE.md)。完整融资择时报告使用[报告 skill](skills/bond-financing-timing-report/SKILL.md)。

只加载当前任务相关文档，跨模块仅加读受影响部分，不重复读取已有上下文。跨服务变化才读 [共享架构](../docs/ARCHITECTURE.md)，Neon 输出或 R2 契约变化才读 [共享数据库](../docs/DATABASE.md)。Quant pipeline 没有线上生成式 AI 调用，不因模型任务自动加载 Gateway 规范。

本项目有随私有 Worker 构建的静态研究报告，没有公网 API。业务数据库 migration 由 Dashboard 维护，因此不另建 DESIGN、API 或 DATABASE。环境与凭据规则在 [DEVELOPMENT](docs/DEVELOPMENT.md)，独立线上试运行见 [ONLINE_INFERENCE](docs/ONLINE_INFERENCE.md)。

## 权限测试

共享认证架构、各权限范围及测试账号配置见 [项目组 AUTH](../docs/AUTH.md)。权限登录与验收只使用程序化 HTTP、单元测试与 CLI，禁止 browser、Chrome、Playwright 和浏览器 MCP。新增测试仅使用匿名和 `test@18.cn` 两种身份。真实密码只读根目录 `.env`，不进入测试夹具或日志。

## 测试规范

测试新增、合并、覆盖率与视觉回归按 [TESTING](docs/TESTING.md) 执行。不要通过源码样式或控件数量锁定代替行为验证。
