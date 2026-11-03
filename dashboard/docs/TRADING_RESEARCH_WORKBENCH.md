# 交易研究工作台数据范围与接入口径

## 当前交付边界

交易研究工作台有八个侧栏页面，依次为：

- 总览、交易管理、市场热点、政策跟踪
- 跟踪点评、研究辅助、二级池周报、融资择时模型

交易管理的页头有交易记录、交易流程和拆借台账三个标签页。授信工作台是独立的首页一级入口。

| 数据 | 来源 |
| --- | --- |
| 交易管理 | 仓库内冻结快照 `src/lib/trading-research/demo-data.ts`，基准时点见 `demoMeta` |
| 授信 | Neon `credit`：每周在本地解析 Excel（`pnpm credit:import`），按报告日写库，浏览器经 `/api/credit` 读取。源 Excel 含受控数据，不提交 |
| 研究辅助 | Neon `public.edb`，页面经 `/api/economic-indicators` 读最近 18 个月。回填与每日增量由 Data 负责 |
| 交易流程 | D1 保存节点配置与每日调度进度。询价行、名单、备注在浏览器本地 |
| 二级池周报、融资择时 | 复用独立路由的生产页面组件和既有数据链路 |

数据来源和接入状态是工程信息，不在工作台 UI 展示。业务页只展示模块、数据基准日和业务状态。

## 页面范围

侧栏页面与页头标签都用 path 路由，不用 `?view=` 查询参数：

- `/trading-research`：总览。
- `/trading-research/trading`、`/workflow`、`/interbank-ledger`：交易管理的交易记录、交易流程、拆借台账标签页，侧栏选中交易管理。
- `/trading-research/market-hotspots`、`/policy-tracking`、`/tracking-commentary`、`/research`：市场热点、政策跟踪、跟踪点评、研究辅助。
- `/trading-research/secondary-bond-pool`：二级池周报。`/trading-research/bond` 是旧二级池报告的隐藏深链，不进导航。
- `/trading-research/financing-model`：融资择时模型。
- 授信工作台：`/credit-workbench`、`/credit-workbench/ledger`、`/credit-workbench/calendar`、`/credit-workbench/weekly`。

两个工作台共用 `WorkbenchShell`。授信的标签复用同一报表实例。

兼容入口：

- `/trading-research/credit` 转到授信工作台。`/credit-workbench/assistant`、`/credit-assistant`、`/trading-research/credit-assistant` 转到门户并打开 AI 侧栏。
- `/market-hotspots`、`/policy-tracking` 转到工作台对应子页，保留查询参数和政策锚点。研究详情的返回链接用新的政策跟踪路径。
- `/bond`、`/trading-research/bond` 与 `/financing-model` 深链保留。新运营周报用 `/secondary-bond-pool`，与工作台子路径复用同一页面组件，嵌入工作台时日期与导出操作并入页头右侧。

| 视图 | 展示 |
| --- | --- |
| 总览 | 资金存量、当日交易、最新授信可用额度、核心利率、风险事项、数据覆盖 |
| 交易管理 | 当日汇总、品种分布、对手集中度、交易筛选与明细 |
| 授信 | 一览表、日历、周报，规则见 [授信工作台](modules/credit-workbench.md) |
| 研究辅助 | “利率与资金面”主图、4 张资金利率指标卡、两组利差副图、9 类 × 4 项宏观走势卡 |
| 二级池周报 | 默认年初至最近完整周，按原版报告画布呈现图表、重仓券和跟踪重点 |
| 融资择时模型 | 原模型快照、发行窗口、人工结论和卖方观点 |

范围外：交易录入、聊天解析、凭证生成、押券校验写入、额度调整审批、审批执行与聊天发送、指标自定义。

页面不把不同基准日的数据伪装成同一时点。总览保留“多基准日”状态，各业务视图显示自身 `asOf` 或统计区间。

## 统一业务口径

### 交易

- 纳入范围只有“同业拆借（纯信用）”和“拆出（质押式回购）”，质押式回购融入不计入。
- 金额单位亿元。接口建议传十进制字符串或最小货币单位，前端不以二进制浮点作账务事实。
- 利率字段是百分数值（`1.85` 即 `1.85%`），利率变动用 bp。
- 当日成交加权利率为 `sum(amount_yi * rate_pct) / sum(amount_yi)`。纯信用占比为同业拆借成交金额除以纳入范围成交金额。
- 对手集中度按纳入范围内的当日成交金额聚合。生产接口需返回用于复核的分母、排名和统计日期。
- “待确认”只是业务状态，不等于失败或风险处置完成。

### 授信

金额、状态、日历、周报和导入规则由 [授信工作台](modules/credit-workbench.md) 唯一维护。数据在 `credit.institution`、`credit.metric`、`credit.entry`，按所选自然日继承历史字段，`credit.entry_as_of` 提供原始截面，浏览器共用 `buildCreditReport` 生成报表。融资与一级投资用量在线派生，二级净余额按业务日登记。同日重导只写变化字段，不删除重建。

### 研究

- 研究快照须含来源、文件哈希或上游批次 ID、统计区间、生成方式、规则版本、校验结果和复核状态。
- 利率值用百分数，变动用 bp。曲线带期限和观测日。
- 研究底稿未覆盖的 SHIBOR 曲线、逐日 OMO、政策原文、国内高频和海外市场数据，返回 `available: false` 与 `reason`，不用模拟数字进入正式快照。
- 规则模板输出不等同于大模型输出，也不等同于研究岗已复核结论。
- 指标代码、名称、单位、频率、区域和展示换算在 `src/lib/trading-research/economic-indicators.ts`，采集目录、回填命令、每日 Cron 和 Workflow 重试见 [Data 经济指标同步](../../data/docs/modules/economic-indicator-sync.md)。新增或替换指标时同步映射测试。
- DR001、DR007、R007 因 Choice 量化 API 不返回观测，改由 Data `GET /cfets-histories` 分页读 DM 历史，库内仍用核验后的 EDB ID 作序列代码。
- Choice 用 `IsPublishDate=1,FixDate=0`，优先取 `PUBLISHDATE` 作发布日期。
  - 下列指标缺发布日期：固定资产投资、核心 CPI、GDP 平减指数、社融存量、人民币贷款。
  - 它们按同观测期沿用工业增加值、CPI、GDP、M2 的同批发布日期，避免未发布的 `0` 占位值冒充最新数据。
- 展示换算只有两项：核心 CPI（上年同月=100）减 100 展示同比；10Y-2Y 的百分点乘 100 展示 bp。
- Choice EDB 按指标代码计次。页面挂载、刷新和重试只读 Neon，调试不得用页面挂载或循环请求验证付费 EDB。

### 交易流程

范围与视觉：

- `/trading-research/workflow` 是交易管理内的标签页。拆借、逆回购每日默认启用，交易所回购每日默认折叠。流程只有拆借、逆回购、交易所回购三条，“共通”是节点的连线属性，不是第四条流程。
- 汇合节点只有一个 ID，共用一份进度。多流程共用的连续节点同样居中，不按同名合并。衡泰补单审批分别属于各流程，进度与编辑互相独立。
- 视觉规则见 [DESIGN](../DESIGN.md#交易流程图)。

配置模型：

- `flows` 保存稳定 ID 与名称。
- `nodes` 保存稳定 ID、所属流程 ID 集合（`flowIds`）、后续节点 ID（`nextIds`）和上级条件分支。
- `nodes` 还保存任务 / 分支类型、名称、业务内容、开始 / 结束时间和可选 Lucide 图标键。
- 节点数组只作存储。业务顺序和连线完全来自 `nextIds`，不根据时间、标题、ID 或数组位置补连线。旧配置缺图标时用默认语义图标。
- 条件分支的上级须是与子节点有共同所属流程的分支，父链无环且最多四层。连线另校验端点、自环、重复连接和有向环。
- 共通节点独立于三条流程，品种折叠不隐藏它。有流程节点介于共通节点之间时不添加共通节点直连。
- 偏移量 `offset` 相对自动布局保存在配置的可选字段，询价输入框用可选 `inquiry` 字段配置，既有询价节点兼容旧配置。

编辑：

- 编辑模式下拖动节点只改布局，点击节点打开右侧编辑面板。
- 面板显示“所属流程”“前序节点”“后续节点”，可更换、增加、移除后续连接。
- 分支与品种的编辑预览不改当日激活状态，取消编辑不保存。
- 上移 / 下移交换相邻节点的实际连线，条件子树随原分支。
- 删除需确认，只删除选中节点，把其前序接到后续，直接条件子节点提升到原上级，并立即保存。新增节点插入真实连接。
- 保存失败保留草稿和保存入口。面板数字字段提供键盘与单指操作替代。

询价：

- 询价不参与完成状态和待办提醒，按账号、上海自然日和节点 ID 保存，旧记录兼容。旧 notes 内容保留为原询价记录，不强行结构化。
- 拆借字段：对手方、交易员、期限、金额（亿）、价格。逆回购省略交易员，价格为实际利率。表格无表头。
- 期限、金额、价格聚焦时显示前行有效值候选，首项为最近前值，只有 Tab 或点击才填入，留空和删除不回填。
- 键盘：Tab 选中候选并前移，末格 Tab / Enter 校验后进入下一行或追加新行，Shift+Tab 返回。拖动或 Shift+方向键选矩形，Ctrl/Cmd+C 复制 TSV，Delete / Backspace 清空选区，整行清空自动移除，Ctrl/Cmd+Backspace / Delete 删除当前记录。
- 期限须是有效正整数天数，金额大于零，价格为有效数值。校验在失焦和前移时进行，错误保留输入并标记。输入即时保存在本地。
- 名单按账号跨日期维护，支持汉字、拼音首字母和部分匹配。
- 拆借价格数字是 SHIBOR 下浮 BP，失焦显示期限天数、金额亿和负 BP。
  - 每天上海时间 11:00 后请求 `/data/chinamoney/shibor`：发布前或失败每 15 秒重试，当日数据完整后每 5 分钟刷新，页面在后台时暂停。
  - 只用当日已公布利率：利率百分数减 BP / 100。取不短于询价天数的最短标准档位（1/7/14/30/90/180/270/365 天），超过 365 天继续 BP 报价，不用昨日利率代替。
  - 原 BP 保留，焦点进入价格格时仍编辑数字。

进度与提醒：

- D1 `trading_workflow_config` 保存共享节点配置和版本。每日启用、完成和分支状态存 `trading_workflow_progress`，按用户和上海日期隔离，用 `revision` 条件写防止多设备覆盖。首次打开当日已有本地状态时同步调度字段。
- 询价行、名单、备注的本地 key 按账号与上海自然日隔离，调度进度跨设备以 D1 为准。
- 分支激活后自动展开，关闭后折叠。父分支关闭时后代不计入待办、不触发提醒，本地勾选保留，重新激活时恢复。成交、审批和任务完成由经办人选择，不随时间自动确认。
- 提醒由 Messenger 定时触发 `NotificationSource` 扫描，仅工作日。
- 扫描按上海时区的节点开始 / 结束时间、启用品种、分支和完成状态，选最近五分钟到点的任务。区间节点在开始与结束时检查。
- 事件幂等键含用户、日期、节点和时点。
- 通知类型与 email / Telegram / Web Push 渠道在管理“通知”页按用户订阅配置，浏览器关闭后仍由服务端扫描。前台不再调用 `new Notification`。
- 时间线用可见节点的显式起始时间作锚点，游标按上海时钟在锚点间插值。重复时间合并，非递增时点不作锚点，不给无时间节点创造期限。长流程通过内容区自然滚动，不用 fitView 压缩整图。

API：

- `GET /api/trading-workflow/config`：要求 `research.workspace:read`，返回 `version/flows/nodes/actorKey/canEdit`。
- `PUT /api/trading-workflow/config`：要求 `research.workflow:update`、同源和严格 Schema，只接受 `{expectedVersion,flows,nodes}`，请求体上限 300,000 字符。条件 UPDATE 原子加版本，冲突返回 409，草稿留在画布，取消后可刷新。
- `/api/trading-workflow/day`：按登录账号读写当日进度。Gateway 校验登录和 `research.workspace:read`。

## 数据分层

- 浏览器不直连数据库、Choice EDB 或 DM。授信和研究辅助由 Dashboard Worker 经 Hyperdrive 读 Neon，研究辅助只读 `public.edb`，上游只在首次本地回填和每日增量中调用。
- 交易域尚无生产数据。接入前须确定数据所有权、权限和 `/data/trading-research/*` 的 OpenAPI / Schema（目标，未实现）。首期读接口设想为 `GET /data/trading-research/overview?as_of=YYYY-MM-DD` 与 `GET /data/trading-research/trades?date=&query=&product=&status=&cursor=&limit=`。
- 新数据域不复用或交叉写入 Dashboard 现有 Neon `bond`、`financing_model` schema。

## API 契约

- `GET /api/credit`：按上海今天读取授信截面。`GET /api/credit?date=YYYY-MM-DD&month=YYYY-MM`：读指定日与月份的原始 CreditDataset，汇总、周比较、日历和预警在浏览器派生，契约见 [授信模块](modules/credit-workbench.md#接口与维护)。
- `GET /api/economic-indicators`：Dashboard Worker 经 Hyperdrive 读 `public.edb`，返回 `asOf`、`syncedAt` 和近 18 个月的 `rows`。
- 日期用上海时区的严格 `YYYY-MM-DD`，时间用含时区 ISO 8601。动态业务数据用 `Cache-Control: no-store`。
- 错误响应为 `{ "error": "可公开信息", "code": "稳定错误码" }`，不返回 SQL、文件路径和密钥。
- 响应在服务端和 Dashboard 客户端边界用 Zod 或等价 Schema 校验。字段变更先升级 `schemaVersion` 并同步契约测试。

## 验收

- 授信按明确业务日导入 Excel，核对授信长表截面、融资派生用量和周报口径。一级投资人和融资用量在线派生，未匹配关联保持缺失，来源变化先核对 [客户归属](modules/clients.md)。
- 研究数据首次由本地全量命令回填，随后由每日增量 Cron 更新。
- 交易流程验证配置 Schema、版本冲突、跨日隔离、分支启停、通知去重和权限边界。
- 核对项：交易汇总与明细求和一致、授信总额勾稽一致、研究曲线日期一致。
- 另核对：流程版本冲突可见、页面显示明确基准日、移动端仅表格区域横向滚动。

## 拆借台账

`/trading-research/interbank-ledger` 提供成交归档、逐笔进度和资金系统台账查询。ZIP 解压、Excel 全表读取、xlsx 转换、PDF 编号关联和重命名都在浏览器 Worker 完成，原件不传到 Dashboard 存储。

- 选择或拖入 ZIP 后自动解析、改名、保存到成交日期子目录并导入资金系统。上传 PDF 后只保存还款草稿，不提供提交功能。
- 目录句柄存 IndexedDB，页面加载时恢复，已有读写权限则直接复用。首次选择或权限失效时，经原生目录授权恢复后自动继续。不支持本地目录 API 的浏览器停止，不以触发下载冒充归档完成。
- Excel 是唯一业务来源：读实际单元格而非工作表 dimension，重复表头取首个完整列，冲突或分散填值停止。账号保留前导零，利率按十进制字符串除以 100。`days` 取实际占款天数，`daysPurpose` 取拆借期限，不重算利息。
- PDF 只提供成交编号和文件名简称。一个批次只接收一个 Excel、一个成交日期，所有 PDF 须与 Excel 成交编号完整对应。

`/data/camel/*` 由浏览器同源直接调用，经 Gateway 的 `GatewayData` 到 Data，不经过 Dashboard 后端。Gateway 对精确资源的 GET/HEAD 校验 `research.interbank:read`，POST 校验 `research.interbank:import` 和同源，传入专用 CAMEL 准入结果并剥离用户凭据。Data 管理 CAMEL 会话、导入查重、额度检查和台账到还款草稿的转换。文件解析与附件上传用原始文件 body、严格 MIME 和 `X-Filename: encodeURIComponent(name)`，Data 流式转为上游单文件 multipart。

本机进度与恢复：

- 进度按 Auth0 subject 和批次内容签名隔离，用浏览器持久 journal 和账号级 Web Lock。同一把锁串行覆盖本地归档和整个导入流程，取得锁后重新读取 journal。
- 本地冲突、授权失败或写盘失败都不发起资金请求。每个写请求前先保存 intent，存储失败不写入。
- 导入和草稿的未知结果通过台账恢复，已有草稿须与本批已知附件 ID 一致。未知附件上传没有 ID 时停止，不盲目重传。
- 草稿保存后只读取一次详情，确认台账关联、附件 ID 与未提交状态，不追加批次审计。跨账号切换清除当前文件视图并阻止旧批次继续请求。
