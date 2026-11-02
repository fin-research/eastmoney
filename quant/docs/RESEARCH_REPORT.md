# 研究报告维护

`README.md` 是面向人类汇报的唯一最终研究报告，只介绍最终线上模型。它从头说明业务问题、数据、方法、训练验证、结果和局限。模型暂停时如实写明状态。两融封存，不在报告内。

- 不追加每轮改进介绍、工作流水账、任务进度或候选模型试验记录。离线迭代不触发报告扩写。
- 最终线上模型、数据口径或上线状态变化时，同步整份报告。
- 报告结果须有完整冻结证据支持。已观察的历史不称独立前向验证。
- 每轮研究的目录规则见 [AGENTS](../AGENTS.md)。

## 证据与检查

- `reports/research.json`、`reports/short-coupon.json`、`reports/timing-advice.json`：审阅后的安全聚合指标和来源哈希。
- 原始输入、逐笔预测、模型和 receipt 留在忽略目录或受控 R2，不提交。
- `reports/review.json`：记录当前实现审阅、证据哈希和 README 指纹。
- `reports/build.py` 检查聚合证据、源码闭包与 README 哈希，不生成报告，不改写研究结果。

```bash
python3 scripts/build_report.py --check
python3 scripts/build_report.py --review-note '说明模型、数据、研究结果及限制的核对内容'
```

源码闭包（见 [ARCHITECTURE](ARCHITECTURE.md)）或 README 变化后，`--check` 会失败；核对报告后用 `--review-note` 更新审阅记录。审阅记录不能代替真实评价。

## 发布

`online/build-report.mjs` 把 README 复制到静态目录。Worker `quant` 的命名入口 `ResearchReport` 对 `/README.md` 和兼容路径 `/REPORT.html` 返回同一份 Markdown，其他路径和方法拒绝。Gateway `/financing-model/research` 按 `model.financing:read` 授权 GET/HEAD。Quant 无公网路由。

报告发布与模型激活相互独立。部署步骤见 [ONLINE_INFERENCE](ONLINE_INFERENCE.md)。
