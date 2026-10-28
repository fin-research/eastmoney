# API 到 Cloudflare Workers 的迁移

> 历史切换与排障记录：以下版本、资源清单、主机状态和验收结论仅对应记录时点，部分说明已被后续 CAMEL、DTO 和身份变更取代。当前架构、契约和操作分别从 [AGENTS](../AGENTS.md#context-routing) 进入；不要按历史资源数量或版本号判断现状。

## 最终架构

数据入口、Hono 路由、签名、protobuf/JSON 解码、网页解析、薄 GraphQL 和上游映射
都在 TypeScript Worker 中。市场点评加工已移到 Dashboard 浏览器。Choice C++ SDK
微服务和 CAMEL 资金系统位于 office 私网。前者是专有原生 `.so` 的运行边界，后者由
Data Worker 通过独立 VPC service 接入，均不作为公共 API 暴露。

```text
Dashboard / ingest / other clients
                |
                v
  eastmoney.hasbai.xyz/data*  (eastmoney-data Worker, Free-compatible design)
       |                 |                         |
       |                 |                         `-> ordinary public fetch
       |                 |                             东方财富网页与行情
       |                 v
       |         CHOICE_RPC VPC binding
       |                 |
       |          VPC service choice
       |                 |
       |       office:127.0.0.1:8767
       |       fin-research/choice image
       v
  DM VPC binding -> VPC service dm -> office tunnel -> rest.innodealing.com

  CAMEL VPC binding -> VPC service camel -> office:10.6.88.192:7000
        |                                      |
        `-> Secret credentials + AI Gateway CAPTCHA + named Cache session
```

没有 Cloudflare Container、Durable Object 或持久化 Worker 进程。Worker 的网络等待不
计入 CPU 时间。C++ SDK 的 CPU 发生在自有 office 主机。

## 公共契约

生产 route 仍为 `eastmoney.hasbai.xyz/data*`。Worker 只去掉精确的 `/data` 前缀，
`/database`、`/data-export` 等通配符碰撞返回原有 `404 {"detail":"Not Found"}`。

保留的入口：

- 基础与文档：`/health`、`/config`、`/openapi.json`、`/docs`、`/redoc`
- DM：`/cfets`、`/cfets-histories`、`/bond-top-case`、`/futures-latest`、`/primary-issues`、
  `/omo`、`/today-trades`、`/favorite-quotes`、`/bond-infos`、`/news`、
  `/news/{article_id}`、`/wechat-articles`
- Choice：`/choice/csd`、`/choice/css`、`/choice/ctr`、`/choice/edb`、
  `/choice/data-statistics`、`/industry`
- 普通公网：`/stock-summary`、`/margin`
- GraphQL：`GET/POST /graphql`。GET 保留交互式 GraphiQL，POST 以 nullable 顶层字段
  镜像以上所有公共数据资源。REST 与 GraphQL 共同调用返回已校验 DTO 的 typed resolver，
  REST 只做 HTTP JSON 序列化，GraphQL 直接消费 DTO，不生成市场点评

`src/openapi.json` 由 `src/contracts.ts` 的 Zod Schema 生成，记录 Hono 0.5.0 的单一上游
REST 契约。所有上游返回先做运行时校验和数值/日期归一化。普通列表资源直接返回 JSON
array，对象资源直接返回 object，不透传 `data`、`list` 等上游 envelope。原生向前分页的
`/cfets-histories` 仅保留 `hasNextPage` 和 `rows`。

REST 资源支持
`fields=a,b` 顶层字段投影，字段必须属于对应稳定 DTO，未知字段返回 422。响应保持
`Cache-Control: no-store`，本地 Dashboard 的既有 CORS origin 保留。Choice 成功响应
不再套 RPC envelope。

上游错误保留结构化、安全限长的诊断字段：`error.code`、`source`、`stage`、可选的
`upstreamStatus` / `upstreamPath`，以及最多 8 个 Schema issue（字段路径、Zod 错误码、
收到的类型与最长 80 字符标量值）。诊断不得包含 DM Cookie、签名参数、完整正文或原始
响应。OMO、CFETS、期货等稀疏数值字段缺失时归一为显式 `null`。`stock-summary`
尚未发布为 404，而不是上游故障 503。

## DM 私网边界

| 项目 | 值 |
| --- | --- |
| VPC service | `dm` |
| service id | `01a04e23-e6ae-77b2-9634-8652d2afd57c` |
| 目标 | `rest.innodealing.com:80,443` |
| tunnel | `office` |
| Worker binding | `DM` |

所有 DM 请求都由 `env.DM.fetch` 发出。Worker 按旧客户端规则用 `DM_COOKIE` 中的
`device_id` 重算 MD5 签名，并解码 DM 的 JSON、deflate/gzip protobuf。代码中没有
“VPC 失败后公网直连”的回退，因此不会意外绕过内网访问要求。

## Choice RPC 边界

| 项目 | 值 |
| --- | --- |
| VPC service | `choice` |
| service id | `01a04e4c-db9a-74e0-92f5-09c19c03adc4` |
| 目标 | `127.0.0.1:8767`，HTTP |
| tunnel | `office` |
| Worker binding | `CHOICE_RPC` |

RPC 只允许五个只读方法：`csd`、`css`、`ctr`、`edb`、`datastatistics`。`start`、
`stop`、激活、回调和任意 SDK 方法均不对外暴露。服务启动时用 office 环境变量
`CHOICE_AUTH` 登录一次。遇到原客户端识别的 `userInfo` 过期码 `10001020` 时在进程内
执行一次 `manualactivate` 后重试登录。查询保持串行，并通过 SDK `releasedata` 释放
原生内存。

Worker 以 Bearer `CHOICE_RPC_TOKEN` 鉴权，并要求响应头
`X-Choice-Rpc-Version: choice.rpc.v1`。成功响应就是公共表结构：

```json
{
  "function": "CSD",
  "fields": ["code", "date", "CLOSE"],
  "rows": [{"code": "000001.SH", "date": "2026-08-28", "CLOSE": 3857.9}]
}
```

五个 `/choice/*` 与 GraphQL Choice 字段共同调用同一 typed resolver：Worker 对 RPC
响应只做一次版本检查、JSON 解码和 Choice 表结构校验，再由 REST 或 GraphQL 对外输出。
`/industry` 在同一 Choice client 之上生成行业快照。RPC 监听地址固定为 loopback，不应
添加公网 hostname。

## CAMEL 资金系统边界

| 项目 | 值 |
| --- | --- |
| VPC service | `camel` |
| service id | `01a06116-3a02-77f3-9405-cea8b5c950c9` |
| 目标 | `10.6.88.192:7000`，HTTP |
| tunnel | `office` |
| Worker binding | `CAMEL` |

CAMEL 不新增公共 `/data` 路由，只提供给后续资金业务适配器调用的内部客户端。账号和密码
分别存入 `CAMEL_USERNAME`、`CAMEL_PASSWORD` Secret。验证码图片经统一 AI Gateway
识别，鉴权 token 使用 `CF_AIG_TOKEN` Secret。登录密码按照现有网页协议做 RSA PKCS#1
v1.5 公钥加密，源码、配置、测试和日志均不出现真实凭据。

登录成功后只把 `accessToken`、`tokenName`、`deviceId`、`expiresAt` 写入
`camel-session-v1` 命名 Cache。缓存 TTL 依据服务端 JWT 的 `iat + timeout`，并预留 5
分钟换新窗口。业务请求出现已知登录失效码时清缓存、重新登录并重试一次。验证码 key
单次有效，所以每次识别失败都完整重取验证码。Cloudflare Cache API 不跨数据中心复制，
它用于降低同一 PoP 的重复登录，不作为持久会话数据库或全局锁。

## 已完成切换（2026-08-31）

1. `office` 的 `data` 容器运行 `ghcr.io/fin-research/choice:latest`，Choice 只监听
   `127.0.0.1:8767`。旧 FastAPI、旧 RPC、Caddy 和 compose 管理均已下线。
2. Worker 的 `DM_COOKIE`、`CHOICE_RPC_TOKEN` 已写入 Cloudflare Secret。Choice 账号只在
   office 的 `/home/shi/.config/eastmoney/choice-rpc.env`。
3. 部署 edge smoke 后，DM 返回预期的未授权状态，Choice 返回 200 与
   `choice.rpc.v1`，证明两条 VPC 路径都可用。
4. `eastmoney-data` 已部署，生产 `eastmoney.hasbai.xyz/data*` route 指向该 Worker。
   `/health`、OpenAPI、真实 Choice、真实 DM 新闻、行业接口和完整 Dashboard GraphQL
   均完成生产调用。
5. JP 的测试容器、镜像、env、Docker、cloudflared、VPC service 与 tunnel 已删除。
   Cloudflare 只保留 `dm`、`choice` 两个生产 VPC service。

office 的宿主 `cloudflared` 尚未在当前 SSH 环境中发现可执行文件或 systemd unit，且
`shi` 没有免密 sudo。因此 `cloudflared-office` host-network 容器暂时保留，避免切断
VPC。确认宿主服务 active/enabled 后再删除该容器，最终 Docker 才只剩 `data` 与 `wud`。

Choice 镜像由独立的 `fin-research/choice` 仓库在 `main` push 后发布到
`ghcr.io/fin-research/choice:latest`，并同时保留不可变的 commit SHA tag。office 的 WUD
按小时检查 `latest` digest 并自动更新容器。

生产 Worker 当前版本为 `65b0da08-638c-4c01-a5c1-fb8820f7dc46`。旧 FastAPI 是否停止
仍是独立运维决定，生产 `/data*` 已不再路由到它。

## VPC 故障结论

最初表现为 Wrangler 本地 remote-binding 对 DM 和 Choice 都在 10 秒超时。排查完成后：

- office 到 `rest.innodealing.com` 的 DNS、TCP、HTTPS 正常。
- `cloudflared-office` 2026.8.2 以 QUIC 注册 4 条连接。
- VPC `dm` 与 `choice` 的已部署 edge smoke 均通过。
- 生产 Worker 通过同一 binding 取得真实 DM 和 Choice 数据。

因此根因不是 office 网络、VPC service、tunnel 或容器，而是当前 Wrangler
`dev --remote`/preview 的 VPC remote-binding 行为。VPC 健康检查必须以部署到 edge 的
smoke 为准，不能把本地 preview 超时当成生产故障。

Choice CSD 还暴露过一个独立契约问题：Linux SDK 返回未补零日期（例如
`2026/8/28`）。RPC 和 Worker 均加入 ISO 日期归一化，回归测试覆盖该格式。

Choice 返回 `login count up to limit` 时，失败点是 office RPC 进程启动阶段的 SDK
`start()`，不是 Dashboard 登录。RPC 单个进程只登录一次，正常查询不会重复登录。该错误
说明同一 Choice 账号仍被另一个进程或残留会话占用，优先核对旧 FastAPI/旧 RPC 是否仍在
运行，再单实例重启 office 的 `data` 容器。Data Worker 只能透传该上游错误，不能通过重试绕过账号
会话上限。

## 剩余 CPU 边界

迁移和 VPC 已完成。历史生产证据表明普通资源为 0–7ms，而旧
`POST /market-briefing/news` 为 61ms、旧业务聚合市场报告 GraphQL 为 56ms。Dashboard 已改为
浏览器直接请求分段 REST，今日聚焦也由 Dashboard Worker 分别请求 `/stock-summary`、
`/news` 和新闻详情。旧聚焦聚合与八个 `/market-report/*` 加工路由均已删除。新的
GraphQL 只提供单资源字段，但一次多字段查询的 CPU 会在同一 invocation 内累计，因此
Dashboard 不把它作为整份报告的生产主链路。原始资源及多字段查询仍需部署后的逐路由
Trace 才能标记 Free-safe，详见 [CPU_BUDGET.md](CPU_BUDGET.md)。
