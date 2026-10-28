# 研究报告维护

`README.md` 是面向人类汇报的唯一最终研究报告。报告只介绍最终线上模型，并从头完整说明业务问题、数据、方法、训练验证、结果及局限。模型暂停时如实说明状态。两融继续封存。

禁止向报告追加每轮改进介绍、工作流水账、任务进度或候选模型试验记录。离线迭代不触发报告扩写。最终线上模型、数据口径或上线状态变化时，同步完整报告。

每轮研究使用 `.Codex/research/<iteration-id>/` 独立目录。代码放在 `code/`，方案、日志、结果和审阅记录放在 `records/`。目录内关联原始输入、模型及证据位置。运行中的冻结文件保持原路径和内容，可在研究目录登记其位置。

历史研究记录保留原日期、分母、失败结果及来源。不能改写旧成绩或将已观察历史称为独立前向验证。报告结果须有完整冻结证据支持。

- `reports/research.json` 保留旧研究安全聚合证据。
- 新研究只提交经审阅的聚合指标与来源哈希。
- 原始输入、逐笔预测、模型及receipt留在忽略目录或受控R2。
- `reports/build.py` 检查聚合证据、源码闭包及README哈希。
- `reports/review.json` 记录当前实现审阅与README指纹。

检查程序不生成报告，也不改写研究结果。更新审阅不能替代真实评价。

```bash
python3 scripts/build_report.py --review-note '说明模型、数据、研究结果及限制的核对内容'
python3 scripts/build_report.py --check
node /Users/yueshi/.codex/plugins/cache/created-by-me-remote/doc/1.0.1/skills/asd-ste100/scripts/ste.mjs check README.md --json
```

`online/build-report.mjs` 只复制README到静态目录。旧HTML文件及其渲染器已移除。私有报告入口同时接受`/README.md`与历史路径`/REPORT.html`，均返回同一份Markdown。历史路径仅保留调用契约，不保存第二份报告。

Quant不开放公网路由。Gateway继续执行现有报告读取权限。报告发布与模型激活独立；模型须通过真实Python/JS一致性及发布验收。
