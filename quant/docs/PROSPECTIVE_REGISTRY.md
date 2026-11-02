# 离线事前登记与审计台账

这是后续前向研究的本地工程入口，未接入生产 Workflow、真实标签训练面板或模型发布。所有记录均为 `local_unanchored`。排他创建、fsync、回读和哈希链只验证本地内容一致。它们不能证明登记早于定价，也不能证明链末尾没有被整段删除。实际业务调度分母和外部可信时间锚尚未建立，真实前向事件数固定为 0。

## 职责

- `model/prospective_protocol.py`：新研究的纯契约。固定上海时区、自然日 h30、对照方法、月初重训 / 月末到期、匹配、方案变化、分母和去重规则。
- `data/prospective_ledger.py`：本地内容对象和顺序事件。原字节按 SHA 保存，临时文件落盘后排他链接并 fsync 目录。同幂等键异内容被拒绝。全局文件锁保护事件提交。审计检查内容、前序摘要、序号和断链，保留中断遗留的对象。
- `application/prospective.py`：先登记预期请求集合，再保存尝试以及双方的成功或失败。每个请求单独加锁，已有结果直接返回，残留 attempt 终止为 `interrupted_unknown`，不自动重推。方案改版追加父版本，取消与合成标签单独追加。
- `online/prospective-infer.mjs`：直接复用 `infer` / `validateModel`，只经内存和 stdout 返回结果。本地传输上限 128MiB。
- `scripts/prospective_registry.py`：唯一登记 CLI，只接受当前 checkout 忽略的 `outputs/` 下的目录，不联网取数、不写数据库、不切模型指针。

## 固定规则

- 初始化时协议绑定完整科学来源和实际运行环境。源码或环境改变后拒绝继续追加或审计，须另登记研究。底层内容完整性仍可独立检查。
- 对照固定为原 5 年行业残差 Huber。候选方法显式提供，并与每次实际模型文件的 candidate 一致。每月包的训练截止必须是当月首日，有效期到当月末，不能沿用旧包。
- 方案条件全部显式提供，不继承“公募”等预测默认值。来源文件的原字节随版本保存，但来源文件或用户填写的日期不构成可信时间证明。
- 已知身份只接受 `code + original_issue_date`。未知代码保持 `unresolved_identity`，不做事后模糊主体匹配。改变条件的原登记继续保留并单列复核，不静默映射到新方案。
- 预期 batch 在推理前固定每个请求的方案、对照 / 候选 manifest、原输入和共享日历 SHA。两方使用相同的方案、输入、origin 和日历，模型原字节也校验并归档。缺文件、身份不符、单方失败、过期模型和未知日历都保留请求。batch 只证明“登记批次内”的分母，不是完整的业务调度清单。
- h30 定义为：真实定价日 − 实际执行的上海日期 = 30 个自然日。执行起止或结果提交跨日、声明的 origin 与实际执行日期不符，标为回放 / 迟到。方案和 batch 可提前登记，不能在执行后回填。
- 按事件与 origin、结果提交序号先锁定第一对成功预测，再检查未来标签、方案状态和精确定价日预测点。第一对不可评分时不提升后续预测。标签已先登记则为已知标签回放。同刻 / 更正冲突保留歧义，不按误差挑选。缺精确定价日预测点时不插值、不换邻近日期。
- 首版只接受显式 `synthetic-label` 验证审计状态，不接受真实标签，不计算真实前向 MAE 或融资收益。合成可评分点、独立事件和真实前向资格分开计，`eligible_forward_events` 始终为 0。

## 使用

所有 JSON 和源文件放在忽略目录，字段契约以纯校验模块为准。每次初始化使用新台账目录。

```bash
uv run python scripts/prospective_registry.py --ledger outputs/registry/STUDY init --study-id STUDY --candidate-method outputs/candidate-method.json
uv run python scripts/prospective_registry.py --ledger outputs/registry/STUDY scheme --document outputs/scheme-v1.json --source outputs/scheme-source.json
uv run python scripts/prospective_registry.py --ledger outputs/registry/STUDY batch --document outputs/expected-batch.json
uv run python scripts/prospective_registry.py --ledger outputs/registry/STUDY predict --batch-id BATCH --request-id REQUEST --control-bundle outputs/control --candidate-bundle outputs/candidate --inputs outputs/inputs.json
uv run python scripts/prospective_registry.py --ledger outputs/registry/STUDY audit
```

- 预测失败返回退出码 1，事件和分母仍可审计。
- 修改方案时 `version` 递增，`parent_sha256` 须为当前方案版本摘要。取消用 `cancel --scheme-sha256 SHA`，合成标签用 `synthetic-label --document outputs/synthetic-label.json`。
- 恢复中断只能审计并结束原请求。新的执行须独立登记新请求，不隐去原失败或未知执行。

## 测试

`tests/test_prospective_registry.py` 覆盖以下行为：

- 并发与同请求提交、排他创建、中断恢复、幂等冲突。
- 原字节篡改、断链、方案版本、请求分母。
- 日期、标签顺序、共享日历、重复事件，以及不可评分的第一对不被替换。Node 测试 `online/tests/prospective.test.mjs` 验证登记入口拒绝错误模型、过期包和未知日历。工程验收不能替代真实观察覆盖或前向模型验收。
