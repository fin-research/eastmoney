---
name: bond-financing-timing-report
description: 基于当前三档择时模型 timing-advice-v1 及冻结证据，维护 Quant 研究报告或核对当期发行建议。
---

# 债券融资择时报告

在 Quant 项目执行。现行模型契约、状态和口径分别读 [ONLINE_INFERENCE](../../docs/ONLINE_INFERENCE.md) 和 [DOMAIN](../../docs/DOMAIN.md)。

## 研究报告

唯一的研究报告是项目根 `README.md`，维护与检查按 [RESEARCH_REPORT](../../docs/RESEARCH_REPORT.md)。模型、训练、特征、数据、评价或推理变化时，更新并检查报告。两融已封存，不在报告内。保留研究问题、方法、数据可用时点、分母与切分、基准与失败结果、局限。

优先使用任务指定的冻结评价和最近已验证的产物，不为重写报告自动训练或调用收费上游。只把审阅后的聚合证据写入报告源，原始输入、逐笔预测和模型留在忽略目录。工程维护不把旧数据日期改成今天，也不称新前向成绩。

## 当期发行建议

每个交易日由线上 Workflow 生成并写入 Dashboard。本地复核时，对固定包运行 `scripts/run_timing_advice.py`（只读 Neon，不训练），再用 `online/verify-timing.mjs` 核对 Python/JS，命令见 [ONLINE_INFERENCE](../../docs/ONLINE_INFERENCE.md#当前三档发行建议)。

建议取概率最大的类别，不含票面、节约或发行日期。引用时同时给出三档概率、市场日期，并注明状态是“开发检验、探索性选用”。

卖方观点只在用户明确要求时使用独立的 `query_weekly_research.py`，模型 pipeline 不调用研究库。区分环境判断、模型预测和实际验证，保留分歧，不补造支持性观点。线上状态以真实 Workflow 发布及 API 回读为准。
