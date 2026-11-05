# 债券模型输入

Data 维护原始模型输入的日常入库和 migration，Quant 维护特征工程与模型。两融模型及其 17 字段不在此流程范围内。

## 存储和口径

- `public.edb` 保存资金利率与宏观指标，ID 对应见 [quant-input-contract.ts](../../src/sync/quant-input-contract.ts)。DR007、R007 和 SHIBOR O/N、1W、3M 走 DM history。SHIBOR 读 `lastPrice`，DR/R 读 `weightedYield`。O/N、1W 的内部存储码是 `DM_SHIBOR_ON`、`DM_SHIBOR_1W`，不是 Choice ID。
- GDP 统一为已有的 `EMM00000012` 不变价同比，Quant 按真实发布日期对齐，现价同比不能填入此 ID。
- 2019 年 M2/社融共 24 条上游 `PUBLISHDATE` 为空，已按人民银行原始公告日期修复，逐条证据在 `economic-release-evidence.ts`。该日期是统计期首次公布日，不能证明当前修订值当日可得，也不是完整的历史时点版本。
- `public.quant_input` 主键为 `(field, observation_date)`，只存非债券级的行情与公司数值观察值：权益、全市场一级/二级统计、资金计划表和资金日报。`numeric_value` 非空，没有 `text_value`。缺失不入库、不填零，真实发布日期未知时为 NULL。表中没有 dataset、entity_key、逐行来源/哈希和摄取时间。相同日期的 LCR/NSFR 以资金日报覆盖本地工作簿。
- `public.bond_issuance` 每券一行、每个发行字段一列，承接 Choice 发行明细、利差、真实定价和发行方式，不在 `quant_input` 重存 `issue`。主要映射：`SECUCODE` 到 `bond_code`，`ISSUE_DATE` 到 `issue_date`，`RAISEWAY` 到 `placement_type`，`MATURITYDATE` 到 `maturity_date`。`TENOR_YEAR` 与 `BOND_EXPIRE_YEAR` 分列保存，`original_tenor_years` 供现有查询使用。完整列见 [edb-migrations](../../edb-migrations)。
- 无效定价资料留在同券的四个 `quarantine_*` 列，不进入模型。`coupon_reference_pct` 与 `final_coupon_pct` 不互相替代。
- `public.bond_history` 只保留 `.SH/.SZ` 交易所债券的券日估值、余额和待偿年限，不存 `.IB`。`bond_code` 为八位整数：第一位沪 1/深 2，第二位正常 0、X 1、X2 2，末六位为原始六位代码，例如 `654321X2.SH` 对应 `12654321`。读入和展示时恢复前导零、补充码和交易所后缀。余额沿用 Choice 原始的元单位，缺失不填零。
- `public.bond_industry_curve` 保存行业曲线节点。两表只存计算所需的观察值，导入文件路径和 SHA-256 留在运行输出，不写逐行来源。
- `0008_restore_bond_date_indexes.sql` 幂等补回 `bond_history` 与 `bond_industry_curve` 的日期索引。生产库已登记 `0006` 但缺这两条索引，`0006` 不修改、不重放。Dashboard 按估值日期和曲线日期匹配指标，迁移后要实际核对索引。
- 金额单位：权益总市值和成交额为元，债券发行、成交和公司金额为亿元。收益率与成交占比为百分数，发行和主体利差为 bp，公司 LCR/NSFR 为小数比率。资金计划表的 `funding_gap_1m` 与资金日报的 `static_gap_1m` 分列为不同字段。
- R2 `fund-reports/YYYY-MM-DD.html` 只解析有限的静态数字，不执行 JavaScript。日报的 `static_gap_1m` 保留原始口径，当前票面模型不读公司资金缺口。`margin_scale_previous_trade` 保留“截至上一交易日”标签，观察索引为报告日。未经交易日历转换，它不能当作报告日的公司余额。

## 执行与缺口诊断

`status=complete|partial`、`failures` 和 `missing` 保持可读。`failures.kind=data_gap` 仅用于成功响应为空、字段未知、已存字段不全或明确无效代码。HTTP、Schema、数据库和归档异常标记为 `execution`，未分类错误也按执行异常处理。

缺口带 `reason`、缺失字段和日期/代码，不填零，不丢历史记录。一级统计按自然日，休市日也可能有偿还，不按证券交易日历删日期。Messenger 把纯数据缺口通知为“数据缺口”，执行异常通知为“失败”。

Data 的 `HYPERDRIVE` 用专用配置 `eastmoney-data-sync-fresh`，禁用查询缓存。这样写入后的复查不返回写入前的缺口，也避免依据旧覆盖状态重复收费。该配置连接同一 Neon 库，软连接上限 10、TLS require，资源 ID 以 Wrangler 为准。

存续债缺口按券日去重，分为整行缺失、已存字段不全和明确无效代码。仅当同券日余额明确为 0 时，豁免收益率和待偿年限，原 NULL 不改。未知余额仍报缺口，已到期券不算活跃估值缺口。发行方式的历史缺口标记 `outside_daily_window`，无效代码单列，历史待补不重复每日收费。

## 日常更新

`EconomicIndicatorSyncWorkflow` 保持来源并行并显式等待数据依赖，依赖见[经济指标同步](economic-indicator-sync.md#增量任务隔离与诊断)。六个 Quant 业务组编排在 `src/sync/quant-input-run.ts`：

- **权益行情与估值**：经本 Worker 既有路由和 VPC adapter 拉取有限窗口的权益 CSS。先查库内字段覆盖和中美交易日历，只对已收盘交易日的缺失字段按日取 CSS 截面。CSS 休市日可能返回前值，不能直接按自然日记为观察日。覆盖查询失败时直接报告失败，不回退为全窗口付费请求，也不把多日汇总冒充日频数据。
  - 股债利差沿用 CSD `ERPMINUSM` 的口径：`100 / 全A PETTM - 同日 E1000180 中债10年国债收益率`，保留六位小数。不直接用 CSS `ERPMINUS`，只补缺不覆盖已有值。融资统计接口返回整个请求区间的合计。
- **一级市场**：先查 `quant_input` 已落库日期，只对窗口内完全缺失的日期逐日查询并入库。已存在但字段不全的日期不重复调用 CTR，缺失字段列入 `missing`。
  - 空结果报告缺口，不填零。`ISSUE_NUM=0` 时 `WEIGHTED_COST` 无适用值，不算字段缺口；有发行时仍要求该字段，已有日期的缺口仍独立报告。
  - 午夜只查上海前一日及此前的窗口，不提前采集刚开始的当日。
- **券商发行与利差**：先落库发行明细，再采集真实定价资料。发行利差每次最多取 64 只尚无利差的券。明确失效的代码登记为待处理，不再自动付费重试。尚未发布利差的有效新券继续增量重查，避免阻塞下一批。
  - 发行明细的空表或明确的 `10000009` 表示窗口内无匹配发行，保留历史且不算失败。
- **资金日报**：按 Choice 上交所日历回看最近 14 个自然日内已结束的交易日，逐日直接读取 `fund-reports/YYYY-MM-DD.html`。窗口内已有报告也重新解析并幂等 upsert，以接收迟传和同日更正。缺文件逐日报告，单日读取、解析或入库失败不阻止后续日期。没有列表扫描和 ETag 比较。超出窗口的补录与更正用显式回填脚本。
- **中债券商曲线**：AAA 证券公司债曲线（`bond_industry_curve`）由独立步骤访问中债公开曲线，不调用 Choice，规则见[经济指标同步](economic-indicator-sync.md#增量任务隔离与诊断)。
- **存续债估值**：复用资金日报的 14 天已结束上交所交易日历。日历在独立 durable step 返回并持久保存，恢复时直接复用。估值日期裁剪为最近七个自然日，且严格早于本轮日期。日期发现、字段不全和无效代码缺口使用同一日期集合，不依赖曲线入库。
  - 日历失败或为空时报告执行异常，不回退到星期规则或曲线日期。
  - 只补尚无整行观测的券日，已入库但字段不全的行由缺口结果报告，自动同步不重复付费覆盖。

付费来源 step 不由 Workflow 自动重试。每个 step 返回名称、状态、入库行数、失败和结构化的 `missing`（日期/字段/债券代码），不另建状态表。一级市场还返回 `requestedDates` 与 `skippedDates`。缺口查询都在所属 step 内，最后的 `汇总同步结果` 汇总八组。`partial` 表示仍有失败来源，不等于完整的模型覆盖。

没有请求/响应/版本的数据库附表。有限发行响应另按[前瞻观察](issuance-observations.md)归档到 Data 自有的 R2 目录，不改变这三张输入表。上游空响应或写库失败后，缺口可能再次被请求，运行结果须如实报告。使用主体利差前，核对最新估值日、债池和曲线覆盖。

显式 `issuanceReplayOf` 只恢复已归档的发行响应，不取数，见[前瞻观察恢复](issuance-observations.md#显式恢复)。

Choice 的 `BondTradingStatistics` 持续返回无权限错误 `10001003`，已退出每日自动抓取。已有的二级成交历史、字段、读取契约和手动脚本保留，不用其他债市成交口径代替。office `CHOICE_AUTH` 账号开通专题授权后，可用 `sync-quant-market.ts --sources secondary` 受控补齐窗口。

本地 `业务数据.xlsx` 的 LCR/NSFR 比 `company` 序列更新时，用 `scripts/backfill-company-liquidity.ts` 定向补录。

- 脚本只读工作簿，不调用 Choice。只处理明确 `--start/--end`（最长 31 天）内的 `company.lcr/nsfr`，遇同键数值冲突即停止，不覆盖已有值。
- 先不带 `--apply` 盘点，核对缺失键、来源 SHA 和数量。再把盘点得到的 `--expected-source-hash`、`--expected-missing-count` 原样带入 `--apply`。
- 补这两个字段不能用不带字段过滤的 `backfill-quant-inputs.ts --apply`。
- 补录只更新业务指标展示源，LCR/NSFR 不因此进入当前票面模型。

## 一次性回填

先在数据库副本应用 `pnpm edb:db:migrate` 并验证，再对生产执行同一 migration。命令均从 Data 项目运行。连接通过 `DATABASE_URL` 或既有 Hyperdrive 本地环境变量注入，凭证和源文件不提交。

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

`bond_history` 同键导入时，输入 NULL 不清除已有非空字段，输入非 NULL 的观测值按文件执行顺序更新。重放须固定源文件与顺序，并在覆盖前核对文件摘要。重跑不重复增加主键，但可能更新数值。

检查覆盖要同时核对最早和最晚观察日、字段非空数和发布日期缺失，不能只看总行数。历史工作簿缺失的公司资金缺口与主体利差不会被伪造。回放得到的覆盖只代表该日期截面。它不证明全部债券每日有完整估值，也不证明其他评级或次级债已有同口径行业曲线。

发布日期定向修复：`node --env-file-if-exists=.env.local scripts/repair-edb-release-dates.ts` 默认盘点，`--apply` 只更新上述 24 个键的 NULL 日期。重跑幂等，有冲突则整批回滚，不调用 EDB。

## 行业曲线历史恢复与期限纠错

- `scripts/capture-broker-curve-history.ts CACHE_DIR` 只采集显式 `dates.json` 清单中的日期（最多 2500 日，限 2019-01-01 至 2026-10-22）。它复用已校验的成功原始响应，逐日串行访问同一中债公开 `searchYc`，15 秒超时，无自动重试，不调用 Choice，不写库。
- `scripts/restore-broker-curve-history.ts --cache-dir CACHE_DIR` 默认离线盘点。缓存目录需含日期清单、`daily/YYYY-MM-DD.json` 的 HTTP 原文及捕获时间、只读冻结的 `before-rows.json`（curve_code、curve_name、date、tenor_years、yield_pct、node_label），以及 `early-history-batch1.json`、`early-history-batch2.json` 两批公开 `queryYz` 年期原始记录。
- 加 `--apply` 才通过 `DATABASE_URL` 在单个事务写入。先检查 `manifest.json` 和 `repair-plan.json`：普通节点只插缺口；错误短端仅按完整前镜像 CAS 删除，并在同事务插入经同日原文验证的正确节点。
- 已有正确键冲突、旧值变化、日期/曲线身份或节点不全时停止。幂等重跑要重新只读冻结前镜像并复用原始缓存，不拿旧计划覆盖新数据。输出和真实业务证据保存在被忽略的目录。

历史可得性：

- 稳定来源属性见 `BROKER_CURVE_PROFILE`：AAA、证券公司债、到期收益率、百分数。首发前的值是事后模拟，`historicalVintageVerified=false`，逐点 `available_at` 未知。
- 观察日、原文捕获时间和可核实发布日期分开保存。研究端不能仅按观察日把回溯值用于当时的预测。
- 同源现可返回 2014-01-02 起的模拟回溯值，原下载的 `startTime=2020-12-28` 不是历史下界。首发日期 2020-12-28 的证据是 2020-12-18 公告的[转载](https://www.sohu.com/a/439052386_221675)，原公告页尚未定位。
- 2020-12-28 以前只作回溯模拟。2021 年及以后可按首发下界使用，但不据此声称历史修订版本已验证。

短端期限纠错：

- 旧下载把 `queryYz` 响应 `7,d;1,m;2,m;` 误标为 7 天、1 月、2 月。第一项实际是年数，第二项是显示标签。恢复工具取 `searchYc.seriesData` 的原始数值期限，不从标签猜单位。
- 官方短端键为 0.019178、0.038356、0.083333、0.166667 年。0d 锚点只保留原文，现表要求正期限，不写 0d。
- 旧三个别名的纠错键统一为 0.019178、0.083333、0.166667 年。原按 7/365、1/12、2/12 保存的错误别名，只在同日原文齐全且旧值等于 7Y/1Y/2Y 时定向纠错。原始错误缓存保留供追溯。

密集网格：

- 现行 `syncBrokerCurve` 按源 numeric tenor 保存全部正期限。早期历史维护只恢复 17 个标准期限，缺 0.1 年网格和短端节点。它们是同一发布曲线的节点，不是新增的独立观测或训练事件。
- `restore-broker-curve-grid.ts` 只离线读取现存原文补这些键，不发 HTTP 或 Choice 请求。`prepare` 冻结原文 SHA、前镜像、新增键和期望行数。`apply` 绑定已审 manifest 与插入行 SHA，锁表后复核完整前镜像再 insert-only。`verify` 逐键回读新增行和原有行。
- 重叠端点与库值不同时保留库值并列示。0d 只留原文，不写正期限表。

```bash
pnpm exec tsx scripts/restore-broker-curve-grid.ts prepare CACHE_DIR EXISTING_SOURCE_DIR
pnpm exec tsx scripts/restore-broker-curve-grid.ts apply CACHE_DIR REVIEWED_MANIFEST_SHA REVIEWED_INSERT_ROWS_SHA
pnpm exec tsx scripts/restore-broker-curve-grid.ts verify CACHE_DIR REVIEWED_MANIFEST_SHA
```

完整网格也可用只读的 `verify-broker-curve-grid-hash.ts CACHE_DIR REVIEWED_MANIFEST_SHA` 验收。它绑定同一已审 manifest，计算全部行的逐行 SHA256 和矩阵 SHA256，并单独比较原有精确键子集，编码合同见脚本。单次读取大结果曾触发 Neon `25P03`，读侧游标或摘要验收都不重跑已提交的 apply。

## 当前票面模型的真实定价资料

`src/sync/quant-pricing.ts` 在券商发行业务 step 内查询最近 90 天的 SH/SZ 债券，每次最多 64 只四字段未齐的券。CSS 补取 `TENDERDATE`、`TENDERFINALCOUPON`、`ISSCORPCREDITRAT`、`TENDERANNCDATE`，依次为真实定价日、最终票面、发行时评级和定价公告日。代码统一大写，不纳入 IB。不用 CTR 参考票面或发行日期填补真实字段。日期校验后写入发行表的日期列，未知发布日期不伪造。

定价日无效或晚于发行起始日时，整组资料进入同券的 `quarantine_*` 列。无效代码标记 `pricing_invalid_code` 后，不再自动付费重试。有效但未公布的字段继续增量查询，缺口和失败在同一 step 返回。90 天以前的缺口只能显式维护，不自动扫描全部历史。

已有的本地元数据用下列脚本盘点和回填，不调用 Choice。脚本只插入线上不存在的键，按代码与发行日对齐，保留已有线上值：

```bash
pnpm exec tsx scripts/backfill-issue-pricing.ts --file /absolute/issuance_pricing_metadata.csv
pnpm exec tsx scripts/backfill-issue-pricing.ts --file /absolute/issuance_pricing_metadata.csv --apply
```

当前票面模型从同一线上快照读取资金、宏观、一级/二级市场和发行表。模型输入中的 `issue` 组由 `bond_issuance` 现有列临时投影，`quant_input` 不存第二份发行字段。二级成交历史过期时按缺失处理。主体利差由二级券日估值与余额计算。建模、标签成熟和 SHAP 见 [Quant 线上推理](../../../quant/docs/ONLINE_INFERENCE.md)。

## 完整窗口模型的日常输入

存续债估值组按已结束交易日集合补缺：单次最多 6000 个券日，每 200 券一批，取三个 CSS 字段 `YIELDCNBD,BONDBALANCE,MATUCNBD`。

- 点数上限见[下文](#日常流程-css-点数上限与付费意图)。上限包含无效代码二分隔离的所有层级。
- 只有 `10003008` 触发拆批。单券确认无效后设置 `history_invalid_code`，其缺口继续报告，后续自动同步不再付费查询。
- 每个成功子批立即入库。Workflow 不读取 Choice 额度，用量在开发时规划。额度耗尽时 CSS 返回上游错误，按下一条停止本轮，缺口留待次日。
- 估值批次返回 `10000013` 服务异常时，保留日期、代码和错误，继续下一批。连续两批同码则停止本轮。权限、额度、传输及其他执行错误立即停止，保留已有成功数据。`10000013` 不拆批，不设置无效代码标记。
- 到期及已知零余额的债券退出后续请求，未知值保留未知。`0010_compact_quant_inputs.sql` 删除 `0009` 引入的请求/版本表，因此不宣称有历史来源版本。

发行方式补取 `RAISEWAY,MATURITYDATE`，每日最多 200 只最近 90 日尚未检查的 SH/SZ 券。`placement_checked_at` 记录已完成的查询，空结果不自动重复付费，后续补发需显式维护。点数上限与二分隔离同估值，只对确认无效的单券设置 `placement_invalid_code`。有效券继续入库，未知分类保持 NULL 并列为缺口，不默认为普通公募。

两个无效代码标记由 `0012_bond_css_invalid_codes.sql` 新增，互不替代。恢复代码须显式核验并清除相应标记。

已有的成功 CSS 缓存用下列脚本离线回放，不调用 Choice：

```bash
pnpm exec tsx scripts/import-bond-placement.ts --directory /private/css-metadata --file /private/company-metadata.response.json
# 核对摘要和 migration 后，使用相同参数增加 --apply
```

脚本接受批次响应或 HTTP 包装器，跳过不成功的批次。它按已有债券发行日对齐，文件哈希留在运行输出，发行方式和到期日只填缺失的原生列。原日频快照的历史导入规则继续有效，历史数据不追溯声称具备时点版本。

合法的短斜杠日期（如 `2026/9/19`）与补零日期统一解析后落入日期列，非法日期仍隔离。原响应字符串留在观察归档，未知发布时间不填充。

历史估值的显式维护按历史窗口查缺。`syncBondHistory(request, db, endDate, dates, allowedCodes?)` 不读取额度。

### 2019—2020 早期估值恢复

旧 CSD 下载清单从 2020-11-06 开始，该日期不是已证明的上游历史下界。维护用冻结的既有债清单，按发行日和到期日构造应查券日，日期来自同源返回的 2019-01-02 至 2020-11-05 估值观察日。该日历不等同于交易所日历，也不证明回溯的行业曲线当时已发布。CSD 额度未获证实时不调用 CSD。改用 CSS 须先批准完整的逐日矩阵和总预算。

`capture-early-bond-history.ts` 只执行受控清单：逐批先写请求意图，再保存原文、捕获时间和 SHA；每批不超过 200 券，不重试；连续三次明确业务失败，或遇权限、限额、未知执行状态即停止。已落盘的请求不因重启重放。成功的 NULL 仍是已查询结果，不能填零，也不能删掉请求分母。

`BONDBALANCE` 的实际单位为元（19申证01 在 2019-01-21 返回 2200000000，对应 22 亿元发行额），指标目录标注“亿”有差异。落库不乘一亿。

```bash
# 凭据文件与真实请求清单只留在忽略目录；先核 fresh quota 和完整预算，再执行采集。
pnpm exec tsx scripts/capture-early-bond-history.ts CACHE_DIR SESSION_FILE FRESH_QUOTA_FILE --execute
# 以下两步离线读取已捕获原文，不再调用 Choice。
pnpm exec tsx scripts/restore-early-bond-history.ts CACHE_DIR
pnpm exec tsx scripts/restore-early-bond-history.ts CACHE_DIR --apply REVIEWED_MANIFEST_SHA REVIEWED_ROWS_SHA
```

离线恢复核对冻结矩阵、响应身份、哈希和每个字段的分母，只向已冻结的空历史窗口插入有值记录。`--apply` 绑定已审 manifest 与行集合 SHA，任何失败或未执行单元都阻止落库。写库事务锁定 `bond_history` 并复查空的前镜像，冲突即回滚，不覆盖已有非空观察。观察日期与捕获时间分开，历史修订版本和逐点可得时间未知。

### 日常流程 CSS 点数上限与付费意图

Workflow 不读取 `EM_CSS` 额度，用量在开发时规划。`workflow-css-budget.ts` 只执行代码内的静态上限：权益、发行资料、存续债分别为 104、5440、162000 点。

- 每次付费请求先在 R2 `data-observations/css-budget/{instance}/{group}/` 条件写入意图，含完整规范化参数和数据点数。恢复时累计全部意图，失败及执行未知也计入上限，相同意图不重发。R2 写入失败则不调用 CSS。
- 付费 step 保持零重试，无效代码隔离的子请求同样计点。
- 平台完成状态不代表各业务组完整。账户额度耗尽时，CSS 返回上游错误，该组停止并保留缺口，没有同日补偿。

代码中另有一个固定身份的手动补偿（实例 `bond-history-recovery-1792684800000-v2`，原实例 `economic-indicator-sync-1792684800000`，日期 2026-10-22，上限 10000 点）。它拒绝其他日期、字段、代码和付费分支，不读取额度，不是通用手工回填入口。

### 逐债 CSS 响应证据

历史组每次 CSS 沿用原付费意图，只读取同一次 HTTP 响应。顺序是：持久化意图，把响应写入 `data-observations/css-responses/{原实例}/history/{请求SHA}.json`，最后才解析入库。响应键不在预算意图目录内。

- 成功和错误响应都记录原意图键、`X-Request-Id`、`CF-Ray`、接收时间、HTTP 状态、完整性、字节数、原字节 SHA 和脱敏正文 SHA。源未提供请求 ID 时为 null。这是 Data 收到的 RPC 响应，不是 SDK 内存原件。
- 成功响应上限 8MiB，错误响应 24KB。截断或读取失败只保留有界片段，原字节 SHA 为空，片段不能授权 `10003008` 递归或无效券隔离。
- 归档失败单列为执行错误，立即停止历史组，不进入无效券隔离，不重发收费请求。未知执行继续禁止自动重放。

### 续发证券身份

`0014_bond_history_identity.sql` 定义估值证券身份表及按日期读取的函数。生产启用须完成迁移、已审映射导入和消费者验收。该表与发行批次身份分开，不改发行标签或原始估值。

- 每项映射保存正式代码、生效日、官方文件、供应商映射和审阅摘要。代码保留前导零、后缀和交易所。映射拒绝非规范的 X1 别名和链式指向，已审身份冲突时拒绝覆盖。
- `bond_history_observations(date[])` 先筛日期，再按证券及日期归并。逐字段只有一个非空值时保留该值，不同的非空值列入 `conflict_fields`。余额只取正式代码的原行，不累加别名余额。
- 日常采集按正式代码去重生成新请求。只有别名原行时，仍可补取尚不存在的正式代码原行。受限恢复沿用原券日清单和实际代码，不因身份归并换码或重放旧意图。

离线导入先运行 `scripts/import-bond-history-identity.ts --plan PLAN --review-sha SHA`，核对冻结元数据、官方文件和供应商映射后加 `--apply`。命令只写身份，不取数也不改估值，相同计划重复执行不增加记录。

### 公告确认的实际发行状态

`bond_issuance.actual_issuance_status` 默认 `unknown`，不改变旧候选行为。`issued`、`not_issued` 须同时有公告 URL、PDF SHA-256、公告日和记录时间。状态独立于 Choice 无效代码标记，普通发行刷新保留状态。已核的代码、发行日、期限、简称或发行人冲突时，数据库拒绝覆盖。

`not_issued` 不进入日常估值或受限恢复的收费候选，覆盖结果在 `notApplicable` 中以 `not_issued` 单列，不计为已补数据。原金额、报价、历史和无效代码标记都保留，原来源金额不能当作该批已完成的发行额。

离线导入只读本地已审公告，不调用 Choice，默认 dry-run：

```bash
pnpm exec tsx scripts/import-bond-issuance-source-fact.ts --fact <fact.json> --review <review.json> --review-sha <approved-sha256> --pdf <announcement.pdf>
```

确认冻结审阅 SHA、PDF SHA，以及当前代码、日期、期限、发行人、品种一致后，加 `--apply` 只更新状态及其证据。review 须有与 fact 相同的 `actualIssuanceStatus` 和 `actualIssuanceAnnouncementDate`，以及已视觉核验的页码。迁移通过既有 `edb:db:migrate` ledger 执行。
