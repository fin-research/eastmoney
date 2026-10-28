# 线上推理

## 当前三档发行建议

用户于2026-10-28暂停研究并授权选用`778e5cd2116288b99576`。该包为`timing-advice-v1`：固定D_all_history线性三分类、140维原始利率路径、原argmax，不添加行情规则。旧票面身份继续暂停。

最终训练标签截止2025-12-31。固定参数包有效至2026-12-31；每日只重新推理，不重训。162日期为内层开发检验，未通过原研究稳定性门槛，不是当前权重的新验证。

Dashboard migration `0017_timing_advice.sql`拥有结构化三档表和发布映射。新类型不写票面、节约、发行条款或bp贡献；旧类型独立读取。资格缺失或暂停时默认接口拒绝，显式历史运行保留审计。同日发布保持稳定ID和人工内容。

生产Workflow读取Neon此前90日资金／原始行业3Y节点，严格T−1、真实可用日期、双报价时钟，缺报不填补。输入及结果不可变归档后才原子发布。业务默认流程使用该Workflow；旧`main.py`票面命令受原暂停资格约束，不作为新择时入口。

```sh
# 固定参数本地真实输入核验，不训练、不更新Choice
uv run python scripts/run_timing_advice.py outputs/timing-advice-20261028-v2 --as-of 2026-10-28
cd online
node verify-timing.mjs ../outputs/timing-advice-20261028-v2
# 发布前验证该精确包与runtime的parity，先stage后切指针
node publish.mjs ../outputs/timing-advice-20261028-v2 --stage-only
pnpm deploy:dry
pnpm deploy
node publish.mjs ../outputs/timing-advice-20261028-v2
pnpm exec wrangler workflows trigger quant-bond-inference-trial '{"as_of_date":"2026-10-28"}' --id timing-release-20261028
```

凭据沿既有`.env`加载，不打印。先应用所有方migration、部署Dashboard，再核验真实Workflow、数据库及授权API。模型工件与原始证据不提交Git。Python/JS一致性不能代替效果验证，Node耗时不能代替实际Cloudflare运行。

以下保留旧票面和维护流程的历史技术说明，不表示恢复旧模型。

# 债券票面线上推理与工作台发布

本地研究使用普通checkout。数据、模型和运行产物保留在本地忽略目录，可按研究需要更新。下文旧工作树路径只用于历史证据追溯，不要求新建worktree。已发布模型的身份与哈希仍按发布规则保存。
## 当前契约

当前先核实历史及每日真实数据。禁止期限或日期插值、前向填充、训练中位数及零值填补缺失报价。MLP8含上述预处理，已暂停；其封存参数、归档及原成绩保持原样。

Dashboard迁移`0016`维护`financing_model.model_eligibility`。生产只接受显式`active`身份，缺记录、暂停或查询失败均拒绝。Workflow在固定模型身份后、冻结输入前检查；原子发布函数再次锁定并检查身份，覆盖旧Worker、在途结果和维护补发。

本地默认预测、`--online train/infer`及模型上传也检查同一资格。上传在首次R2写入前拒绝不合格身份。静态报告发布不激活模型。

默认业务读取返回暂停状态并清空自动预测；显式历史审计保留原值和状态。人工结论及卖方历史保留。离线数学复算只供审计，不构成生产推理或发布许可。

本地和线上沿用 `issuance-forecast-v1`，当前实现特征包为 `issuance-coupon`。统一模型预测真实发行票面，运行时支持线性、LightGBM及封存MLP。新短预测只输出T+1、T+14、T+30，最长30自然日。公私募适用范围由manifest的`issuance_scope`固定。最终部署一个候选，原生产模型仅供历史比较。上线状态以[优化路线图](../PLAN.md)为准，代码通过不等于已部署。

输入来自Neon资金、真实发行及行业曲线、主体存续估值。具体组由manifest固定。`issue` 输入组在读取时由 `public.bond_issuance` 的列生成，不再读取 `quant_input.issue`。`bond_history.bond_code` 以 Data 的八位整数规则存储，模型和展示层恢复为六位主体、可选 X/X2 和交易所后缀。

标签只使用可靠定价日和最终票面，所有特征严格早于预测起点。当前公募包只纳入明确公募的标签、一级历史和主体二级估值。私募及未知方式分别统计排除，原始输入保留。`public_only`绑定协议、模型审计和输入，线上私募／未知请求被拒绝。旧`all`包保留共同建模行为，不沿用旧公开债排除表。

尚无历史条款公告版本时，回放仅为给定方案的预测。

原四组方案逐一调用同一个模型，保留比较顺序。新短预测输出“仅预测票面”，不套用最低四分位或最小值建议规则，推荐日期为空。旧结果归档保留，不建设兼容读取或重算旧成绩。验证命中率按真实票面绝对误差不超过5bp计算，冻结误差标准差只用于诊断，详见[业务口径](DOMAIN.md)。

## 短预测的训练与加载

默认入口加载`outputs/selected-coupon/release-evaluation.json`，也可用`--coupon-selection`指定。生产取数前核对其模型身份及显式运行资格。MLP的历史`user_selected_frozen_mlp`记录逐项核对封存来源并直接恢复参数，不执行候选搜索或重训；该历史选择不再授权当前生产预测。旧模型的原有证据核验仍保留。

新候选直接预测实际票面，全部报价权重从数据学习；固定估值锚只保留作对照。

旧三点研究包使用`release_policy=short_coupon_prediction`，选用MLP使用`user_selected_frozen_mlp`。两者均声明`forecast_horizons=[1,14,30]`和`expected_savings_supported=false`。Dashboard由新迁移验收三点及空建议，不将自然日预测日期当作执行日。正式激活仍须通过完整Python/JS核验、数据库发布及Workflow回读。

## 训练、解释与核验

新增离线研究登记模块后的科学来源为132文件，冻结于da3a476。完整原设计复现、新进程严格加载、正式CLI离线30/90日导出与推理及Python/JS一致性均通过。原三批旧来源继续拒绝，不能将旧选择交给新来源。当前生产模型不变。

```bash
uv run python main.py --online train --as-of YYYY-MM-DD --bundle-dir outputs/online --coupon-selection outputs/prospective-reproduction-20261003/point-history/release-evaluation.json
node online/verify.mjs outputs/online
uv run python main.py --online infer --bundle-dir outputs/online
node online/cli.mjs outputs/online outputs/online/inputs.json
```

上述训练示例当前须在保留的 `/Users/yueshi/src/eastmoney/worktrees/quant-prospective-ledger-20261003` 根执行。主checkout的同名忽略目录仅作只读备份，来源协议仍绑定任务工作树。其他位置只有在源码闭包、运行环境与协议完全匹配时才能指定绝对路径。绝对selection路径本身不能消除来源不匹配。

当前132文件来源完整复现位于 `outputs/prospective-reproduction-20261003/`。前次127文件来源的完整复现位于原 `quant-observation-slices-20261003` 工作树的 `outputs/observation-slices-20261003/`。前次c400614的124文件复现仍保留在原 `quant-maintenance-report-20261003` 工作树，仅适用于该来源。更早 `public-coupon-20261002` 也不作为当前训练入口。

新来源严格拒绝三批旧发布证据。完整源码、运行版本、原设计来源链和工作树引用均须保留。观察读取模块仍未构造训练面板或供生产消费，完整复现不等于激活新模型。

`--coupon-selection`读取冻结公募选择和历史评价，按原始receipt重建、校验，不重新调用默认24配置搜索。Huber发布来自原schema5完整19配置的派生协议，旧均值选择/指纹保留，发布适配差异独立记录哈希。普通预测入口也可使用。线上infer从既有manifest读取输入组和范围。

旧归档包读取当月成熟标签。新固定验证包声明`training_label_cutoff=2026-01-01`，模型和逐券标签历史全年冻结；每日已可用市场输入继续更新。历史资格只描述原研究结果，不覆盖用户对MLP8的新授权。

旧Huber包预测稳健票面中心，显式`estimand=huber_center`及`expected_savings_supported=false`绑定模型审计、manifest和评价。每日/决策预期节约、净节约、年化金额和概率字段为空，不将稳健点差额发布到预期成本字段。旧稳健包无显式声明仍拒绝。

兼容键`lowest_expected_cost_date`仅表示点预测最低日。较低四分位根据同一票面点预测计算。

真实凭据只从根目录未跟踪 `.env` 注入。训练读取只读repeatable-read快照。使用显式 `--input-snapshot` 可完全离线回放。导出目录被忽略，包含单一model-main.json、历史评价证据、日历、manifest及Python参考。

`issuance-features.mjs`镜像公共市场特征，`coupon-features.mjs`构造发行条件、提前期、主体/同类历史与二级估值特征。`coupon-model.mjs`统一类别编码、预测与贡献，`tree.mjs`支持数值和类别分裂。基准加全部贡献必须还原票面。缺失历史可预测，不代表新主体误差已经达标。

`verify.mjs`核对全部历史特征、缺失向量、预测、逐项贡献及加法恒等式。它还核对日期、方案、票面、区间、节约、决策、市场路径和解释。来源归档与运行ID属运行时元数据，不冒充跨运行时逐字相同。证据绑定模型、输入、输出和实际JS文件哈希，变更后必须重新核验。

## 更新周期

行情和发行资料每日刷新。当前MLP固定2026年前标签及原权重，不能按月自动纳入2026年标签重训。当前包月末到期，过期拒绝预测。2027年交易所日历未核实前，跨年30/60/90日窗口均按实际终点拒绝，不能补造假期。不得为了跳过更新静默延长有效期。

真实历史评价复现月初训练与日度输入刷新，不把调参成绩作为新前向验证。CLI按月检查点与资源恢复规则见[回测](ISSUANCE_BACKTEST.md)。

## Workflow与发布

```bash
cd online
pnpm install --frozen-lockfile
pnpm test
pnpm typegen
pnpm typecheck
pnpm deploy:dry
pnpm publish:model ../outputs/online
pnpm run deploy
pnpm exec wrangler workflows trigger quant-bond-inference-trial '{"as_of_date":"YYYY-MM-DD"}'
```

Worker `quant` 无公网route/workers.dev，默认HTTP固定404。命名 `ResearchReport` 提供同一份 `/README.md`，兼容历史请求路径 `/REPORT.html`，Gateway `/financing-model/research` 沿用 `model.financing:read` GET/HEAD。其他路径和方法拒绝，原始输入与模型不进入静态目录。报告维护见 [RESEARCH_REPORT](RESEARCH_REPORT.md)。

周一至周五08:30 由 Messenger 私有 `ScheduledTasks` 触发，创建Workflow前，以`scheduledTime`对应上海日期检查DATA / InternalData的`/data/trading-days`（Choice上交所日历）。休市跳过，日历错误记录`quant_calendar_unavailable`并停止本轮。放行后使用计划日期和稳定`bond-YYYY-MM-DD`实例ID，重复投递只确认真实存在的实例。手动历史运行保留原行为。

日历服务故障可能漏掉当日定时生成，恢复后需人工补发。先固定新模型manifest，再在单个只读repeatable-read事务中取得manifest声明的全部输入组及行业曲线，将输入冻结到R2。重试复用已冻结快照。输入未覆盖前一报价工作日、标签未成熟、日历年份未知或模型过期均失败关闭。

`quant-trial/models/{version}/` 对象按内容固定，`current.json` 最后切换。不能激活旧特征版本。运行输入和结果位于 `quant-trial/runs/{date}/{instanceId}/`，带SHA-256且不可覆写。`publish-result` 重新读取归档并校验来源，调用 Dashboard migration 所有的 `financing_model.publish_online_result`。只有该步骤成功才算更新工作台。

Dashboard的`0011_unified_coupon.sql`扩展既有表及发布函数。它沿用schema v4运行行及票面、市场路径、贡献、验证明细。发布保留同日稳定ID、人工结论、决策记录和卖方快照。旧结果不会被解释成新票面，不在数据库保存原始JSON。维护补发可传 `publish_result_key`，只接受实际Workflow完整归档。不能伪造本地结果来源。

交付顺序：Data采集及历史回填 → Dashboard migration/读取/API/页面 → Quant一致性包和Worker → 实际Workflow发布与API核验。Dashboard通过PR及GitHub必需CI后合并自动部署。必要回退须使用与当前运行时匹配且已核验的模型包，不能把旧包交给统一模型运行时。

验证需包含Python全部单测/编译/Ruff/数据安全，Node测试/类型/dry-run，真实Python-JS一致性，真实数据库发布/读取及生产Workflow结果。未核对生产CPU前不宣称免费CPU预算验收通过。Node耗时不等于Cloudflare invocation CPU。

免费套餐每步CPU为10ms，不设置付费CPU上限。2026年10月26日首轮MLP预测CPU超限，设置30秒上限遭接口拒绝，生产部署未变。用户要求保留免费套餐。官方限制见[Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)。

MLP分步读取同一完整R2输入，每段32KiB，使用ETag固定对象及SHA核对内容。分片解析保留跨字节UTF-8和跨段记录，逐行核对时点。Workflow步骤持久化扫描状态、投影数据及段SHA；完整输入不会删减。

准备报价时钟、评级索引、原始报价上下文后，沿原编码、评分、归因及业务输出函数计算。未实现的模型依赖明确拒绝。原完整推理作为一致性参照。

归档新增`input-segments.json`与`quote-context.json`，均绑定完整输入SHA。中间产物不能独立发布。分片步骤失败不自动重复CPU计算。真实输入本地回放及中断恢复一致。

10月26日一轮默认取数、30批计算及归档补发通过。重复运行在评级索引准备步骤CPU超限，失败记录保留。

公募代码索引已拆为独立步骤，绑定输入SHA及范围；评级步骤只读该索引和发行字段。新版默认完整运行`mlp8-indexed-20261026`完成，全部计算及发布成功。同日运行ID保持不变。该次真实验收没有测得每步CPU的精确数值，不扩称未来调度均已验证。

单实例首版在407个成功步骤后发生步骤外资源超限。`coupon-segments-v2`使用同一Workflow类处理小批次，每批最多24片。父实例串行创建确定ID的子实例，子实例先落盘再发送批次事件。

父实例核验连续字节范围、前批检查点SHA及模型身份，准备阶段按组读取投影。完整快照、分片和原预测保持一致。跨批恢复或重复投递均须核已有产物，不能覆盖。

维护重放可用`input_snapshot_prefix`引用同日、同模型的既有Workflow输入。系统复制原字节并重新核完整SHA，不接受本地预测代替Workflow结果。

## 行业曲线输入的无损传输

完整行业曲线保留全部历史日期和正期限。`curve-grid-v1`只把重复曲线身份存一次，将逐行日期、期限和收益率编码为三元组。Python与JS在构造票面输入前恢复普通节点数组，原数组格式继续接受。解码拒绝未知编码、错误曲线身份、无效日期、乱序及重复键，不填补空值。

Workflow以`CURVE_GRID_SQL`读取同一日期范围，保留完整排序和节点。节点传输仍限16MiB字符，完整R2输入仍限32MiB字节。密集网格改变非标准期限参考属于输入变化，须独立评价；无损传输一致性不证明精度改善。

生产运行模块与研究HEAD不同时，使用`prepare-curve-grid-patch.mjs`准备、`--verify`核对、`--apply`发布最小传输补丁。它只接受已核七模块布局，只改实际生产模块的两处传输代码，保留其他六模块、资产、绑定和调度。发布前须另核当前模型指针、manifest及模型SHA，不能用旧模型验收代替已变化指针。

发布前运行完整网格往返、同输入特征和业务输出核对，并以真实workerd检查实际大小输入。发布后另验真实Workflow冻结、预测及发布结果。Node内存或本地workerd成功不等于生产峰值内存或CPU验收。

## 仅修复调度且生产模型源码不同的发布

若生产模型模块与当前源码不一致，不从研究工作区重打包模型。使用 `online/prepare-cron-patch.mjs` 将当前生产单模块逐字节保存至忽略的 `outputs/`，另加 `entry.js` 和从 `scheduled.ts` 去除类型的 `scheduled.js`。配置保持现有日期、flags、R2、Hyperdrive、Workflow、变量和 Cron，仅新增 DATA。脚本拒绝不符合预期的绑定、模块布局或导出。

```bash
cd online
node --env-file=../../.env prepare-cron-patch.mjs ../outputs/trading-day-cron-20261003
pnpm exec wrangler deploy --config ../outputs/trading-day-cron-20261003/wrangler.jsonc --dry-run --outdir ../outputs/trading-day-cron-20261003/dry
```

部署前重新读取 active deployment 与 `baseline.json` 一致，并核对 `production.js` 与 dry-run 模块 SHA-256 相同。对实际上传的 `scheduled.js` 验证交易日、休市、异常和重复投递。再部署该 `no_bundle` 配置，发布后下载模块并核对原模型 SHA-256、wrapper 和绑定。此模式保留原生产模型，本次 Git 提交只拥有调度修复，不能将 Git HEAD 视为完整生产模型源码。后续正常模型发布使用 `cron-entry.ts`，不得恢复旧 `worker.ts` 的默认 scheduled 入口。

市场分离发布使用schema6/7/8/9开发门槛及`validated_market_separation`冻结评价。同一model-main包内包含发行溢价树、直接期限市场Ridge或浅树及经济锚参考。Python/JS预测与全部组合贡献逐项一致。归因方法为`additive_market_coupon`，须先应用Dashboard 0012并部署相应DTO。

Huber点预测仍不支持预期节约字段。四轮开发均未通过，当前生产仍使用原Huber预测包。schema8行情平衡来源bf0a7c3已完成完整五组开发研究，但没有合格候选、历史发布评价或新manifest。不要把该研究分支交给旧132文件发布选择，也不要因研究报告更新部署研究HEAD。

只修订验证指标时，不从研究工作区重新打包或部署Worker。核对当前R2指针、原manifest和model-main SHA，以及原历史protocol/validation和每月预测、诊断、择时receipt。原分母、标签、MAE、RMSE和偏差必须逐项复现。派生manifest仅修改指标并附`validation.metric_revision`（旧版本/hash、原证据hash、推导脚本hash、定义及生产runtime hash）。

不能改写旧证据。用实际生产runtime和同一冻结输入验证业务字段不变。随后上传固定的新manifest及相同模型字节，最后切指针。真实Workflow成功发布并经数据库/API核验后，才算指标更新完成。

## 只发布静态研究报告

当前生产预测模块与研究 HEAD 不同，报告更新使用 `prepare-report-patch.mjs`，不执行常规 HEAD 部署。首次接受唯一推理模块，包装额外导出命名 ResearchReport。重复发布只接受已审查的四模块或集中调度七模块布局，并逐字保留全部模块。原 default fetch、Cron 和 Workflow 均沿用生产代码。资产目录仅包含已审阅 README.md。

```bash
cd online
pnpm build:report
node --env-file=../../.env prepare-report-patch.mjs ../outputs/research-report-20261003
pnpm exec wrangler deploy --config ../outputs/research-report-20261003/wrangler.jsonc --dry-run --outdir ../outputs/research-report-20261003/dry
node --env-file=../../.env prepare-report-patch.mjs --verify ../outputs/research-report-20261003
```

独立 worktree 使用项目组根 `.env` 的实际路径。每次使用新目录，拒绝覆盖旧包装。部署前核对 dry-run 的所有模块 SHA 与 baseline 完全相同，然后发布该已核验配置。发布后下载并逐模块核对原模型、wrapper、报告服务及资产哈希。

先部署 Quant 的命名报告入口，再部署 Gateway 绑定，程序化检查匿名/测试账号 GET、HEAD、未知路径、方法、MIME 及私有绕过。布局、报告服务或绑定变化会拒绝准备，须先审查再登记。不自动嵌套 wrapper。

既有冻结选择在当前研究源码上若被来源校验拒绝，不绕过校验。新训练导出必须先登记与当前实现一致的派生评价。报告整理旧证据与当前实现审阅分别保存，不把工程回放称为新模型发布或新增前向验证。

第四轮schema9在独立来源`6d09bb6`完成目标期限动态与行业曲线形状研究，两候选均未通过上涨保护。新曲线组由实际候选/market layer显式开启，旧模型默认关闭。真实输入数值一致性不代表完整业务发布通过。未产生新release、manifest或模型激活，原来源的训练入口仅适用于其保留工作树。

## Messenger 集中调度发布

Worker 自有 Cron 移除，Messenger 唯一分钟 Cron 按原 UTC `30 0 * * MON-FRI` 经私有 `ScheduledTasks` 调用 `startScheduledInference`。计划时间、交易日检查及 `bond-YYYY-MM-DD` 幂等保持不变。正常源码发布入口为 `cron-entry.ts`。

生产模型与研究 HEAD 不同时使用 `prepare-scheduler-patch.mjs`，只接受已审查的报告四模块或本调度七模块布局。保留 `production.js`、报告服务与报告模块字节，只扩展 entry wrapper 并增加调度服务、handler 和 runner。Script Upload API 的 `keep_assets=true` 保留现网报告资产，不构建研究 HEAD。发布前核对 active deployment/settings/schedules 和 dry-run 每个模块哈希，生产漂移或包被改写均拒绝。

```sh
node --env-file=/absolute/path/eastmoney/.env prepare-scheduler-patch.mjs ../outputs/scheduler-release
pnpm exec wrangler deploy --config ../outputs/scheduler-release/wrangler.jsonc --dry-run --outdir ../outputs/scheduler-release/dry
node --env-file=/absolute/path/eastmoney/.env prepare-scheduler-patch.mjs --verify ../outputs/scheduler-release
node --env-file=/absolute/path/eastmoney/.env prepare-scheduler-patch.mjs --apply ../outputs/scheduler-release
```

先发布消费者入口并保留线上 Cron，再上线 Messenger 后清空 Cron。该脚本只上传代码，时间表由切换步骤设置。发布后下载并核对所有原模块字节及部署资产、README.md 哈希。`prepare-report-patch.mjs` 已识别七模块，后续仅报告发布会保留调度代码。

## 封存MLP8的选用与导出

用户已授权采用改善后的版本，不以原效果门槛阻挡。原研究清单、`qualified=false`及全部指标原样保留。单独选用记录绑定原状态、协议、receipt、优化记录及审计SHA。

```sh
uv run python scripts/adopt_frozen_mlp.py --study-root /absolute/path/v1 --summary /absolute/path/mlp8-safe.json --output outputs/selected-coupon/release-evaluation.json
uv run python main.py --online train --as-of YYYY-MM-DD --bundle-dir outputs/selected-coupon/online
node online/verify.mjs outputs/selected-coupon/online
```

MLP走恢复适配器，禁止落入`CouponModel.fit()`。模型包保留原输入预处理、网络权重和目标尺度，训练截止不随发布日期改写。归因为`relu_path_integrated_gradients`，兼容字段`shap_bp`继续承载bp贡献。该方法是编码空间直线路径归因，不是SHAP或因果解释。

旧生产包缺少当前来源档案，不能声称新运行时可精确回放。先用`publish.mjs BUNDLE --stage-only`暂存新包，回读核SHA，确认旧指针未变。

检查没有运行、排队或重试中的旧Workflow，再串行部署运行时并立即切新指针。指针切换失败须成对恢复旧运行时及旧指针。切换后运行真实Workflow并回读结果。Dashboard须先应用0013、0014并部署DTO，才能接受新归因及三点空建议。当前仍只发三点票面、空发行建议及空节约字段。
