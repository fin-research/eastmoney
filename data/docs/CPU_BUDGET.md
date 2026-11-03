# Data Worker CPU 预算

Data 按单资源提供 REST 与薄 GraphQL。Workers Free 的 CPU 和 subrequest 规则以 [Cloudflare 当前限制](https://developers.cloudflare.com/workers/platform/limits/)为准。网络和 VPC 等待不计 CPU。HTTP 200 或 `outcome=ok` 不说明 CPU 预算通过。Wrangler 没有配置自定义 `limits.cpu_ms`。

## 设计边界

- 整份市场报告的 GraphQL 聚合在生产为 24–107ms，超过 Free 的 10ms。因此业务汇总留在 Dashboard，Data 路由只返回单资源。
- GraphQL 多字段查询在一次 invocation 内累计各资源的解码、校验、投影和序列化 CPU。字段数、别名、上游调用和冷启动共同决定风险。单字段的本地基准不能证明多字段安全。
- Free 每次 invocation 最多 50 个外部 subrequest 和 1,000 个内部 subrequest。GraphQL 用 `GRAPHQL_SUBREQUEST_BUDGET`（40）限制别名重复调用。新闻日期过滤的跨页扫描需单独检查。
- Workflow 的业务 step 和 sleep 不构成独立额度。经济同步把 DM 资金面放进独立子实例，见[经济指标同步](modules/economic-indicator-sync.md)。

## 验证方法

1. 用 `pnpm benchmark:cpu` 和 `pnpm check:startup` 查找本地热点。本地 Node 与启动 profile 不能替代 Cloudflare V8 isolate 的生产 invocation。
2. 部署受影响代码后，读取 Workers Trace 的 `cpuTime`、`outcome` 和实际 subrequest 数。按资源、响应规模、冷热 isolate 和典型 GraphQL 字段组合分别记录。VPC 连通性按[开发与验证](DEVELOPMENT.md#worker-验证)在 edge 测试。
3. 逐路由比较套餐限制。普通路由以 p95 不大于 8ms 为内部目标，`exceededCpu` 直接判失败。样本不足、上游未发布或缺少 Trace 时记为未验收，不外推本地数值。

[生产 CPU profiling](https://developers.cloudflare.com/workers/observability/profiling-in-production/) 可采调用栈。调用栈的累计值互相包含，不能相加，也不能当作每次请求的 CPU。采样窗口只含 idle 或无近期执行时，不作证据。

## 路由状态

下列路由在 2026-10 的生产 invocation 样本中出现超过 10ms 的调用，未通过 Free 预算验收：

| 路由 | CPU 样本 |
| --- | --- |
| `/news?detail=true`，10 条正文批次 | 16–46ms（摘要 5–25ms） |
| `/broker-bond-registrations` | 2–22ms |
| `/camel/borrowings/parse`，Excel 解析 | 4–54ms，冷登录最高 |
| `/camel/borrowings`，台账查询 | 2–13ms |
| `/mcp` 目录与查询 | 4–68ms |

其余路由没有当前版本的 Trace，同样不标记为 Free-safe。CAMEL 写接口（台账保存、PDF 上传、还款草稿）没有生产 CPU 样本。

## 优化结论

- 热点：上游 JSON 的读取与解码、Zod 校验、对象分配和垃圾回收。按日期查询要扫描上游列表，只取摘要也承担列表解码与筛选。
- 已采用：`objectProperty` 的 Zod record 校验器模块级复用。完整摘要校验只对筛选后参与分页的记录做一次。内部构造的 `{ list }`、`{ data }` 包装不再复制校验。公共边界校验保留。
- 不采用 [`@streamparser/json`](https://github.com/juanjoDiaz/streamparser-json)：解析 100 条新闻的 75KB JSON，耗时约为原生 `JSON.parse` 的 9 倍。限长 `TransformStream` 加 `Response.text()` 更慢，固定 8KiB 合并没有稳定收益。
- 生产读取保留 8MiB 上限、流式 UTF-8 解码、错误前缀脱敏和取消读取。
- 本地 workerd 对比中，优化后的非 idle 采样约少 9%。采样数不等于 invocation CPU，不作预算结论。

## 本地基准

- `pnpm benchmark:cpu`：核心路由的本地 CPU。
- `scripts/benchmark-camel.ts`：缓存会话加模拟 VPC 流接收端，10 MB 文件的 p95 约 3.5–3.9ms，只用于定位流封装开销。
- `scripts/benchmark-mcp.ts`：MCP 的 initialize、目录和无效调用，不含上游 I/O。
- `pnpm profile:workerd`：workerd 的 CDP CPU profile。
