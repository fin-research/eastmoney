# 全市场两融余额预测

本目录是2026-10-03封存的全市场两融研究，只供用户明确要求的历史复现。未经用户解除封存，不新增模型、训练或恢复默认入口。根目录 [`AGENTS.md`](../../AGENTS.md) 的数据安全、Git 和全仓验证规则继续生效。

## Scope

- 唯一业务入口是 `uv run --extra archived-margin python -m archive.margin`。`margin.py` 只解析参数，实现在本目录。
- 只预测全市场两融余额，不读取或评价公司层业务数据，不调用 Choice 更新。
- 期限固定为后续第 1、5、20 个交易日。金额和余额单位为亿元。
- Pipeline 只输出控制台结果或可选 CSV/JSON，不自动生成 Markdown 报告和图表。

## Structure

```text
contracts.py      ModelInput、ModelOutput、PipelineConfig、PipelineResult
market_data.py    数据读取、字段校验、特征与标签
data.py           标准数据入口和年度 Expanding Window
models.py         生产模型注册表与统一预测接口
evaluate.py       统一评估指标
pipeline.py       data -> model -> evaluation 编排
timesfm_engine.py TimesFM 同进程推理
*_experiment.py   使用同一验证口径的实验挑战者
REPORT.md         封存前历史模型结论与限制
archive/          已结束实验的研究记录
```

## Mandatory Rules

- `MODEL_REGISTRY`、生产特征常量和 `FEATURE_TAXONOMY` 是当前实现事实来源。不要在文档复制易变化的模型数或特征数。
- 所有生产模型接收统一 `ModelInput`，返回同结构 `ModelOutput`，并按相同年度切分和指标比较。不得为单一模型另设口径。
- 当年数据只作为最终测试集，不参与模型、特征、参数或权重选择。训练标签终点必须严格早于评估窗口起点。
- 两融只使用允许的全市场与日历特征组，不得引入债券一级、债券二级或公司专有特征。
- TimesFM 在当前 Python 进程内加载并复用，不使用 subprocess。进度输出必须及时 `flush`。
- 新外部模型先作为实验挑战者。只有在历史验证形成稳定、实质增益并经用户确认后，才能进入生产注册表。
- `REPORT.md` 与 `archive/` 中的历史结论保持原研究日期，不再维护当前模型结论。当前债券 REPORT.html 不包含两融。

## Validation

```bash
uv run python -m unittest tests.test_margin_flow -v
uv run python -m compileall -q archive/margin.py archive/margin_flow tests/test_margin_flow.py
uv run ruff check archive/margin.py archive/margin_flow tests/test_margin_flow.py
uv run ruff check archive/margin.py archive/margin_flow tests/test_margin_flow.py --select C901,PLR0912,PLR0915
git diff --check
```

归档迁移只做轻量行为回归，不要求加载 TimesFM。解除封存后再按实际风险重训。历史业务口径见 [DOMAIN.md](DOMAIN.md)，使用方式见 [`README.md`](README.md)，当前模型结论见 [`REPORT.md`](REPORT.md)。
