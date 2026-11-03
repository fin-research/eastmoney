# 融资择时模型

入口：`/trading-research/financing-model`，兼容 `/financing-model`。

当前上线的是三档建议 `timing-advice-v1`（`schema_version=5`）。历史票面预测 `issuance-forecast-v1`（`schema_version=4`）仍可读取，但其身份已暂停。更早的相对利差运行不兼容，不转换也不重算，原始归档和人工记录保留。方法、选型、调度和重训见 [Quant 线上推理](../../../quant/docs/ONLINE_INFERENCE.md)，Quant / Dashboard 写入分工见 [共享数据库](../../../docs/DATABASE.md#融资模型跨仓库写入)。

## 接口

- `GET /api/financing-model`：读取最新兼容运行、有效整体结论、卖方观点和最近 100 个运行日期。无数据 404，不触发训练、推理或写库。
  - 三档运行的模型资格暂停或未登记时，默认读取返回 409。
  - 历史票面运行默认读取返回 200 和 `model_status`。预测、情景、市场路径、归因、验证指标和自动结论被清空，人工编辑、卖方历史和记录保留。
- `GET /api/financing-model?run=<uuid>`：指定运行及版本清单，暂停运行返回带状态的历史审计值，页面统一隐藏暂停的模型数值。
- `GET /api/financing-model/business-metrics?run=<uuid>`：按指定运行的发行人与行情日期读 LCR、NSFR、资金缺口和主体利差。页面在模型快照显示后独立加载，切换版本时废弃旧请求，指标失败不阻塞模型结果。
- `PATCH /api/financing-model/conclusion`：以 `runId` 增量更新人工 `verdict/preferredWindow/narrative`，保留模型基础结论。
- `GET /api/financing-model/decisions`：历史人工决策与结果。`POST` 按 `runId` 保存必填 `decisionAction` 和可后补的 `outcome`。
- `POST /api/financing-model/sell-side`：追加最近七日研究库逻辑汇总和 4—5 家机构观点，SSE 遵循统一 `progress/result/error`，普通 JSON 成功 201。`PATCH` 追加人工 `logicSummary` 修订，保留逐机构观点和来源证据。模型暂停时禁止重新生成卖方观点，已有内容的读取和人工修改仍可用。

DTO 在 `src/lib/timing-advice.ts` 和 `src/lib/issuance-model.ts`，读取在 `src/lib/server/timing-advice-repository.ts` 和 `issuance-model-repository.ts`。

## 三档发行建议

- 快照含：AAA 证券公司债 3Y 市场范围、30 日窗口、训练标签截止日、defer / wait / issue 三类概率、原始 argmax 建议和开发检验。不产生发行票面、未来发行日期、节约或 bp 贡献，发行金额、主体、条款为空，不用代理值填充。
- 发布沿用真实 Workflow 归档、不可变 20 位十六进制版本、`active` 资格、有效期、T-1 行情和原子发布校验。
- 开发检验的 `validation_scope=inner_development`、状态 `user_selected_exploratory`（用户选定试用）。它是开发样本，不代表通过泛化门槛。
- 页面展示建议概率、市场日期和开发检验，保留人工编辑、独立业务指标和卖方观点。
- 业务指标始终按本公司与行情日期独立查询，不作为三档模型的发行主体输入。

## 页面

- 整体结论卡在最前，结论正文始终是可编辑文本框。有 `model.conclusion:update` 权限时 650ms 防抖并在失焦保存，无权限只读，不显示编辑按钮。未人工编辑的结论按模型生成，人工正文原样保留，恢复模型内容用基础结论。
- 业务指标卡第二：LCR / NSFR 取 `public.quant_input` 的字段日序列，按模型行情日期截断，同日资金日报与本地工作簿重合时采用日报值。资金缺口用 `static_gap_1m` 的资金日报口径（亿元），不与资金计划缺口混用。三者显示当期值和截至当期的经验历史分位。
- 主体利差：取 `bond_issuance` 中同发行人 AAA 普通固息无权债池，与 `bond_history` 同日的估值、余额、剩余期限计算。债券代码按 Data 的沪深八位整数规则连接，匹配同日 AAA 证券公司债曲线，按正余额加权。
- 分位只用最近 60 个可匹配行情日里的完整利差。预期活跃券余额未知、正余额券估值/期限缺失或曲线缺失时，当日利差为空。
- 各分位至少 20 个有效观测才显示，卡片只显示“历史P”，不附日期。
- 卖方检索用研究库 `https://research.hasbai.xyz/mcp`，最近七日、研报类型、最多 50 条。模型上下文只含模型输出，不混入旧分位驱动。

## 历史票面运行

仅在显式读取或历史审计时展示，页面分支 `issuance-forecast-v1`。

- 预计票面为百分数，净节约和贡献为 bp，金额为年化万元。贡献完整保存并由 API 返回，票面基准加全部贡献必须还原首个发行日票面。
- 归因方法白名单有四项：`tree_path_dependent`、`linear`、`additive_market_coupon`、`relu_path_integrated_gradients`（见 migration `0013` 与 `issuance-model.ts`），页面专门展示后两项。`relu_path_integrated_gradients` 是单隐层 ReLU 模型的路径积分归因，不是 SHAP 或因果效应，兼容字段 `shap_bp` 存贡献值。`additive_market_coupon` 是票面溢价 TreeSHAP、市场变动线性贡献和国债/信用锚的组合归因。
- 类别没有字典时显示编码编号，不推断类别名称。
- 发行建议由同一票面模型的预测路径生成。可发行日期取预测票面最低 25%（向上取整，边界并列），连续日期合并为区间。最早日期在集合内时建议“尽快发行”，否则“等待”。
- 模型验证显示训练事件数、标签截止日、当年提前 30 日的检验样本、±5bp 预测命中率（`hit_rate_5bp`）和 MAE。旧结果缺命中率时显示为空，不用旧 `win_rate` 替代。
- 已观察的历史年份不标作独立前向测试。

## 存储与发布

数据流：Data 维护原始行情和真实定价字段 → Quant 推理 → R2 冻结结果 → `financing_model.publish_online_result` 原子发布 → Dashboard 从结构化表重建快照。数据库不存原始模型 JSON，原始证据在 R2。Quant 不写人工结论、决策或卖方观点。

| 表 | 内容 |
|---|---|
| `model_run` | 日期、方案、来源版本、基础/人工结论 |
| `timing_run` | 三档概率、建议和开发检验（`schema_version=5`） |
| `issuance_run`、`issuance_forecast`、`issuance_market_path`、`issuance_shap`、`issuance_validation` | 历史票面运行（`schema_version=4`）的决策、票面、市场路径、贡献和验证 |
| `model_eligibility` | 按不可变 `model_version` 记录 `active/suspended` 及原因 |
| `timing_decision_record` | 人工操作与事后结果 |
| `sell_side_snapshot` | 研究库观点与人工修订的追加快照 |

- 同一模型日期保留稳定 `runId`。较新成功结果更新模型字段和明细，人工结论、择时记录和卖方快照保留。乱序旧结果不覆盖新结果，明细失败整次事务回滚。
- migration 在 `financing-model-migrations/`，用 `pnpm financing-model:db:migrate` 应用，顺序为 Data 输入 → Dashboard 表/API/页面 → Quant 新包/Worker → 实际 Workflow 和生产 API 核验。
- 发布只接受真实 `cloudflare-workflow` 来源与匹配的 R2 归档 key，并校验模型有效期、输入/标签日期和旧结果契约。发布函数只接受已登记 `active` 的模型身份，正常 Workflow 和维护补发用同一检查。
- 未登记身份按 `suspended/quality_review_required` 处理。资格登记由受控运维显式写入，migration 不自动激活候选。
- 历史票面发布的契约演进见 `0008`–`0015`，三档契约见 `0017`，资格见 `0016`。
