# 封存研究

两融模型于2026-10-03按用户要求封存，当前开发入口和 REPORT.html 不包含两融。代码、实验及历史文字报告保留，数据和权重仍在原本地忽略位置。没有在封存过程中重训或刷新成绩。

```bash
# 仅显式复现历史；在仓库根目录运行
uv run --extra archived-margin python -m archive.margin --help
uv run --extra archived-margin python -m archive.margin --models trend_persistence main_regression --test-year 2026
```

归档来源文件的封存前哈希见 [margin-source.json](margin-source.json)。根目录 `margin.py` 仅提示归档入口，不会自动训练。默认安装不包含 TimesFM、Torch、JAX。相关冻结版本仍在同一锁文件的 `archived-margin` 可选组中。普通行为测试继续覆盖归档契约，TimesFM 单测使用模拟对象，不加载权重。

复现会读取根目录 `data/data.xlsx`，请提供原研究快照。当前文件不能冒称2026-07-30快照。历史方法、结果及局限见 [归档 README](margin_flow/README.md)、[历史报告](margin_flow/REPORT.md)。恢复开发或重新训练需用户明确解除封存，并登记新的研究版本。
