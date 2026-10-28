# Data 公共契约

字段以 [contracts.ts](../src/contracts.ts) 和生成的 [openapi.json](../src/openapi.json) 为事实来源。不在文档手写第二套端点表。生产路径保留 `/data`，本地和私有 binding 的 prefix-free 兼容由 [routing.ts](../src/routing.ts) 维护。身份保护见 [access-migration](access-migration.md)。

上游频率触限时 REST 返回 `429 RATE_LIMITED` 与 `Retry-After: 60`。GraphQL 保留 HTTP 200 的字段错误，并在 `extensions` 返回 `code=RATE_LIMITED`、`status=429`、`retryAfterSeconds=60`。限流阈值与 Choice 额度计划只在[项目组 Choice 文档](../../docs/CHOICE.md)维护。

## 访问权限

DM、中国货币网、东方财富网、固定行业快照及交易日日历的 REST GET/HEAD 和对应 GraphQL 字段公开只读。Choice 通用查询（含 EDB、CTR、CSS、CSD、额度统计）及 CAMEL 内部资金路径要求 Gateway 已验证的 Auth0 登录，无需额外角色权限。GraphQL 混合查询在受保护字段返回 `LOGIN_REQUIRED`，保留公开字段结果。不能通过别名或片段绕过。详细边界、机器身份及发布顺序见 [访问保护](access-migration.md)。

## OpenAPI 与 MCP

资源目录 [resources.ts](../src/resources.ts) 统一声明来源、路径、输入 Zod Schema 和响应 DTO。
输入校验、OpenAPI 参数和 MCP Tool 使用同一 Schema。响应复用现有 contracts 和 Choice table。

OpenAPI 固定 `servers: [{ url: "/data" }]`，Swagger 和 ReDoc 按 DM、Choice、中国货币网、东方财富、服务分组。
Authorize 使用 Auth0 API Bearer JWT。Gateway 不接受登录 Cookie。token 不存入本地持久存储。


统一公网 MCP 为 `https://eastmoney.hasbai.xyz/mcp`，由 Gateway 处理 OAuth、工具合并与调用路由。客户端只填写该 URL、选择 OAuth，Client ID 和 Secret 留空；不经过 Cloudflare MCP Portal。`/data/mcp` 不再作为公网入口，也不列入 Data REST OpenAPI。

Data 的 `/data/mcp` 仅供 Gateway 经命名 `GatewayData` binding 调用。Data 使用 `@hono/mcp` 与官方 MCP SDK，每请求独立实例，不共享会话或用户上下文，输入体最多64 KiB。Gateway 传入可信用户准入结果，Data 不接收用户 token。Choice 沿用有效用户准入，CAMEL 不进入 MCP。

已发布22项市场单资源查询。REST/GraphQL 的资源名称保持；MCP 资讯列表名为 `news_list`，详情为 `news_detail`，避免与 Dashboard 的归档新闻详情 `news` 重名。`health`、`config` 和不可用的 `stock_summary` 不发布。工具返回文本及 `{ data: DTO }` structuredContent，参数、字段白名单与 REST 共用契约。统一范围与连接见 [Gateway MCP](../../gateway/docs/MCP.md)。

## REST 与 GraphQL

市场点评不再由 Data Worker 加工：Dashboard market-briefing Workflow 通过私有 DATA 并行读取原始资源，
完成统一业务加工并归档定稿。浏览器只读取定稿。Data GraphQL 为所有公共数据资源提供同参数、同 DTO 的薄查询层。
REST 与 GraphQL 共同调用返回已校验 DTO 的 typed resolver。REST 只负责 HTTP JSON
序列化，GraphQL 直接消费 DTO，不生成市场点评、不拼接业务快照。

Dashboard 市场点评仍使用分段 REST，各模块独立完成采集与重试。任一必需模块失败时不归档残缺报告，见 [市场点评](../../dashboard/docs/modules/market-briefing.md)。今日聚焦的旧
`POST /market-briefing/news` 已删除，Dashboard Worker 分别请求股票收评、DM 新闻列表
和新闻详情后自行组装提示词。

`pnpm graphql:snapshot YYYY-MM-DD` 会按当前市场点评原始快照的字段结构查询生产
GraphQL。一级发行开始日和债券基础信息代码依赖前序结果。脚本按顺序执行三次薄查询：交易日、主体快照、债券信息。这种编排属于客户端，不进入 GraphQL resolver。单次
GraphQL 请求的保守资源预算为 40 个上游 subrequest，防止重复 alias 放大到 Free 计划
每次 invocation 的 50 个 subrequest 上限。

所有单一上游 REST 资源先经 Zod 运行时 Schema 归一化，再输出稳定 DTO。上游多余字段
不会透传。普通列表资源直接返回 JSON array，顶层对象资源直接返回 object，不再保留
`data`、`list` 等上游 envelope。业务资源支持逗号分隔的 `fields` 参数，只返回白名单中
明确请求的顶层字段。

未知字段返回 422。`src/openapi.json` 由同一组 Zod Schema 生成。
原生向前分页的 `/cfets-histories` 保留必要的 `{ hasNextPage, rows }` 契约，`fields`
只投影 `rows` 内字段。调用方以本页最小 `capitalTime - 1` 作为下一页 `endCapitalTime`。

券商债券申报使用 `/broker-bond-registrations`，固定证券业二级行业和周报所需申报品种，
按 `startDate`、`endDate`、`pageNum`、`pageSize` 读取，并保留相同的最小分页契约。
OMO、CFETS、国债收益率、期货、今日成交等稀疏行情字段缺失或为上游占位符时统一输出 `null`，不伪造为 0。
`bond-top-case` 的个别债券缺少收益率时保留该行和其他有效行情。非数值错型仍返回 Schema 校验错误。

上游请求或 Schema 校验失败时，错误响应除 `detail` 外还返回安全诊断对象，包含错误码、数据源、处理阶段、
上游 HTTP 状态及限长后的字段路径/收到类型。DM / Choice 的非 2xx 响应另保留 `error.upstreamResponse`：
`status`、`statusText`、`contentType`、`requestId`、脱敏 `body`（最多 8 KiB 输入、8,192 字符输出）、`truncated`，
读取响应体失败时附 `readError`。DM 业务错误另保留 `upstreamCode` / `upstreamMessage`。CFETS 历史 protobuf
业务失败保存解码后的错误信封，无效 protobuf / JSON 保存限长响应片段及处理阶段。

网络异常保存 `cause.name/message`。
Cookie、Bearer/JWT、签名参数及已知运行时 Secret 值均脱敏，Set-Cookie 等敏感响应头不保留。
这些诊断随既有错误响应返回，便于 InternalData 调用方持久化到 Workflow。成功 DTO 与 HTTP 状态规则不变。

`stock-summary` 当日尚未发布时返回 404 `RESOURCE_NOT_AVAILABLE`，不再误报 503。

### 空数据与局部缺失

- 成功响应中的空列表、`null`/默认列表及空行统一为 `[]`。缺少必需定位字段的空记录单行隔离并记录限长诊断，不拖累其他有效记录。非空错型、无效 JSON、HTTP 错误及 DM 业务失败仍报错，不冒充空结果。
- 成交笔数、两融余额、发行规模、报价期限天数及债券分类标志允许 `null`。可选文本接受显式 `null`。空白字符串与 `--` 数值占位符归一为 `null`，真实零值保持零。债券代码、有效日期与分页游标仍需可识别。
- 两融保留最新两条日期记录，某项余额缺失时不丢弃该日期、也不自动改用更早的完整记录。
- `/trading-days` 独立调用 Choice `tradedates`（上交所日历）确认报告日和上一交易日。一级发行不再通过行业行情推断交易日。
- `/industry` 仅用 Choice `css` 查询报告日 31 个申万一级行业、4 个指数及当日/上一交易日成交额，不调用 `csd`。行情不完整时返回 503 供采集重试，避免写入缺失行业的热力图。`tradingDates` 仅为旧消费者兼容，新代码使用 `/trading-days`。
- Dashboard 对缺失规模、净投放与期间比较保持空值，业务筛选所需债券分类标志缺失时不推断分类。REST、GraphQL、MCP 共用以上 DTO。

## 变更入口

- [app.ts](../src/app.ts) 负责公共 HTTP 装配。[http.ts](../src/http.ts) 负责错误、限长读取与 JSON 响应。[graphql.ts](../src/graphql.ts) 保持相同资源的薄镜像。
- 修改字段时先扩展 Zod 契约并运行 `pnpm openapi:generate`，同步 REST 投影、GraphQL 和 [契约测试](../tests/contracts.test.ts)。
- 公共响应保留 `Cache-Control: no-store`。不要改变现有 HTTP 状态或将稀疏行情伪造为零。
- Choice RPC 的版本、请求/响应和失败契约由 [Choice API](../../choice/docs/API.md) 维护。本项目的 [Choice client](../src/choice/client.ts) 负责版本检查、解析与表结构校验。
- 跨仓库变更只加读受影响消费者模块，按 [共享架构变更协同](../../docs/ARCHITECTURE.md#变更协同) 检查。

## 中国货币网

`/chinamoney/*` 专门承载中国货币网资源。SHIBOR 每次读取实时 POST 官方 JSON，使用动态时间戳并禁止缓存，保留上游发布日期及上海发布时间。输出利率单位为百分数。Data 不换算询价 BP，也不按查询日改写发布日期。REST、GraphQL 与 MCP 共用同一校验和字段投影。

### 新闻正文分页

`GET /data/news?detail=true&pageSize=10&offset=0` 返回顶层数组，包含正文 `content` 与可选 `link`；省略 `detail` 时仍只返回摘要。正文模式默认和上限均为 10 条，每批详情最多五个并发；任一详情失败或 ID 不匹配则整批失败。`offset` 为 0—90，`offset + pageSize` 不超过 100。先按日期、时间、标签筛选并去重，再分页，仅获取本页正文。客户端跨批固定相同 `endTime`，不足一页停止。REST、GraphQL `news` 和 MCP 共用参数、投影与 DTO。GraphQL 预算在列表扫描成本之外增加本批详情数。

正文模式只对筛选后参与分页的摘要执行一次完整契约校验；其他记录不检查无关的标题、标签等字段。扫描时间无法识别时仍返回 503，避免误判日期范围或末页。每篇正文保留一次完整契约校验和 ID 匹配。
