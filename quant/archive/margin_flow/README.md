# 全市场两融余额预测

本模块预测后续第 1、5、20 个交易日的全市场两融余额变化，并用统一的年度样本外框架比较生产模型。它与债券融资择时独立，不读取公司层业务数据，也不自动生成 Markdown 报告或图表。

## 运行

```bash
# 全部生产模型
uv run --extra archived-margin python -m archive.margin

# 选择模型做快速验证
uv run --extra archived-margin python -m archive.margin --models trend_persistence main_regression lightgbm three_layer

# 指定最终测试年
uv run --extra archived-margin python -m archive.margin --test-year 2025 --initial-train-years 2

# 保存结构化结果
uv run --extra archived-margin python -m archive.margin --output-dir .Codex/tmp/margin-flow
```

可选输出包括：

- `predictions.csv`：逐样本预测。
- `metrics.csv`：按 validation/test 分开的效果指标。
- `metadata.json`：数据范围、特征、验证窗口和模型元数据。

TimesFM 首次运行需要加载模型，耗时明显高于其他模型。需要控制内存时，可通过 `--timesfm-per-core-batch-size` 调整推理批量。

## 评估口径

- 数据来自 `data/data.xlsx` 的全市场“两融”工作表及允许的公共市场特征。
- 按自然年执行 Expanding Window。当年数据单独作为最终测试集。
- 核心指标为方向正确率、MAE（亿元）和相对误差。
- 生产模型、特征集合和输出结构以代码注册表及契约为准。

当前模型定位、真实回测结果和限制见 [`REPORT.md`](REPORT.md)。历史消融见 [`archive/`](archive/)。开发规则见 [`AGENTS.md`](AGENTS.md)，全仓业务口径见 [`../../docs/DOMAIN.md`](../../docs/DOMAIN.md)。
