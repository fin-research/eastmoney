# Data 公共契约

字段以 [contracts.ts](../src/contracts.ts) 和生成的 [openapi.json](../src/openapi.json) 为事实来源，文档不手写端点表。生产路径保留 `/data`，本地和私有 binding 的无前缀兼容由 [routing.ts](../src/routing.ts) 维护。

上游触限时 REST 返回 `429 RATE_LIMITED` 与 `Retry-After: 60`。GraphQL 保留 HTTP 200 的字段错误，`extensions` 返回 `code=RATE_LIMITED`、`status=429`、`retryAfterSeconds=60`。限流阈值与 Choice 额度只在[项目组 Choice 文档](../../docs/CHOICE.md)维护。

## 访问权限

DM、中国货币网、东方财富网、固定行业快照和交易日历的 GET/HEAD 及对应 GraphQL 字段公开只读。Choice 通用查询要求 Auth0 登录，CAMEL 要求拆借权限。权限矩阵见[共享 AUTH](../../docs/AUTH.md#公开仅登录与业务权限)，入口见[入口与访问边界](ARCHITECTURE.md#入口与访问边界)。

GraphQL 混合查询的字段边界：Gateway 对实际选中的操作、别名和片段判断 Choice 范围，并提供字段结果。Data 照常返回公开字段，受保护字段返回 `LOGIN_REQUIRED` 错误，且不消耗匿名 Choice 额度。`InternalData` 的内部查询由机器边界覆盖。

## OpenAPI 与 MCP

资源目录 [resources.ts](../src/resources.ts) 统一声明来源、路径、输入 Zod Schema 和响应 DTO。输入校验、OpenAPI 参数和 MCP Tool 共用同一 Schema，响应复用 contracts 和 Choice table。

OpenAPI 固定 `servers: [{ url: "/data" }]`，Swagger 和 ReDoc 按 DM、Choice、中国货币网、东方财富、服务分组。Authorize 使用 Auth0 API Bearer JWT。

统一公网 MCP 为 `https://eastmoney.hasbai.xyz/mcp`，由 Gateway 处理 OAuth、工具合并和调用路由，连接与范围见 [Gateway MCP](../../gateway/docs/MCP.md)。公网 `/data/mcp` 返回 410。

Data 的 `/data/mcp` 只供 Gateway 经 `GatewayData` 调用，不列入 Data OpenAPI。Data 用 `@hono/mcp` 与官方 MCP SDK，每请求独立实例，不共享会话和用户上下文，请求体上限 64 KiB。Gateway 传入准入结果，Data 不接收用户 token。

Data 发布 22 项市场单资源查询，`health`、`config` 和 `stock_summary` 除外。资源名与 REST/GraphQL 一致，只有资讯列表在 MCP 中名为 `news_list`，避免与 Dashboard 的归档新闻详情 `news` 重名。工具返回文本及 `{ data: DTO }` 的 structuredContent，参数和字段白名单与 REST 共用契约。

## REST 与 GraphQL

GraphQL 为全部公共数据资源提供同参数、同 DTO 的薄查询层。REST 与 GraphQL 共同调用返回已校验 DTO 的 typed resolver：REST 只做 JSON 序列化，GraphQL 直接消费 DTO。

Dashboard market-briefing Workflow 经 `DATA` binding 分段读取原始资源，各模块独立采集与重试。任一必需模块失败时不归档残缺报告，见[市场点评](../../dashboard/docs/modules/market-briefing.md)。今日聚焦由 Dashboard 分别请求股票收评、DM 新闻列表和新闻详情后组装。

`pnpm graphql:snapshot YYYY-MM-DD` 按市场点评原始快照的字段结构查询生产 GraphQL。一级发行开始日和债券基础信息代码依赖前序结果，脚本按顺序做三次薄查询：交易日、主体快照、债券信息。这类编排属于客户端，不进入 resolver。单次 GraphQL 请求的上游 subrequest 预算为 40，防止别名放大到 Free 每次 invocation 50 个的上限。

所有单一上游 REST 资源先经 Zod 运行时 Schema 归一化，再输出稳定 DTO，上游多余字段不透传。列表资源返回 JSON array，对象资源返回 object，没有 `data`、`list` 等上游 envelope。业务资源支持逗号分隔的 `fields`，只返回白名单内的顶层字段，未知字段返回 422。`src/openapi.json` 由同一组 Schema 生成。

原生向前分页的 `/cfets-histories` 保留 `{ hasNextPage, rows }`，`fields` 只投影 `rows` 内字段。调用方以本页最小 `capitalTime - 1` 作为下一页 `endCapitalTime`。

`/broker-bond-registrations` 固定证券业二级行业和周报所需的申报品种，按 `startDate`、`endDate`、`pageNum`、`pageSize` 读取，保留同样的分页契约。日期范围不超过 366 天。

`stock-summary` 当日未发布时返回 404 `RESOURCE_NOT_AVAILABLE`。

### 错误诊断

上游请求或 Schema 校验失败时，错误响应除 `detail` 外还返回安全诊断对象。它含错误码、数据源、处理阶段、上游 HTTP 状态，以及限长的字段路径和收到的类型。

- DM 和 Choice 的非 2xx 响应另含 `error.upstreamResponse`：`status`、`statusText`、`contentType`、`requestId`、脱敏的 `body`（输入至多 8 KiB，输出至多 8,192 字符）和 `truncated`。读取响应体失败时附 `readError`。
- DM 业务错误含 `upstreamCode` 和 `upstreamMessage`。
- CFETS 历史 protobuf 的业务失败保存解码后的错误信封。无效 protobuf 或 JSON 保存限长的响应片段和处理阶段。
- 网络异常保存 `cause.name` 和 `cause.message`。
- Cookie、Bearer/JWT、签名参数和已知运行时 Secret 脱敏，Set-Cookie 等敏感响应头不保留。

诊断随既有错误响应返回，`InternalData` 调用方可持久化到 Workflow。

### 空数据与局部缺失

- 成功响应中的空列表、`null` 或默认列表、空行统一为 `[]`。缺少必需定位字段的空记录单行隔离并记录限长诊断，其他有效记录不受影响。非空错型、无效 JSON、HTTP 错误和 DM 业务失败仍报错，不冒充空结果。
- OMO、CFETS、国债收益率、期货、今日成交等稀疏行情字段缺失或为上游占位符时输出 `null`，不当作 0。`bond-top-case` 个别债券缺收益率时保留该行及其他有效行情。非数值错型仍返回 Schema 校验错误。
- 成交笔数、两融余额、发行规模、报价期限天数和债券分类标志允许 `null`，可选文本接受显式 `null`。空白字符串与 `--` 占位符归一为 `null`，真实零值保持零。债券代码、有效日期和分页游标必须可识别。
- 两融保留最新两条日期记录。某项余额缺失时不丢弃该日期，也不改用更早的完整记录。
- `/trading-days` 调用 Choice `tradedates`（上交所日历）确认报告日和上一交易日。一级发行不通过行业行情推断交易日。
- `/industry` 用 Choice `css` 查询报告日 31 个申万一级行业、4 个指数及当日与上一交易日成交额，不调用 `csd`。行情不完整时返回 503 供采集重试，避免写入缺行业的热力图。`tradingDates` 只为旧消费者保留，新代码用 `/trading-days`。
- 调用方对缺失值保持空值，缺分类标志时不推断分类。REST、GraphQL、MCP 共用以上 DTO。

## 变更入口

- [app.ts](../src/app.ts) 装配公共 HTTP，[http.ts](../src/http.ts) 负责错误、限长读取和 JSON 响应，[graphql.ts](../src/graphql.ts) 镜像相同资源。
- 修改字段时先扩展 Zod 契约并运行 `pnpm openapi:generate`，再同步 REST 投影、GraphQL 和[契约测试](../tests/contracts.test.ts)。
- 公共响应保留 `Cache-Control: no-store` 和既有 HTTP 状态。
- 原生 Choice 会话、协议和兼容范围见[原生协议迁移](modules/choice-native.md)。[Choice client](../src/choice/client.ts) 检查私有对象的协议版本并校验表结构。生产切换尚未执行。
- 跨仓库变更只读受影响的消费者模块，按[共享架构的变更协同](../../docs/ARCHITECTURE.md#变更协同)检查。

## 中国货币网

`/chinamoney/*` 承载中国货币网资源。SHIBOR 每次实时 POST 官方 JSON，用动态时间戳并禁止缓存，保留上游发布日期和上海发布时间。输出利率单位为百分数。Data 不换算询价 BP，也不按查询日改写发布日期。REST、GraphQL 与 MCP 共用同一校验和字段投影。

### 新闻正文分页

`GET /data/news?detail=true&pageSize=10&offset=0` 返回顶层数组，含正文 `content` 和可选 `link`。省略 `detail` 时只返回摘要。

- 正文模式的默认和上限均为 10 条，每批详情最多五个并发。任一详情失败或 ID 不匹配则整批失败。
- `offset` 为 0—90，`offset + pageSize` 不超过 100。先按日期、时间、标签筛选并去重，再分页，只取本页正文。
- 客户端跨批固定相同 `endTime`，不足一页即停止。
- 正文模式只对筛选后参与分页的摘要做一次完整契约校验，其他记录不检查无关字段。每篇正文做一次完整契约校验和 ID 匹配。
- 扫描时间无法识别时返回 503，避免误判日期范围或末页。
- REST、GraphQL `news` 和 MCP 共用参数、投影与 DTO。GraphQL 预算在列表扫描成本之外增加本批详情数。
