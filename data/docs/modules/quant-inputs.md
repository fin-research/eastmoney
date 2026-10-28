# 债券模型输入

Data 维护原始模型输入的日常入库和 migration。Quant 维护特征工程与模型。两融模型及其 17 字段不在此流程范围内。

## 存储和口径

- `public.edb` 保存资金利率与宏观指标。资金面与 Choice ID 对应见 `src/sync/quant-input-contract.ts`。国开债 3Y/10Y 为 `E1701708`/`E1701714`，AAA 企业债 3Y 为 `E1000413`。DR007/R007、SHIBOR O/N/1W/3M 走 DM history。

  SHIBOR 读取 `lastPrice`，不使用 DR/R 的 `weightedYield`。O/N 的 DM 参数为 `ShiborO/N`，3M 的 EDB ID 为 `E1300079`。O/N、1W 的内部存储代码为 `DM_SHIBOR_ON`/`DM_SHIBOR_1W`，不是虚构的 Choice ID。
- GDP 统一为已有 `EMM00000012` 不变价同比，Quant 按真实发布日期对齐。不得将现价同比填入此 ID。2019 年 M2/社融共 24 条上游 `PUBLISHDATE` 为空，现按人民银行原始公告日期修复（证据逐条保存在 `economic-release-evidence.ts`），只更新 NULL 日期，不改变现有值。日期是统计期首次公布日，不能证明当前修订值当日已可得，仍不是完整历史时点版本。
- `public.quant_input` 以 `(field, observation_date)` 为主键，只存非债券级行情与公司数值观察值：权益、全市场一级/二级统计、资金计划表和资金日报。`numeric_value` 非空，没有 `text_value`。缺失不入库、不填零，真实发布日期未知时为 NULL。表中没有 dataset、entity_key、逐行来源/哈希或摄取时间。相同日期的 LCR/NSFR 以资金日报覆盖本地工作簿。其余字段按下方来源和字段映射区分。
- `public.bond_issuance` 每券一行、每个发行字段一列，直接承接 Choice 发行明细、利差、真实定价和发行方式，不在 `quant_input` 重存 `issue`。`SECUCODE` 对应 `bond_code`，`ISSUE_DATE` 对应 `issue_date`。已有的 `bond_rating`、`issuer_rating`、`coupon_reference_pct`、`final_coupon_pct` 等列保留。新增 `cross_market_code`、`tenor_year`、`bond_expire_year`、`pay_per_year`、`tomrty_year`、`dec_tomrtyyear1`、`org_form`、`issuance_rating`，分别承接未独立保存的原始字段。

  `RAISEWAY` 对应 `placement_type`，`MATURITYDATE` 对应 `maturity_date`。原 `TENOR_YEAR` 与 `BOND_EXPIRE_YEAR` 分列保存，`original_tenor_years` 继续供现有查询使用。无效定价资料留在同券的四个 `quarantine_*` 列，不能作为真实定价字段进入模型。
- `public.bond_history` 只保留 `.SH/.SZ` 交易所债券的券日估值、余额、待偿年限，`.IB` 历史不再保存。`bond_code` 为 integer 八位编码：第一位沪 1/深 2，第二位正常 0、X 1、X2 2，末六位为原始六位代码。例如 `654321X2.SH → 12654321`。读入和展示时恢复前导零、补充码和交易所后缀。

  `public.bond_industry_curve` 保存行业曲线节点。两表只存计算所需观察值，导入文件路径和 SHA-256 留在运行输出，不写逐行来源字段。`bond_issuance.coupon_reference_pct` 与 `final_coupon_pct` 不互相替代。余额沿用 Choice 原始元单位，缺失不填零。
- `0008_restore_bond_date_indexes.sql` 幂等补回 `bond_history(valuation_date DESC, bond_code)` 与 `bond_industry_curve(observation_date DESC, curve_code)`。生产库已登记 `0006`，但两条日期索引缺失。不能修改或重放 `0006`。Dashboard 的业务指标按估值日期与曲线日期匹配，索引状态须在迁移后实际核对。
- 金额单位：权益总市值/成交额为元。债券发行/成交和公司金额为亿元。收益率及成交占比为百分数。发行/主体利差为 bp。公司 LCR/NSFR 为小数比率。资金计划表的 `funding_gap_1m` 与资金日报的 `static_gap_1m` 分列为不同字段。
- R2 `fund-reports/YYYY-MM-DD.html` 只解析有限的静态数字，不执行 JavaScript。日报的 `static_gap_1m` 保留原始口径。当前票面模型不读取公司资金缺口。`margin_scale_previous_trade` 保留“截至上一交易日”标签，观察索引为报告日。未经交易日历转换不能当作报告日公司余额。

## 执行与缺口诊断

原有 `status=complete|partial`、`failures` 和 `missing` 保持可读。`failures.kind=data_gap` 仅用于成功响应为空、字段未知、已存字段不全或明确无效代码。HTTP、Schema、数据库和归档异常标记为 `execution`（未分类错误也按执行异常处理）。缺口增加 `reason`、明确缺失字段及日期/代码，不填零、不丢历史记录、不把缺口改成完整。一级统计按自然日，休市日也可能有偿还，不按证券交易日历删除日期。Messenger 将纯数据缺口通知为“数据缺口”，真实执行异常继续通知“失败”。

Data 的 `HYPERDRIVE` 专用配置 `eastmoney-data-sync-fresh` 禁用查询缓存，防止写入后的复查继续返回写入前缺口，也防止用旧覆盖状态重复收费。连接到原有同一 Neon 数据库，软连接上限10、TLS require。共享缓存配置及其他 Worker 不变，无表结构迁移。资源ID以 Wrangler 为准。

存续债缺口按券日去重，分别标记整行缺失、已存字段不全和明确无效代码。仅在同一券日已有余额明确为0时豁免收益率/待偿年限，不改原NULL。未知余额仍报缺口，已到期券不作为活跃估值缺口。发行方式历史缺口标记 `outside_daily_window`，无效代码单列，不因历史待补重复每日收费。

## 日常更新

`EconomicIndicatorSyncWorkflow` 保留独立来源并行，并显式等待数据依赖：权益组等待 Choice 经济指标落库，不等待 DM 子流程；存续债估值等待发行资料组落库，与中债曲线成功与否无关。六个 Quant 业务组编排在 `src/sync/quant-input-run.ts`：

1. 通过本 Worker 既有路由/VPC adapter 拉取有限窗口的权益 CSS、债券 CTR。权益组先查库内字段覆盖和中美交易日历。仅对已收盘交易日的缺失字段，按日取 CSS 截面。额度查询须确认 `EM_CSS` 余额足够且保留共享额度。CSS 休市日可能返回前值，不得以自然日直接记为观察日。

   股债利差沿用已有 CSD `ERPMINUSM` 的数值口径：`100 / 全A PETTM - 同日 E1000180 中债10年国债收益率`，结果保留六位小数。不直接使用 CSS `ERPMINUS`，只补缺、不覆盖已有值。融资统计接口返回整个请求区间合计。一级市场在本 step 内先查 `quant_input` 已落库日期，仅对窗口内完全缺失的日期逐日查询并入库。已存在但字段不全的日期不重复调用 CTR，缺失字段列入本 step 的 `missing` 返回值。

   `ISSUE_NUM=0` 时 `WEIGHTED_COST` 无适用值，不作为字段缺口。有发行时仍要求该字段。覆盖查询失败直接报告失败，不能回退为全窗口付费请求，不把多日汇总冒充日频数据。
2. 权益行情与估值、一级市场、券商发行与利差、资金日报各用一个 durable step。每组同时完成拉取与入库。午夜一级市场和发行明细只查询上海前一日及此前的窗口，不提前采集刚开始的当日。

   发行明细的空表或明确 `10000009` 表示窗口内无匹配发行，保留历史且不记为失败。一级市场统计空结果仍报告缺口，不填零。付费来源 step 不由 Workflow 自动重试。

   每组通过返回值报告成功、失败和缺口，不另建 `quant_input_sync` 状态表。
3. 券商发行明细先在本组落库，再采集真实定价资料。原发行利差作为公共数据历史继续维护，每次最多取64只尚无利差的券。明确失效的代码登记为待处理，排除自动付费重试。尚未发布利差的有效新券继续增量重查，避免阻塞下一批。
4. 资金日报按 Choice 上交所日历回看最近14个自然日内已经结束的交易日，逐日直接 `get fund-reports/YYYY-MM-DD.html`。不提前要求刚开始的当日报告。窗口内已有报告也重新解析并幂等 upsert，以接收迟传和同日更正；缺文件逐日报告，单日读取、解析或入库失败不阻止后续日期。没有列表扫描或 ETag 比较。超过窗口的历史补录与更正使用显式回填脚本。

`bond_issuance` 随券商发行明细每日刷新。`bond_industry_curve` 的 AAA 证券公司债完整期限节点由午夜同步独立访问中债公开曲线，按日期幂等补齐，不调用 Choice。存续债估值复用资金日报的14天已结束上交所交易日历。日历在独立 durable step 返回并持久保存，恢复时直接复用该结果；估值日期裁剪为最近七个自然日且严格早于本轮日期。日期发现、已存字段不全和无效代码缺口使用同一日期集合，不依赖行业曲线已入库。日历失败或为空则报告执行异常，不回退到星期规则或曲线日期。仅补尚无整行观测的券日，每批先查共享 CSS 额度。已入库但字段不全的行由缺口结果报告，自动同步不重复付费覆盖。

没有请求/响应/版本数据库附表。有限发行响应另按[前瞻观察](issuance-observations.md)归档到 Data 自有 R2 目录，不改变这三张输入表。上游空响应或写库失败后缺口可能再次被请求，运行结果须如实报告。使用主体利差前仍须核对最新估值日、债池与曲线覆盖。

本地 `业务数据.xlsx` 的 LCR/NSFR 若比 `company` 序列更新，使用 `scripts/backfill-company-liquidity.ts` 定向补录。该脚本只读取既有工作簿、不调用 Choice，只处理明确 `--start/--end`（最长 31 天）范围内的 `company.lcr/nsfr`，遇同键数值冲突即停止，已有值不覆盖。先运行不带 `--apply` 的盘点，核对缺失键、来源 SHA 与数量。实际入库必须将盘点得到的 `--expected-source-hash`、`--expected-missing-count` 原样带入 `--apply`。

不能使用不带字段过滤的 `backfill-quant-inputs.ts --apply` 来补这两个字段。2026-09-24 定向补入 2026-09-14 至 18 日 LCR/NSFR 各 5 条。这仅更新业务指标展示源，不意味着 LCR/NSFR 进入当前票面模型。

每个并行业务 step 返回名称、状态、入库行数、失败及结构化 `missing`（日期/字段/债券代码）。一级市场还返回 `requestedDates` / `skippedDates`。缺口查询（包括 missing issuance spreads）均在所属 step 内，最后唯一 `汇总同步结果` 汇总八组结果，缺口不增加独立步骤。

常规 Workflow 保持完整日常同步路径。显式 `issuanceReplayOf` 仅恢复已归档发行响应、不取数，见[前瞻观察恢复](issuance-observations.md#显式恢复)。定向市场维护使用下列显式日期和来源脚本。`partial` 表示仍有失败来源，不等于完整模型覆盖。

Choice 的 `BondTradingStatistics` 持续返回无权限错误 `10001003`，已停用其每日自动抓取。保留已有二级成交历史、字段、读取契约和手动脚本，不用其他债市成交口径代替。office `CHOICE_AUTH` 账号开通专题授权后，可通过 `sync-quant-market.ts --sources secondary` 受控补齐窗口。日常同步不会自动恢复该来源。

一级市场 `WEIGHTED_COST` 的已有日期缺口仍独立报告。

## 一次性回填

先在数据库副本应用 `pnpm edb:db:migrate` 并验证，再对生产执行同一 migration。命令均从本仓库运行。连接通过 `DATABASE_URL` 或既有 Hyperdrive 本地环境变量注入，凭证和源文件不得提交。

```bash
# 不调用 Choice；默认盘点，--apply 只插入不存在的线上键
node scripts/backfill-quant-inputs.ts --directory /absolute/quant/data
node scripts/backfill-quant-inputs.ts --directory /absolute/quant/data --apply

# DM 全历史只需首次请求；--replay 复用已缓存数据写入生产
node scripts/backfill-quant-edb.ts --apply --dm-shibor --cache-directory /private/cache

# 2019 M2/社融显式小范围 EDB 查询结果；不自动请求其他指标
node scripts/backfill-quant-edb.ts --apply --macro-json /private/macro.json --cache-directory /private/cache

# 本地受控维护使用短期 DATA_API_BEARER_TOKEN；--replay 不再请求上游
node scripts/sync-quant-market.ts --apply --start YYYY-MM-DD --end YYYY-MM-DD --sources equity,primary,issue --cache-directory /private/cache

# 只解析已从 R2 下载的日期文件；无 --apply 时仅校验
node scripts/backfill-quant-fund-reports.ts --directory /private/fund-reports --apply

# 仅回放已缓存的债券二级历史和官方行业曲线，不请求 Choice；默认盘点
pnpm exec tsx scripts/import-bond-research-snapshots.ts \
  --csd-file /private/cache/csd-yield-remaining-post-issuance.csv.gz \
  --issuer-file /private/cache/eastmoney-daily-bonds-long.csv.gz \
  --curve-file /private/cache/securities_curve_tenors.csv
# 核对输入摘要及 migration 后，增加 --apply 执行幂等入库
```

`bond_history` 同键导入时，输入 NULL 不清除已有非空字段。输入非 NULL 的观测值按文件执行顺序更新。故重放须固定源文件与顺序，并在覆盖前核对文件摘要。重跑不重复增加主键，但可能更新数值。检查覆盖需同时核对最早/最晚观察日、字段非空数和发布日期缺失，不能只看总行数。历史工作簿缺失的公司资金缺口与主体利差不会被伪造。

2026-09-23 的受控历史回放后，生产库有 `bond_issuance` 3,490 只券、82 家发行人，`bond_history` 1,529,496 个券日、3,476 只券，覆盖 2020-11-06 至 2026-09-22。其中 1,489,405 个券日三字段齐全。`bond_industry_curve` 有 AAA 普通证券公司债一条曲线、1,434 日、22,944 个期限节点。14 只发行券没有二级历史：10 只在历史窗口前到期、2 只 Choice 代码无效、2 只发行日为最新估值日之后。

其中一只 `.BJ` 代码也不符合当前导入器交易所后缀范围。这些覆盖记录只代表该日期截面。它们不证明全部债券每日有完整估值，也不证明其他评级或次级债已有同口径行业曲线。

发布日期定向修复：`node --env-file-if-exists=.env.local scripts/repair-edb-release-dates.ts` 默认盘点，`--apply` 只更新上述 24 个键的 NULL 日期。幂等重跑，有冲突则整批回滚，不调用 EDB。

## 行业曲线历史恢复与期限纠错

`scripts/capture-broker-curve-history.ts CACHE_DIR` 只采集显式 `dates.json` 日期清单，最多2500日，
复用已校验的成功原始响应，逐日串行访问同一中债公开 `searchYc`，15秒超时、无自动重试。
该受控工具限定2019-01-01至2026-10-22，不调用Choice，不写数据库；不扩大午夜14天补偿窗口。

`scripts/restore-broker-curve-history.ts --cache-dir CACHE_DIR` 默认离线盘点；目录需保存日期清单、
`daily/YYYY-MM-DD.json` 的HTTP原文及捕获时间，以及只读冻结的 `before-rows.json`
（curve_code、curve_name、date、tenor_years、yield_pct、node_label），以及
`early-history-batch1.json`/`early-history-batch2.json` 两批公开 `queryYz` 年期原始记录。
`--apply` 才通过 `DATABASE_URL` 在单个事务写入。先检查 `manifest.json` 和 `repair-plan.json`：
普通节点只插缺口；错误短端仅按完整前镜像CAS删除，并在同事务插入经同日原文验证的正确节点。
已有正确键冲突、旧值变化、日期/曲线身份或节点不全均停止。幂等重跑应重新只读冻结前镜像，
复用原始缓存；不得拿旧计划覆盖新数据。输出及真实业务证据保存在忽略目录。

原历史下载 `startTime=2020-12-28` 不是源可得历史的下界。同源现可返回2014-01-02起的模拟回溯值。
2020-12-18发布公告的现存[转载](https://www.sohu.com/a/439052386_221675)称曲线2020-12-28推出，
历史模拟回溯至2014年。原站公告尚未定位；这不是今天返回各点版本当时已可得的证据。
稳定来源属性见 `BROKER_CURVE_PROFILE`：AAA、证券公司债、到期收益率、百分数；
首发前值属于事后模拟，`historicalVintageVerified=false`，逐点 `available_at` 未知。
`observation_date`、原文捕获时间和可核实发布日期必须分开。研究端不能仅按观察日把回溯值用于当时预测。

旧短端下载把 `queryYz` 的 `7,d;1,m;2,m;` 响应误标为7天、1月、2月；第一项实际是年数，
第二项是显示标签。恢复工具取 `searchYc.seriesData` 原始数值期限，不从标签猜单位。
四个官方短端键为0.019178、0.038356、0.083333、0.166667年；0d锚点保留原文，
现表要求正期限，不写入0d。旧三个别名的纠错键统一为0.019178、0.083333、0.166667年；原先按7/365、1/12、2/12保存的
错误别名只在同日原文及旧值等于7Y/1Y/2Y的证据齐全时定向纠错。原始错误缓存保留供追溯。

## 当前票面模型的真实定价资料

`src/sync/quant-pricing.ts` 在券商发行业务 step 内查询最近90天 SH/SZ 债券，最多64只四字段未齐的券。CSS 补取 `TENDERDATE`、`TENDERFINALCOUPON`、`ISSCORPCREDITRAT`、`TENDERANNCDATE`，依次为真实定价日、最终票面、发行时评级、定价公告日。代码统一大写。不纳入IB，不用CTR参考票面或发行日期填补真实字段。日期经校验后写入发行表日期列，未知发布日期不伪造。

定价日无效或晚于发行起始日的整组资料进入同券的 `quarantine_*` 列，不进入模型。无效代码在 `pricing_invalid_code` 标记后排除自动付费重试。有效但未公布的字段继续增量查询，缺口和失败在同一step中返回，不伪造完整覆盖。90天以前的缺口只能显式维护，不自动扫描全部历史。

已有本地元数据通过以下脚本盘点/回填，不调用Choice。只插入线上不存在的键，按代码与发行日对齐，保留已有线上值：

```bash
pnpm exec tsx scripts/backfill-issue-pricing.ts --file /absolute/issuance_pricing_metadata.csv
pnpm exec tsx scripts/backfill-issue-pricing.ts --file /absolute/issuance_pricing_metadata.csv --apply
```

当前票面模型从同一线上快照读取资金、宏观、一级/二级市场和发行表。模型输入中的 `issue` 组由 `bond_issuance` 现有列临时投影，不在 `quant_input` 存第二份发行字段。二级成交历史若过期，按缺失处理。主体利差从二级券日估值与余额计算。具体建模、标签成熟和SHAP由[Quant](../../../quant/docs/ONLINE_INFERENCE.md)负责。

## 完整窗口模型的日常输入

日常 Quant 编排的存续债估值组按上述已结束交易日集合补缺，单次最多6000个券日、每200券一批、三个CSS字段。先验证 EM_CSS 周额度，预算包含无效代码二分隔离的所有层级，并保留100000数据点。仅 `10003008` 触发拆批。单券确认无效后设置 `history_invalid_code`，其缺口继续报告，后续自动同步不再付费查询。

每个成功子批立即入库。额度报告只查询一次，不自动重试。返回 `10000009` 或其他异常即停止；仍须核验当前周、EM_CSS余额及100000数据点共享保留额。不可用则停止，不解释为债券无估值或余额不足。每次额度查询记录请求和响应时刻、尝试次数、参数、返回统计周期或错误码；不记录账户凭据及余额。

估值批次返回 `10000013` 服务异常时，保留日期、代码及错误，继续下一批。连续两批同码则停止本轮。权限、额度、传输及其他执行错误立即停止，保留已有成功数据。不拆分 `10000013` 批次，不设置无效代码标记；只有 `10003008` 允许二分隔离。到期及已知零余额债券退出后续请求，未知值保留未知。`0010_compact_quant_inputs.sql` 删除 0009 引入的请求/版本表，后续不宣称有历史来源版本。

发行方式补取`RAISEWAY,MATURITYDATE`，每日最多200只最近90日尚未检查的 SH/SZ 券。`placement_checked_at` 记录已经完成的查询，空结果不自动重复付费，后续补发需显式维护。按与估值相同的额度预算二分隔离 `10003008`，只对确认无效的单券设置 `placement_invalid_code`。有效券继续入库，未知分类仍列为缺口。

两个来源的排除标记由 `0012_bond_css_invalid_codes.sql` 新增，不互相替代。恢复代码须显式核验并清除相应标记。未知分类保持NULL，不能默认普通公募。已有成功CSS缓存用Data所有方离线脚本回放，不调用Choice：

```bash
pnpm exec tsx scripts/import-bond-placement.ts --directory /private/css-metadata --file /private/company-metadata.response.json
# 核对摘要和 migration 后，使用相同参数增加 --apply
```

脚本接受批次响应或HTTP包装器，跳过不成功批次。按已有债券发行日对齐，文件哈希留在运行输出，发行方式和到期日填入缺失的原生列。原日频快照的历史导入规则继续有效。不追溯声称历史数据具备时点版本。

合法的短斜杠日期（如 `2026/9/19`）与补零日期统一解析后落入日期列，非法日仍隔离。原响应字符串留在观察归档，未知发布时间不填充。

历史估值的显式维护按历史窗口查缺，但 `syncBondHistory` 的 `quotaDate` 必须传当前取数日期，核对当前周 CSS 额度；不能用历史窗口日期验证当前账户周期。生产日常调用默认使用本次计划日期。

### 2019—2020早期估值恢复

旧CSD下载清单显式从2020-11-06开始；该日期不是已证明的上游历史下界。
2026-10-23维护使用冻结的470只既有债、2019-01-02至2020-11-05同源返回的估值观察日，
按发行日和到期日构造应查券日。该日历不等同交易所交易日历，也不证明回溯行业曲线当时已发布。
CSD额度未获证实时不调用CSD；CSS替代方案须先明确批准完整逐日矩阵及总预算。

`capture-early-bond-history.ts` 仅执行受控清单，逐批先写请求意图，再保存原文、捕获时间及SHA。
三字段为`YIELDCNBD,BONDBALANCE,MATUCNBD`，显式`EndDate`与`CredType=1`。
每批不超过200券，不重试；连续三次明确业务失败停止，权限、限额和未知执行状态立即停止。
已落盘请求不得因重启重放；成功NULL仍是已查询结果，不能填零或删掉请求分母。

历史验证中，19申证01的`BONDBALANCE`在2019-01-21返回2200000000、2022-01-17到期后返回0。
原值对应22亿元发行额，实际单位为元；指标目录标注“亿”与响应有差异，不再乘一亿。
同券2020-11-06的CSS收益率、余额和期限与已存CSD逐值一致。

```bash
# 凭据文件与真实请求清单只留在忽略目录；先核fresh quota和完整预算，再执行采集。
pnpm exec tsx scripts/capture-early-bond-history.ts CACHE_DIR SESSION_FILE FRESH_QUOTA_FILE --execute
# 以下两步离线读取已捕获原文，不再调用Choice。
pnpm exec tsx scripts/restore-early-bond-history.ts CACHE_DIR
pnpm exec tsx scripts/restore-early-bond-history.ts CACHE_DIR --apply REVIEWED_MANIFEST_SHA REVIEWED_ROWS_SHA
```

离线恢复核对冻结矩阵、原始响应身份、哈希和每个字段分母。只向已冻结的空历史窗口插入有值记录，
全NULL留在原始缓存；apply必须绑定已审manifest与行集合SHA，任何失败/未执行单元均阻止落库。
写库事务锁定`bond_history`并复查空前镜像，任何已有键或范围冲突即回滚。
不修改发行元数据，不覆盖已有非空观察。观察日期与本次捕获时间分开，历史修订版本和逐点可得时间仍未知。

### 日常流程共享CSS额度与受限补偿

同一Workflow由独立step读取并校验一次EM_CSS周额度，持久返回原响应、捕获时间和分组预算。
权益、发行资料、存续债分别预留104、5440、162000点，合计167544点，另保留100000点。
每次CSS前核验快照未超过15分钟及组内剩余预算；过期或额度未知均停止付费请求。
快照不跨Workflow复用，也不构成账户级原子额度锁。

每次付费请求先在R2的`data-observations/css-budget/{instance}/{group}/`条件写入意图，
包含完整规范化参数、数据点数和额度捕获时间。恢复时累计全部意图，失败及执行未知也计入预算；
相同意图不重发。R2写入失败则不调用CSS。付费step保持零重试，无效代码隔离的子请求同样计点。

10月23日受控补偿仅允许实例`bond-history-recovery-1792684800000-v2`，
参数`bondHistoryRecoveryOf=economic-indicator-sync-1792684800000`。
它从原实例持久结果提取10月22日`observation_absent`券集，只运行估值组，
使用当前周CSS额度、10000点硬上限和100000点保留额；拒绝其他日期、字段、代码及付费分支。
既有不完整记录与无效代码继续列缺口，不扩为字段修复，不重跑全量业务组。

已观察到同一自然流程第一次额度查询成功、后续相同查询返回`10000009`。
共享快照减少重复额度查询；SDK后续返回空统计的底层原因仍未证实。
生产补偿与下一次自然调度分别验收，平台完成状态不代表各业务组完整。

初次补偿实例因入口不识别X2券码，在读取范围时失败，未执行额度查询或CSS。
修正后复用既有交易所券码解析器，v2保持相同原实例、日期、券集及10000点累计上限。

### 已归档曲线密集网格恢复

2026-10-23只读核对确认，1945个日期的同源`searchYc`原文每日期有106个正期限节点及一个0d锚点。
前次历史维护按17个标准期限恢复，标准矩阵完整，但1929日的89个非标准期限尚未入库，共171681键。
这些是同一发布曲线的0.1年网格及短端节点，不是新增独立债券观测或训练事件。
现行`syncBrokerCurve`已按源numeric tenor保存全部正期限，缺口来自历史维护的标准网格范围。

`restore-broker-curve-grid.ts`只离线读取现存原文。先冻结1945份原文SHA、34489行前镜像、
171681个新增键和期望206170行；不增加HTTP或Choice调用。写库必须绑定已审manifest及插入行SHA，
锁表后精确复核完整前镜像，再insert-only。401处重叠端点差异保留原库值并列示，原因仍未知。
0d仅保留原文，不写正期限表。回读逐键核验全部新增行及原34489行，保留旧修复前后镜像。

```bash
pnpm exec tsx scripts/restore-broker-curve-grid.ts prepare CACHE_DIR EXISTING_SOURCE_DIR
pnpm exec tsx scripts/restore-broker-curve-grid.ts apply CACHE_DIR REVIEWED_MANIFEST_SHA REVIEWED_INSERT_ROWS_SHA
pnpm exec tsx scripts/restore-broker-curve-grid.ts verify CACHE_DIR REVIEWED_MANIFEST_SHA
```

观测日期、2026年捕获日期及首发下界仍分开。2020-12-28以前只作为回溯模拟；
首发日期不证明今天返回的每个值在当时已可得，历史版本及逐点发布时间继续未知。

首发日期证据目前为2020-12-18发布公告的转载，原发布方公告页尚未定位。
严格时点训练不能使用首发以前的回溯曲线作为当时报价；2021年及以后可按首发下界使用，
但不得据此声称历史修订版本已验证。2019至2020年缺行业输入的原因包括真实产品尚未推出，
不能以本次补入回溯值消除该可得性边界。

完整网格验收也可使用只读`verify-broker-curve-grid-hash.ts CACHE_DIR REVIEWED_MANIFEST_SHA`。
它绑定同一已审manifest、expected及before文件SHA，在同一只读快照计算全部六字段逐行SHA256，
按日期、期限排序拼接行摘要后再计算矩阵SHA256，并单独比较原34489个精确键子集。
文本为UTF8，字段加四字节大端长度，NULL为ffffffff，浮点使用八字节IEEE754大端；
先核对Postgres与Node合同向量，再比较全行数、唯一键数、日期数及两份完整摘要。
这是完整矩阵摘要核验，不代表全量原始行已下载。单大结果曾发生Neon `25P03`，失败记录保留；
读侧游标或摘要验收均不重跑已提交的apply。

### 逐债估值同日一次补偿

午夜实例的历史组未写入，且持久失败证据明确为 `EM_CSS` 额度接口
`503/10000009` 时，登记唯一 `bond-history-recovery-{原午夜时间戳}` 实例。
复用原 `bondHistoryRecoveryOf` 分支，不重新运行其他来源，不增加 Cron 或付费套餐。
补偿在原上海日期09:00后执行，21:00截止；09:00是运营复查时点，不表示上游届时保证恢复。

补偿读取原实例终态，仅保留原 `observation_absent` 的逐日期、逐券矩阵，
最多6000个券日。已有字段不全、无效代码和新增发现不进入补偿范围。
完整分页确认原历史组没有任何付费意图后，才读取新的当周额度。
额度只查询一次，未知或不足则停止，不调用CSS；失败额度步骤在同实例重放时复用，不重新查询。
共享额度保留100000点，历史补偿含无效代码隔离的累计上限为162000点。

所有CSS意图沿用原午夜实例的历史组命名空间，参数和日期券集均受原矩阵约束。
任何已有、失败或执行未知的原付费意图均阻止自动补偿，不能换批次重发。
数据库只插入仍然缺失的完整行键；并发出现的已有键使用 `DO NOTHING`，不覆盖好数据。
官方路径由唯一实例和同日窗口排除下一午夜重叠；不得同时人工启动其他逐债恢复任务。
原10月22日固定维护入口保留独立身份限制，不扩为任意手工回填入口。

### 逐债CSS响应证据

历史组每次CSS沿用原付费意图，只读取同一次HTTP响应。意图先持久化，响应再写入
`data-observations/css-responses/{原实例}/history/{请求SHA}.json`，最后才允许解析结果入库。
响应键不在预算意图目录内。成功及错误响应记录原意图键、源X-Request-Id、CF-Ray、接收时间、HTTP状态、
完整性、字节数、原字节SHA和脱敏正文SHA。源未提供请求ID时保留null。
这些是Data收到的Choice RPC响应，不等同于SDK内存原件。

沿用成功8MiB、错误24KB限制；截断或读失败只保留有界片段，完整原字节SHA为空；片段不能授权10003008递归或无效券隔离。
正文脱敏后写R2，原字节SHA与保存正文SHA分开。归档失败单列为执行错误，立即停止历史组，
不得进入无效券隔离或重发收费请求。原付费意图仍保留，未知执行继续禁止自动重放。
旧23次请求未保存的响应无法补证。本改动不追加取数，不改变统计日、日期范围、券池或数值。

### 冻结缺字段观察

显式 `bondFieldObservationPlan` 走独立只观察分支，拒绝与发行重放或估值恢复模式混用。
实例、R2计划键及计划SHA由 `bond-field-observation.ts` 固定；调用方不能传券集或字段。
计划限83券、2026-10-23、`YIELDCNBD,MATUCNBD`共166单元，沿用原请求口径 `CredType=1`。
它先核只读精确缺口、发行状态、相关流程终态及完整共享库存；范围变化立即停止。
额度查询前条件写唯一尝试标记，成功响应先归档；付费意图也条件写入，发送前复核额度15分钟时效与操作截止时间。
最多一次额度、一次CSS；0重试、0拆分、0写库。源空、传输未知、归档失败均停止，不追取至有值。
新观察不能补证此前丢失的23次响应。真实矩阵及R2对象清单只放受控归档，不入Git测试夹具。

### 续发证券身份

`0014_bond_history_identity.sql` 定义估值证券身份表及按日期读取函数。生产启用须完成迁移、已审映射导入及消费者验收。该表与发行批次身份分开，不改发行标签或原始估值。

每项映射保存正式代码、生效日、官方文件、供应商映射和审阅摘要。代码须保留前导零、后缀和交易所；拒绝非规范的X1别名。身份映射不允许链式指向，已审身份及其端点元数据发生冲突时拒绝覆盖。

`bond_history_observations(date[])` 先筛指定日期，再按证券及日期归并。逐字段只有一个非空值时保留该实值；不同非空值列入`conflict_fields`。余额只从正式代码原行取值，不累加别名余额。别名独有报价仍保留，但不能证明合并余额。

日常采集按正式代码去重生成新请求。只有别名原行时，仍可补取尚未存在的正式代码原行。受限恢复继续使用原券日清单和实际代码，不因身份归并换码或重放旧意图。字段冲突与未知值继续报告，不填补或覆盖原NULL。

离线导入先运行 `scripts/import-bond-history-identity.ts --plan PLAN --review-sha SHA`。核对冻结元数据、官方文件及供应商映射后，增加`--apply`。命令只写身份，不取数或改估值；相同计划重复执行不增加记录。

### 公告确认的实际发行状态

`bond_issuance.actual_issuance_status` 默认 `unknown`，不改变旧候选行为。`issued`、`not_issued` 必须同时有公告 URL、PDF SHA-256、公告日和记录时间。状态独立于 Choice 无效代码标记；普通发行刷新保留状态。已核代码、发行日、期限、简称或发行人冲突时，数据库拒绝覆盖。

`not_issued` 不进入日常估值或受限恢复的收费候选，覆盖结果在 `notApplicable` 中以 `not_issued` 单列，不计为已补数据。原金额、报价、历史和无效代码标记均保留。原来源金额不能因此当作该批已完成发行额。

离线导入只读本地已审公告，不调用 Choice。默认 dry-run，使用 `scripts/import-bond-issuance-source-fact.ts --fact <fact.json> --review <review.json> --review-sha <approved-sha256> --pdf <announcement.pdf>`；确认冻结审阅 SHA、PDF SHA 和当前代码/日期/期限/发行人/品种一致后，`--apply` 仅更新状态及其证据。review 必须有与 fact 相同的 `actualIssuanceStatus`、`actualIssuanceAnnouncementDate` 以及已视觉核验的页码。迁移通过既有 `edb:db:migrate` ledger 执行。
