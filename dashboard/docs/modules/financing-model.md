# 融资择时模型

入口：`/trading-research/financing-model`，兼容 `/financing-model`。当前结果支持三档建议 `timing-advice-v1` 与历史票面 `issuance-forecast-v1`，旧结果不兼容读取、不迁移或重算，原始归档及人工记录保留。方法与选型由 [Quant](../../../quant/PLAN.md) 维护。

## 接口

- `GET /api/financing-model`：只读取最新新版模型快照、有效整体结论、卖方观点及最近100个新版模型日期。返回当前及未来发行日票面、四组期限/券种情景、市场路径、模型贡献、逐年逐期限验证。不等待独立业务指标，无新版数据返回404。底层预测契约中的区间、净节约与等待风险保留，页面不展示。
- `GET /api/financing-model?run=<uuid>`：指定新版运行及版本清单。旧相对利差运行不被转换为票面预测。
- `GET /api/financing-model/business-metrics?run=<uuid>`：按指定运行的发行人与行情日期读取 LCR、NSFR、资金缺口和主体利差。页面在模型快照显示后独立加载，版本切换时废弃旧请求。指标失败不阻塞已发布的模型结果。
- `PATCH /api/financing-model/conclusion`：以`runId`增量更新人工`verdict/preferredWindow/narrative`，保留模型基础结论。
- `GET /api/financing-model/decisions`：历史人工决策与结果。旧运行的历史分位可保留，新运行该字段为null，页面不展示旧分位。
- `POST /api/financing-model/decisions`：按`runId`保存必填`decisionAction`及可后补的`outcome`。
- `POST /api/financing-model/sell-side`：追加最近七日研究库逻辑汇总及4—5家机构观点。SSE遵循统一`progress/result/error`，普通JSON成功201。
- `PATCH /api/financing-model/sell-side`：追加人工`logicSummary`修订，保留逐机构观点和来源证据。

DTO位于`src/lib/issuance-model.ts`，读取在`src/lib/server/issuance-model-repository.ts`。人工编辑和历史记录复用既有repository。旧DTO仅供历史人工记录，不再作为当前模型API或页面入口。

## 业务规则

同一模型日期保留稳定runId。较新成功结果更新模型字段和明细，保留人工结论、择时记录及全部卖方快照。乱序旧结果不覆盖新结果，明细失败整次事务回滚。人工编辑结论优先展示，恢复模型内容使用基础结论。

预计票面以百分数表示。净节约和贡献为bp。预测差额以首个可发行日为基准，不增加等待成本或策略门槛。金额为年化万元。

贡献直接使用统一模型的归因结果。`relu_path_integrated_gradients`表示单隐层ReLU模型从标准化零基线到输入的直线路径积分归因，不是SHAP或因果效应。兼容字段`shap_bp`保存贡献值。`additive_market_coupon`明确表示票面溢价TreeSHAP、市场变动线性贡献及国债/信用锚相对冻结训练参考的组合归因，正值推高票面，负值降低票面。票面基准加全部贡献必须还原首个发行日票面。旧模型条形图展示绝对值最大的八项，并保留有贡献的宏观、一级、二级代表项。

MLP路径积分贡献按国债、行业报价、发行人报价、发行人身份、评级、发行条款及预测提前期汇总。报价与提前期交互归入对应报价来源。编码输入为零或缺失时，保留模型计算的有效贡献；未登记列按原列名独立显示。模型基值加全部贡献还原预测票面，明细按原编码列展示。类别没有字典时显示编码编号，不推断具体类别名称。

完整贡献保存并由API返回。不能将贡献改号为旧发行支持度。

发行建议由Quant同一票面模型的预测路径生成：可发行日期按预测票面选最低25%，向上取整并保留边界并列，连续可发行日期合并区间。最早日期已在集合内则“尽快发行”，否则“等待”。不增加独立暂缓模型或P40/2bp门槛。原人工动作记录保留。

未人工编辑的结论显示首日票面与较低区间，人工正文原样保留。四品种布局和顺序不变，逐方案调用同一个模型，不分别加载模型包。
第一张卡为整体结论：右上角三档标签、债券品种及预计票面，结论正文始终为可编辑文本框。有 `model.conclusion:update` 权限时 650ms 防抖及失焦保存，无权限时只读，不显示编辑按钮。

第二张卡为业务指标：LCR/NSFR 从 `public.quant_input` 的字段日序列按模型行情日期截断。资金日报与本地工作簿同日重合时采用日报值。

资金缺口使用 `static_gap_1m` 的资金日报口径，单位亿元，不与资金计划缺口混用。三者显示当期值与截至当期的经验历史分位。主体利差从 `bond_issuance` 的同发行人 AAA 普通固息无权债池与 `bond_history` 同日估值/余额/剩余期限计算，债券代码按 Data 的沪深八位整数规则连接，匹配同日 AAA 证券公司债曲线并按正余额加权。最近60个可匹配行情日中只用完整利差计算分位。

任何预期活跃券余额未知、正余额券估值/期限或曲线缺失时当日利差为空。各分位至少20个有效观测才显示。卡片只显示“历史P”，不附日期。业务指标仍独立查询，不因模型改造改变来源，也不是一级可执行票面。

整体结论、业务指标与四品种对比顺序排列。因子贡献合为一张卡。MLP两图展示完整来源净贡献，另列基值、全部贡献、预测值及可展开的逐列明细。旧模型左侧雷达按已登记且观测值有效的市场贡献类别净值显示利率、信用、资金、宏观、一级与二级贡献，避免同类正负贡献按绝对值重复累加。旧模型的发行人、发行条款、日历、样本量/时效元数据和未登记特征不进入贡献图。同业发行价格和溢价属于一级市场。

名称统一中文，不设“其他”类。API保留完整贡献及加法一致性。旧模型右侧显示主要因子，合并不同观察期的同名利率变化因子，并保留有贡献的宏观、一级、二级代表项。未来发行窗口/模型验证按3:1展示，窄屏保持顺序单列。

窗口图和明细只展示预测票面。模型验证保留原位置和布局，显示训练事件数、标签截止日、模型当年提前30日的检验样本、预测命中率（±5bp）及MAE。命中率读取`hit_rate_5bp`，按同一逐年逐提前期检验样本的绝对票面误差不超过5bp计算。旧结果未提供时显示为空，不使用旧`win_rate`替代。

API保留历史单侧sigma胜率、偏差与标准差作为诊断。窗口明细、决策录入和卖方生成继续使用原操作。2026等已观察历史不标作独立前向测试。

卖方检索沿用研究库`https://research.hasbai.xyz/mcp`，最近七日、研报类型、最多50条。模型上下文只包含票面、净节约、风险、市场路径和模型贡献，不再混入旧分位驱动。

## 数据流与存储

Data维护原始行情和真实定价字段 → Quant统一票面模型推理 → R2冻结结果 → `financing_model.publish_online_result`原子发布 → Dashboard从结构化表重建新快照。主报告 GET 只读取已发布模型与人工内容。独立业务指标 GET 另读 Data 原始输入表，两者均不触发训练、推理或写库。

| 表 | 归属内容 |
|---|---|
| `model_run` | schema_version=4的日期、方案、来源版本、基础/人工结论。旧模型行保留历史 |
| `issuance_run` | 截止日、决策、风险、贡献基准、验证及日历来源 |
| `issuance_run.product_scenarios` | 同一首个可发行日的四组期限/券种票面估计与样本数 |
| `issuance_forecast` | 有序发行日票面、区间、净节约、成熟标签与样本数 |
| `issuance_market_path` | 完整自然日市场路径、报价/发行日、carry来源日 |
| `issuance_shap` | 全部特征值及原始贡献，主键run_id/ordinal |
| `issuance_validation` | 各年各提前期事件数、冻结sigma、历史单侧胜率、±5bp命中率、MAE/RMSE、偏差及同样本基准 |
| `timing_decision_record` | 人工操作与事后结果 |
| `sell_side_snapshot` | 研究库观点与人工修订的追加快照 |

旧`model_run_market_driver/driver_group/product_scenario/forecast_window`仅保存历史。数据库不保存原始模型JSON。原始证据保存在R2。Quant不写人工结论、决策或卖方观点。

## 线上发布与验收

`0008_issuance_forecast.sql`、`0009_issuance_full_inputs.sql`、`0010_issuance_report_repair.sql`与`0011_unified_coupon.sql`由Dashboard维护，通过`pnpm financing-model:db:migrate`应用。发布只接受真实`cloudflare-workflow`、`issuance-coupon`来源与匹配的R2归档key。校验模型有效期、输入/标签日期、市场路径及贡献加法与票面一致性。旧结果契约发布被拒绝。

Quant工作日08:30运行，归档`quant-trial/runs/{date}/{instanceId}/result.json`后发布。默认本地CLI不写生产。维护补发只能使用已验证的实际Workflow归档。迁移顺序为Data输入 → Dashboard表/API/页面 → Quant新包/Worker → 实际Workflow与生产API核验。模型发布和重训规则见 [线上推理](../../../quant/docs/ONLINE_INFERENCE.md)。

测试包含PGlite真实migration/发布/回滚/人工内容保留、DTO/API及桌面/手机浏览器组件截图。组件夹具测试不等于生产鉴权E2E。生产链路以实际Workflow、数据库和程序化HTTP证据验收。

`0012_composite_coupon_attribution.sql`只扩展既有发布函数的归因方法白名单，不修改历史结果或放宽票面加法校验。

`0013_relu_path_attribution.sql`扩展归因方法白名单以接收ReLU路径积分贡献，保留票面加法校验和历史方法。

`0014_coupon_point_publication.sql`接收声明`forecast_horizons=[1,14,30]`且`expected_savings_supported=false`的三点票面预测。日期、区间、节约和建议字段按点预测契约校验，动作保留“仅预测票面”。该形状不执行历史低四分位择时规则，不按`release_policy`或`qualified`判定效果资格。

`0015_coupon_point_zero_waiting_cost.sql`沿用点预测的`waiting_cost_bp=0`语义，表示未计等待成本；同时兼容空值，拒绝非零等待成本。区间和节约字段仍须为空。
该迁移同时允许未提供的平市场对照MAE为空，不补造对照结果。


## 模型数据资格

`model_eligibility`按不可变`model_version`记录`active/suspended`及原因。未登记身份按`suspended/quality_review_required`处理。`0016_model_data_quality_eligibility.sql`将`61492e3527e1ae367475`登记为`suspended/data_quality`。发布函数只接受已登记的`active`身份，正常Workflow及维护补发使用同一检查，不回退历史模型。

GET仍返回200及`model_status`。默认报告清空暂停模型的预测、情景、市场路径、归因、验证指标及自动结论，保留人工编辑、卖方历史和记录。显式`?run=`提供带暂停状态的历史审计值；页面依状态统一隐藏模型数值。暂停时禁止重新生成卖方观点，既有内容读取与人工修改仍可用。原始表行及R2归档不修改。

## 三档发行建议

`0017_timing_advice.sql`增加schema_version=5的运行和typed `timing_run`，保留旧票面发布函数与暂停资格。当前GET按日期选择最新兼容运行；三档快照仅包含AAA证券公司债3Y市场范围、30日窗口、训练标签截止、三类概率、原始argmax建议及开发检验。它不产生发行票面、未来发行日期、节约或bp贡献。发行金额、主体及条款在schema5中为空，不用代理值填充。

`timing-advice-v1`复用真实Workflow归档、不可变20hex版本、active资格、有效期、T-1行情和原子发布校验。同日runId稳定，较旧重放不覆盖新结果，人工结论、决策和卖方历史保持。历史检验状态`user_selected_exploratory`表示用户选定试用，`validation_scope=inner_development`明确162条记录属于开发样本，未宣称通过泛化门槛。资格登记由受控运维显式写入，迁移不自动激活任何候选。

页面三档分支展示建议概率、市场日期与开发检验，保留人工编辑、独立业务指标及卖方观点。四品种、票面窗口及归因仅在旧票面分支显示。业务指标始终独立按本公司与行情日期查询，不作为三档市场模型的发行主体输入。

三档默认读取遇到暂停或未登记资格返回409；显式运行ID保留历史审计，页面仍隐藏暂停预测。人工结论、决策及卖方记录的已有写入边界保持。
