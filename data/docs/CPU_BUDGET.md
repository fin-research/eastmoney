# Data Worker CPU 预算

Data 按单资源提供 REST 与薄 GraphQL。Workers Free 的 CPU 上限及 subrequest 规则以 [Cloudflare 当前限制](https://developers.cloudflare.com/workers/platform/limits/) 为准。不要把 HTTP 200 或 `outcome=ok` 解释为 CPU 预算通过。网络/VPC 等待时间不计 CPU。当前 Worker 不在 Wrangler 配置自定义 `limits.cpu_ms`。

## 设计边界

- Dashboard 的市场点评通过多个单资源 REST 请求获取原始材料，业务汇总留在 Dashboard。Data 不恢复旧 `/market-briefing/news`、`/market-report/*` 或整份报告 GraphQL 聚合。
- GraphQL 多字段查询在一次 invocation 中累计各资源解码、校验、投影、执行与序列化 CPU。字段数、别名、上游调用及冷启动共同决定风险。单字段本地基准不能证明多字段生产安全。
- Free 每次 invocation 最多 50 个外部 subrequest、1,000 个 Cloudflare 内部服务 subrequest。GraphQL 使用保守资源预算，不允许通过 alias 重复调用突破平台限制。新闻日期过滤的跨页扫描尤其需要单独检查。

2026-09-04 的生产 Trace 中，旧完整市场主体 GraphQL 快照五次 CPU 为 24–107ms，均超过当时 Free 10ms 上限。旧市场新闻聚合为 61ms，现已删除。这是历史架构取舍的证据，不代表当前版本各路由的验收结果。

2026-09-03 的 `/broker-bond-registrations` 六次生产调用中，四次超过当时 10ms 上限，CPU 为 2–22ms。该路由仍在使用。未取得当前版本的生产 Trace 前，不能标记为 Free CPU 安全。

Workflow 的业务 step 不代表独立额度。经济同步的 DM 资金面使用独立 `dm-funding-sync` 子实例承担六项请求与整组重试（最多 18 次上游 fetch）。主实例等待一次结果事件，取消重复状态查询。创建仍消耗主实例额度；子实例通知失败只重发已提交结果。普通步骤或 sleep 不用作重置额度的保证。主实例其他业务组及大规模无效代码二分仍须独立核查请求预算。

## 验证方法

1. 用 `pnpm benchmark:cpu` 和 `pnpm check:startup` 查找本地热点。本地 Node 与启动 profile 不能替代 Cloudflare V8 isolate 的生产 invocation。
2. 部署受影响代码后，读取 Workers Trace 的 `cpuTime`、`outcome` 和实际 subrequest 数。分别按资源、响应规模、冷/热 isolate、典型 GraphQL 字段组合记录。VPC 连通性按 [开发与验证](DEVELOPMENT.md#worker-验证)在 edge 测试。
3. 逐路由比较当前套餐限制。普通路由以 p95 ≤ 8ms 作为内部目标，`exceededCpu` 直接判失败。样本不足、上游未发布或缺少 Trace 时记为未验收，不外推本地数值。

## CAMEL 拆借适配（2026-10-16）

`node --import tsx --cpu-prof scripts/benchmark-camel.ts` 使用缓存会话与模拟 VPC 流接收端，
不调用真实资金系统。原始文件体以有大小上限的流封装 multipart，10 MB 本地 Node 样本
20 次 p95 为 3.506ms，最大 5.096ms；不代表生产预算通过。

生产版本 `51e0a53d-cd29-4f7b-a101-547d7d0f496a` 的只读 Excel 解析探针完成了真实
VPC、验证码与登录，5 行源文件因上游警告返回 422，Trace CPU 为 23ms（包含一次验证码重试）。
这次调用超过 Free 10ms 预算，不能将冷登录解析标记为 CPU 安全。2026-10-19 同版本首次登录解析 5 行成功，CPU 为 54ms，同样超预算。
复用解析校验器后的版本 `8f0b140f-0aea-4890-ae7f-01c6e04c70e8`，同一 5 行文件的六次只读解析 CPU 为
13、20、23、8、4、22ms；存在超过 10ms 的调用，不能通过 Free 预算验收。
隔离 workerd 的模拟缓存解析首次采样约 6.36ms、后续约 1.20ms；首次登录增量场景约 5.41ms。
模拟结果省略真实 VPC 和 Cache API 开销，仅用于定位，不能替代生产 Trace。更大文件的真实生产 CPU 尚未验收。

## 浏览器直连 CAMEL（2026-10-19）

浏览器改为 `/data/camel/*`，由 Gateway 直接进入 `GatewayData`，不再经过 Dashboard。
Data 版本 `e34417ac-af49-45b0-85a6-eb15d541e581` 的真实只读样本：5 条台账首次查询
13ms，后续三次均 5ms；同一 5 行 Excel 的解析为 9ms。Gateway 版本
`82eb3f45-dd45-4673-b6cb-6237a24721fd` 对应四次查询为 3、3、2、2ms，解析请求为 12ms。
这些请求均返回 200、`outcome=ok`，但仍有超 10ms 样本，不能通过 Free 预算验收。
没有执行真实台账保存、PDF 上传或还款草稿写入，写接口的生产 CPU 尚未验收。

本次本地 Node 模拟流接收端使用 `scripts/benchmark-camel.ts`，10 MB 文件 20 次样本
p95 为 3.854ms，最大 5.304ms，profile 已采集；只用于定位流封装开销，不代替生产 Trace。

## 新闻正文批次（2026-10-26）

`/data/news?detail=true&pageSize=10&offset=…` 每次最多 20 次列表扫描与 10 次正文请求，详情并发上限五个，失败时等待在途请求结束后返回错误。默认摘要契约保留。Dashboard 原市场点评 Workflow 最多顺序读取四批，不创建新闻子 Workflow。

`38b6dec` 本地 Node 模拟 10 篇、每篇 2,000 字的正文批次 30 次 p95 为 1.078ms、最大 1.602ms；启动 profile 已生成，不替代生产预算。生产版本 `b977a7e9-582b-4339-8f9a-1c0c25b2294b` 经 GatewayData 获取 2026-10-23 四批正文全部 HTTP 200、outcome=ok，40 条 ID 与摘要顺序一致；CPU 为 85、39、35、38ms。2026-10-26 当日八条正文及空末页为 34、8ms。存在超 10ms 样本，不能标记为 Free CPU 安全。批量减少 Dashboard Service Binding 调用；完整市场点评原 Workflow 的生产实跑另行验收。

### 新闻 CPU 定位与校验器复用（2026-10-26）

使用 [生产 CPU profiling](https://developers.cloudflare.com/workers/observability/profiling-in-production/) 采集真实 DM/VPC 请求的调用栈。基线版本 `47c6893f-151b-4771-94d5-0e1f7b2a841b` 的 15 秒窗口共 67ms 采样，其中 idle 11ms、垃圾回收 15ms；`readUpstreamJson` 累计 10ms、Zod `safeParse` 累计 7ms（包含 `objectProperty` 的 6ms）。签名累计约 3ms。这里是整个窗口的采样，调用栈累计值相互包含，不能相加或当作每次请求 CPU。

热点集中在上游 JSON 的读取、解码与解析、契约校验、对象分配和垃圾回收。按日期查询需要扫描上游列表；只取摘要也会承担列表解码与筛选成本。`objectProperty` 原先每次调用都创建同一个 Zod record 校验器，`4f5b1b0` 改为模块内复用，保持原有校验、返回值和错误语义，不取消公共边界校验。

固定查询 2026-10-23、相同截止时间和 offset，对四种请求各执行三轮，生产 invocation CPU 如下（单位 ms）：

| 请求 | 基线版本 `47c6893f` | 复用版本 `832eb86c` |
| --- | --- | --- |
| 10 条摘要 | 19 / 25 / 33 | 19 / 21 / 8 |
| 1 条正文 | 12 / 23 / 7 | 11 / 17 / 上游 503 |
| 10 条正文 | 25 / 23 / 30 | 20 / 上游 503 / 46 |
| 空末页 | 8 / 12 / 11 | 7 / 22 / 9 |

两次 503 不计入成功请求的 CPU 对比；`outcome=ok` 本身不能证明 HTTP 成功。相同成功请求的响应字节数一致。复用版本的 10 秒生产 profile 共 66ms 采样（idle 10ms），垃圾回收 10ms、JSON 读取累计 14ms、Zod 校验累计 13ms，仍是上述热点。样本少且存在波动，不能据此宣称整体 CPU 降低了固定比例。

隔离 workerd 使用模拟分块响应和原始 CDP CPU profile 对比，重复初始化校验器的采样从 26 个降为 1 个，垃圾回收采样从 201 个降为 149 个；复跑请求耗时没有稳定下降。它只支持去掉重复初始化这一判断，不代表真实 VPC 请求的 CPU 改善幅度。`pnpm check` 的 269 项测试、部署 dry-run、启动 profile 与 CPU benchmark 已通过。生产正文批次仍存在 20–46ms 的成功样本，尚未通过 Free 10ms 预算验收。

### 新闻校验去重与解析器对比（2026-10-26）

`c5298c3` 进一步精简新闻路径：完整摘要校验从每个扫描页移到筛选后参与分页的记录，每次只做一次；非目标记录仅检查扫描所必需的时间。时间不可识别、扫描不完整、正文 ID 不匹配仍返回错误。默认摘要的空行处理不变。内部构造的 `{ list }`、`{ data }` 包装不再做 Zod record 复制；每篇正文仍做一次公共 DTO 校验。`compactSentimentNews` 原先每条记录创建 entries、filter、fromEntries 中间数组，改为在已构造的允许字段对象上移除空值。

本地同一 workerd 使用固定两页、每页 100 条新闻及 10 篇正文，响应以 1KiB 分块，预先编码输入以排除夹具 JSON 编码开销。四轮交替运行旧版与新版，每轮各 300 次请求，完整响应 SHA256 一致。旧版耗时 865 / 773 / 762 / 757ms，新版 824 / 718 / 714 / 712ms。原始 CDP profile 的非 idle/program 采样数分别为 3697 / 3437 / 3435 / 3426 和 3344 / 3112 / 3073 / 3144，中位数约少 9%；采样数不是每次 invocation 的精确 CPU，不作为 Free 预算结论。

单独对比原生 `JSON.parse` 与 [`@streamparser/json`](https://github.com/juanjoDiaz/streamparser-json) 0.0.26：同一份 UTF-8 75,067 字节、100 条新闻的 JSON，解析对象深比较一致；四轮、每轮 2,000 次解析，原生总耗时 81–88ms，第三方库 747–758ms。此负载保留原生解析，不新增依赖。带限长 TransformStream 的 `Response.text()` 及固定 8KiB 小块合并也分别试验过；前者更慢，后者未在完整路由中提供稳定的额外收益，均未采用。生产读取仍保留 8MiB 上限、流式 UTF-8 解码、错误前缀脱敏与取消读取。

同一日期、截止时间及分页参数的生产五轮调用，基线版本 `88745306-d3be-463b-b67a-758f91497ff8`、发布版本 `1501c223-752b-41be-a305-ef0a6064ff3f` 的 invocation CPU 如下（单位 ms）：

| 请求 | 基线 | 发布后 |
| --- | --- | --- |
| 10 条摘要 | 23 / 6 / 7 / 9 / 6 | 25 / 11 / 8 / 6 / 5 |
| 10 条正文 | 30 / 20 / 23 / 20 / 上游 503 | 22 / 25 / 17 / 16 / 20 |
| 空末页 | 18 / 10 / 7 / 7 / 6 | 8 / 10 / 6 / 8 / 6 |

发布后 15 次均 HTTP 200，三个请求类型的完整响应 SHA256 分别与基线成功响应一致；基线 503 排除在成功请求比较外。样本不足以得出稳定生产提升比例，正文批次仍超 10ms。此次生产 profiler 基线窗口只采到 idle，发布版本的 profiler 请求返回无近期执行（尽管调用日志存在）；不把这两次无效采集用作热点或性能对比证据。本次热点对比使用本地原始 profile，预算结论使用上表真实 invocation CPU。

`pnpm check`（46 个文件、278 项测试）、部署 dry-run、启动 profile、CPU benchmark 和 diff 检查通过。新增测试覆盖非目标新闻的无关字段、无法识别的扫描时间，以及 JSON 混合分块/UTF-8/BOM、8MiB 边界取消和失败诊断脱敏。代码已推送 main，并部署为上述发布版本；未更改 Workflow 编排。


## Gateway 统一 MCP 入口（2026-10-26）

Gateway `/mcp` 聚合 Dashboard 与 Data；Data 的私有 `/data/mcp` 发布22项市场查询。
`7724f0b` 本地 Node 无上游 I/O 基准各100次：initialize p95 0.288ms、目录 p95 1.512ms、
无效 Choice 调用 p95 0.180ms。`pnpm check:startup` 已采集本地启动 profile；这些数值不代表生产 CPU。

生产 Data 版本 `4c5db824-918a-4905-879b-5dc041ee87c4` 经真实 CIMD 用户由 GatewayData 调用，
两次目录以及 SHIBOR、CFETS、交易日、无效 Choice 参数共六次 invocation 均 outcome=ok，
CPU 按请求时间为33、20、9、4、4、68ms。功能与上游查询通过，存在超过10ms的样本，
本次不通过 Free CPU 预算验收。未执行付费 Choice 行情批量查询或任何业务写入。
