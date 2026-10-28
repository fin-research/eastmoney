# 离线事前登记与审计台账

本地研究使用普通checkout。数据、模型和运行产物保留在本地忽略目录，可按研究需要更新。下文旧工作树路径只用于历史证据追溯，不要求新建worktree。已发布模型的身份与哈希仍按发布规则保存。
这是后续前向研究的本地工程入口，当前不接入生产 Workflow、真实标签训练面板或模型发布。所有记录均为 `local_unanchored`。排他创建、fsync、回读和哈希链仅验证本地内容一致，不能独立证明登记早于定价。它们也不能证明链末尾从未被整段删除。实际业务调度分母和外部可信持久化时间锚仍待验收。真实前向事件数固定为0。

## 职责与固定规则

- `model/prospective_protocol.py`：新研究的纯契约。明确上海时区、自然日h30、对照方法、月初重训/月末到期、匹配、方案变化、分母和去重规则。不重解释旧历史成绩。
- `data/prospective_ledger.py`：本地内容对象及顺序事件。原字节按SHA保存，临时文件完全落盘后排他链接，目录fsync。同幂等键异内容拒绝。全局文件锁保护事件提交，审计检查内容、前序摘要、序号和断链，保留中断遗留对象。
- `application/prospective.py`：先登记预期请求集合，再保存尝试及双方成功/失败。每请求单独执行锁。已有结果直接返回，残留attempt终止为`interrupted_unknown`，不自动重推。方案改版追加父版本，取消与合成标签单独追加。
- `online/prospective-infer.mjs`：直接复用现有`infer/validateModel`，仅通过内存和stdout返回结果，不调用覆写bundle结果的旧CLI。独立本地传输上限128MiB，容纳既有约71MB冻结输入，不改变R2观察切片预算。
- `scripts/prospective_registry.py`：唯一登记CLI，只接受当前checkout忽略的`outputs/`下目录，不联网取数、不写数据库、不切模型指针。

协议在初始化时绑定完整科学来源和实际运行环境。源码或运行环境改变时拒绝继续追加或作研究审计，须另登记研究。底层内容完整性仍可独立检查。候选方法显式提供，与每次实际模型文件的candidate一致。对照固定原5年行业残差Huber方法。每月包的训练截止必须为当月首日、有效期至该月末，不能永久沿用旧包。

方案条件全部显式提供，不继承“公募”等预测默认值。来源文件原字节随版本保存，但来源文件或用户填入的日期本身不构成可信时间证明。已知身份只接受`code + original_issue_date`，未知代码保持`unresolved_identity`，不作事后模糊主体匹配。改变条件的原登记继续保留并单列复核，不静默映射新方案。

预期batch在推理前固定每个请求的方案、控制/候选manifest、原输入和共享日历SHA。两方使用相同方案、输入、origin和日历，模型原字节也校验并归档。保留模型/日历/结果、实际执行起止与提交时刻。缺文件、身份不符、单方失败、过期模型及未知日历均保留请求。批次文件只能证明“登记批次内”的分母，不能冒充完整独立业务调度清单。

新协议h30定义为真实定价日减实际执行上海日期等于30个自然日。执行起止或结果提交跨日、声明origin与实际执行日期不符时标为回放/迟到。方案和batch可以提前登记，不能晚于执行后回填。按明确事件与origin、结果提交序号先锁定第一对成功预测，再检查未来标签、方案状态及精确定价日预测点。

第一对不可评分时不提升后续预测。标签已先登记则为已知标签回放。同刻/更正冲突保留歧义，不按误差挑选。缺少精确定价日预测点不插值、不换邻近日期。

首版仅接受显式`synthetic-label`来验收审计状态，不接受真实标签，不计算真实前向MAE或融资收益。合成可评分点、独立事件和真实前向资格分开。`eligible_forward_events`始终为0。未来可信时间锚、完整方案来源、成熟标签及独立配对评价须另行实现和冻结。

## 使用顺序

所有JSON和源文件放在忽略目录，字段契约以纯校验模块为准。每次初始化使用新台账目录，不覆盖旧研究。

```bash
uv run python scripts/prospective_registry.py --ledger outputs/registry/STUDY init --study-id STUDY --candidate-method outputs/candidate-method.json
uv run python scripts/prospective_registry.py --ledger outputs/registry/STUDY scheme --document outputs/scheme-v1.json --source outputs/scheme-source.json
uv run python scripts/prospective_registry.py --ledger outputs/registry/STUDY batch --document outputs/expected-batch.json
uv run python scripts/prospective_registry.py --ledger outputs/registry/STUDY predict --batch-id BATCH --request-id REQUEST --control-bundle outputs/control --candidate-bundle outputs/candidate --inputs outputs/inputs.json
uv run python scripts/prospective_registry.py --ledger outputs/registry/STUDY audit
```

预测失败返回退出码1，事件和分母仍可审计。修改方案时`version`递增且`parent_sha256`必须为当前方案版本摘要。取消用`cancel --scheme-sha256 SHA`。合成标签用`synthetic-label --document outputs/synthetic-label.json`。恢复中断只能审计并结束原请求。新的执行须独立登记新请求，不隐去原失败或未知执行。

## 工程验收及来源

20项Python行为测试覆盖并发/同请求提交、排他创建、中断恢复、幂等冲突、原字节篡改、断链、方案版本、请求分母、日期、标签顺序、共享日历、重复事件及不可评分的第一对不被替换。3项Node测试验证登记入口继续拒绝错误模型、过期包及未知日历。

真实离线CLI使用前次已核验冻结包和输入，两方复用同Huber包，仅验证工程复用，没有新增候选效果。4个预期请求含成功、单方失败、残留attempt和未执行。跨进程重试不替换结果。全部业务字段与既有推理一致，原bundle20文件字节未变。

合成方案来源和未知债券身份不能作为真实事前条件。验收在忽略的`outputs/prospective-registry-final-20261003/`。首次64MiB上限拒绝的失败台账保留，不改写。

五个模块进入科学来源闭包。132文件来源da3a476已独立完整复现原19候选开发比较与三候选历史对照。严格加载、正式CLI离线导出及Python/JS一致性通过。证据位于忽略的outputs/prospective-reproduction-20261003，绑定的任务工作树须保留。前次127文件证据只适用于原3956422来源，保留原工作树和receipt。阶段进展同步[PLAN](../PLAN.md)和[REPORT](../README.md)，工程验收不能替代真实观察覆盖或前向模型验收。
