# 融资台账与数据后台

入口：`/financing/data`、`/financing/debts/[id]`。

## 负债模型

- 品种目录以 `src/lib/financing/debt-types.js` 为唯一配置，不建目录表。基类 `financing.debt` 存通用金额、利率和生命周期字段，品种表只存专属字段。
- `id bigint` 来自 `debt_id_seq`。`bond`、`income_certificate`、`income_right`、`refinancing`、`swap_facility` 用 PostgreSQL 原生 `INHERITS`。同业拆借和集团借款没有专属字段，直接存基类。
- 浮动与固定收益凭证在数据后台合并为“收益凭证”，以 subtype 保留仪表盘筛选维度。
- `total_amount = amount + interest_payable`、`term_days`、`status` 是 stored generated columns，页面不可写。
- 状态由 `debt_status_as_of` 按沪时当日计算：关闭日已到为关闭；结清日或到期日已到为到期；生效日（缺失用起息日）或起息日未到为未生效；其余为存续；日期全缺为未生效。`debt_overview`、数据后台和负债详情用当日状态，不依赖生成列里写入时的旧状态。
- `income_certificate.subscription_date`、`redemption_date` 为认购日和兑付日，`maturity_date` 缺失时由数据库取兑付日前一工作日（周一至周五）。简称用产品名称并去掉发行人全称，“吉祥/财气东来 + 序号”统一为“吉祥231号收益凭证”“财气东来1918号收益凭证”。
- `refinancing.name` 由触发器和约束固定为“转融资”，对手方、市场、日期留在各自字段。
- `client_id` 为单客户关联，继承子表各自装外键。识别规则、自动建档和人工维护见 [客户与授信关联](clients.md)。
- 负债与融资项目已解除关联，最终 schema 不含项目外键。
- 继承子表不继承主键、唯一约束和外键，因此保留：事务级 advisory lock 加触发器保证跨父/子表 ID 全局唯一；触发器校验现金流引用并在删除负债时级联清理；覆盖继承、计算列、序列、视图和触发器的兼容测试。

## 现金流、余额和视图

- `cashflow` 统一保存本金、利息、费用和补充流，主键 `(debt_id, sequence)`，不建品种专属 schedule。
- `balance_snapshot` 以 `(as_of_date, debt_type, subtype)` 保存历史余额。
- `monthly_financing_metrics` 固化 2021 年以来已结束月份的余额、加权融资利率和加权剩余期限。migration 一次回填，之后线上导入和周报 RPC 只惰性补缺失的已结束月份，已存历史不变，当前报告月份实时计算。重建全部历史指标属管理员显式维护。衍生刷新失败不得把导入标记成功。
- 常用读取优先用 `debt_overview`、`cashflow_overview`、`data_overview` 或明确的集合查询。页面数据缺口先评估视图或集合查询，不新建冗余汇总表。
- `liability_weekly_report_runs` 只存报告日、R2 key、来源清单、缺失模块和内容哈希，完整报告在 R2，见 [负债周报](liability-report.md)。

## 月度财务数据

- `financial_monthly_data` 按自然月末 `period_end` 主键，一月一行，无指标定义表。基础列（亿元，空值为缺失，可分次补全）：`net_capital` 净资本、`securities_net_assets` 证券净资产、`group_net_assets` 集团净资产、`total_assets`、`total_liabilities`、`agency_brokerage_funds` 代理买卖证券款。新增基础指标通过 migration 加列，派生指标优先用数据库计算列。
- `asset_liability_ratio` = 总负债/总资产。`adjusted_asset_liability_ratio` = （总负债−代理买卖证券款）/（总资产−代理买卖证券款）。两者是 stored generated columns，存小数比率，页面转百分比。缺基础金额或分母为零时为 NULL。
- 基础金额非负，代理买卖证券款不超过已填的总资产或总负债。证券净资产独立录入，页面提示它与“总资产−总负债”的勾稽差额。集团净资产是独立主体口径，不与证券公司资产负债混用。
- `finance_parameters_as_of(date)` 返回截至对应日期最近的非空数据：净资本截至上月末，证券/集团净资产截至上年末，其他列截至报告日。结果保留真实数据日期，允许沿用更早月份并由缺口提醒标注，不使用统计日之后的数据。
- 修订历史月份不影响其他月份，也不改写已保存的 R2 周报快照，需要显式重新生成。
- 旧 `finance_parameters`（含原手工比率和来源）是只读迁移档案，月度维护只写新表。

## 数据访问与 RLS

当前 Auth0 模式下，浏览器经同源 `/financing/data/api`，由 Worker 编译字段白名单并通过 Hyperdrive 查询融资 schema。生产未启用 Neon 托管 Data API。身份与权限通则见 [SECURITY](../SECURITY.md)。

- 只暴露 `financing` schema，数据库角色为 `authenticated`。可编辑表须同时进入 `src/lib/financing/data-admin.ts` 白名单、显式 GRANT 和按操作划分的 RLS policy。
- 写入白名单为各负债品种表、`financial_monthly_data` 和 `debt_limit_configs`。现金流和历史余额不展示。
- RLS 按 `financing.data:read/create/update/delete` 和事务内验证的身份校验，导入单独用 `financing.data:import`。
- 更新和删除携带 `updated_at` 做乐观并发检查，主键和计算列只读。
- 负债周报通过固定的 `liability_weekly_report_data(date)` RPC 聚合融资数据，并通过只读视图 `liability_market_rate_observations` 读 `public.edb` 的原始市场观测。两者只对 `authenticated` 开放。`monthly_financing_metrics` 与 `public.edb` 本身不直接开放。

## Excel 导入

借入资金汇总表在浏览器 Web Worker 解析 `.xlsx`（上限 10 MB），只提交 JSON，不用 Workflow 或后台任务轮询。线上只导入增量：

1. 同一 POST 接口先发 `action=index`，读取现有负债身份、余额键和数据版本。
2. 浏览器本地筛出候选新增，再发 `action=commit`。只提交新增负债、现金流和新余额日期，JSON 上限 16 MB。
3. 服务端在 advisory lock 内检查索引版本并去重。自动建新客户，并一并提交负债、现金流、余额和缺失月度指标。数据错误整体回滚，索引版本变化要求重试。

规则：

- 按稳定业务身份匹配的历史负债及其现金流全部保留，含金额、利率、生命周期日期和人工客户关联。唯一匹配产品的到期日修订不产生新负债，重复身份拒绝导入。
- 只为新增负债插入现金流。历史余额按日期/品种键冲突跳过，与新工作簿不同只提示管理员维护，不覆盖。工作簿自身的分项与合计硬校验。
- 请求结果未知时重新取索引再导入，不重放旧增量。
- 无法识别的非空工作表、业务金额或日期无效、孤儿现金流拒绝导入。
- 互换便利“正回购日均余额（元）”中的文字按说明保留，跳过数值校验，成功后提示。
- 说明段落不是业务记录，跳过并在导入后提示。包括：发行失败且无金额的收益凭证，债券发行及兑付说明，集团可转债说明，含零金额占位或重复的说明行。
- 遇到说明段落即清除前一负债关联，其后孤立的现金流拒绝导入。
- 无金额、无日期的说明型负债在 JSON 接口和 CLI 都被拒绝。
- `scripts/financing/import-debts.mjs` 与 HTTP 接口复用同一个原子 importer。
- 映射或口径变化先 `pnpm financing:db:import -- --dry-run`，对账数量、金额、日期范围、重复 ID 和孤儿引用。真实业务日期、余额和笔数不写进文档或仓库，验证用未提交的本地样本或测试夹具。
- SQLite 只是一次性迁移来源，目标负债非空时迁移脚本拒绝覆盖。先 `pnpm financing:db:migrate:sqlite -- --dry-run`。

## 数据后台页面

- 借入资金汇总表导入只对有 `financing.data:import` 权限的用户显示，置于财务指标模块之前，是该页最高优先级的操作。
  - 选定文件后显示名称和大小。按钮依次为解析中、核对中、提交中，笔数和错误走全局消息层，不显示虚构的百分比或任务历史。
  - 连接故障可能使结果未知，提示重新核对后重试，不声称未提交。
- 月度财务数据按月份切换，以紧凑卡片展示当月六项基础金额和两项只读比率，位于默认的“数据管理”标签页。右下角加号新增或补录月份，编辑本月可修订任意历史月份，月份编辑时只读，同月不可重复新增。弹窗预览比率和证券净资产勾稽差额，保存后就地更新该月份，失败保留输入。
- 负债各品种通过 header 的真实 URL 标签页进入，收益凭证合并固定和浮动子类。科创债、私募债、收益权转让、互换便利不显示标签，实体与深链编号保留。
- 默认按起息日倒序、ID 倒序稳定分页，每页 25/50/100 条（默认 50）。列头菜单提供升降序、默认排序、隐藏，以及按文本、数值范围、日期范围或状态/收益类型筛选。视图菜单切换列。筛选、排序、页码都保留在 URL。
- 默认“未到期”以沪时当日判断：到期日为空或晚于当日，且未在当日或之前结清、关闭。包含未生效负债，到期日为当日不纳入。
- 点击行进入同路径的 `entry=<id>` 编辑页，新增用 `entry=new`，共用编辑组件。主键、计算列和状态不可写，转融资简称固定。新增、更新、删除分别校验权限，更新和删除携带原 `updated_at` 并限定当前品种，删除二次确认，返回时保留列表筛选与排序。
- Excel 导出按当前品种、筛选和排序逐页拉取全部记录，不只导当前页。用 ExcelJS 生成，金额与百分比为数值单元格，日期为日期单元格。

## 数据库变更要点

- `0036_debt_live_status.sql` 保留生成列及 `debt_overview` 列顺序，只替换读取状态的表达式。必须先于使用状态函数的应用部署执行。
- `0037_debt_delete_cascade.sql` 让现金流清理触发器以函数所有者执行，固定 `search_path` 并撤销 `PUBLIC` 和 `authenticated` 的直接执行权。数据编辑角色不获得现金流表或触发器权限，删除仍受 RLS 和并发校验控制。

## 说明型历史误导入维护

`scripts/financing/cleanup-debt-narratives.mjs` 默认只读盘点。候选限于：明确的流程说明、零本金和利息、全部日期及专业字段为空、无客户关联、无现金流的债券。

写入须提供人工核对后的 `--plan=<JSON>`、新备份路径 `--backup=<绝对路径>` 和 `--apply`，`--rollback` 可演练。候选完整行变化即停止。事务使用导入维护锁，并核对其余负债整行、现金流、历史余额和月度指标的指纹。备份不提交仓库。
