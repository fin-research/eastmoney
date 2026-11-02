# Gateway 开发与交付

依赖由[根 workspace](../../pnpm-workspace.yaml)统一管理，安装与升级见[根 README](../../README.md#开发)。

Gateway 是独立 Hono Worker。Auth0 管理用户、角色与成员关系，Gateway 负责 JWT 校验、授权缓存、账号目录和路由权限。认证规则见 [AUTH](../../docs/AUTH.md)，AI 转发见 [AI](AI.md)，MCP 见 [MCP](MCP.md)。

## 代码与契约

- `src/app.ts`：Hono 路由、公开与保护分流、SvelteKit 数据请求错误协议。
- `src/tokens.ts`、`session.ts`：Auth0 JWKS 与 JWT 校验、浏览器 Bearer、遗留 Cookie 清理。
- `src/lib/server/authorization.ts`、`permission-cache.ts`：JWT 角色快照、权限检查、授权 JSON 缓存。缓存用命名 Cache API `eastmoney-permissions-v1`，TTL 3600 秒，不需要 KV、Durable Object 或数据库。
- `src/lib/permissions.ts`、`route-permissions.ts`、`src/lib/server/permission-policy.ts`：权限目录与路由策略。前两份由 `node scripts/sync-dashboard-contracts.mjs` 同步到 Dashboard，`--check` 检测漂移。
- `src/policy.ts`：页面与 API 的路径归一、匿名 CSR 外壳白名单 `CLIENT_PAGE_ROUTES`，以及 `/financing-model/research` 到 `/financing-model` 的权限映射。
- `src/identity-service.ts`：私有 `IdentityService`，提供账号目录、MCP 授权桥接和角色配置。公网 `/api/management/people` 由 Gateway 直接处理，不经 Dashboard。
- `src/data.ts`：Data 公开资源，以及 GraphQL 中 Choice 字段的判定。
- `src/forward.ts`：删除外部凭据与身份头，生成版本化 UTF-8 Base64URL 上下文。该头不是认证凭据，信任来自命名 Service Binding 的可达性。

Dashboard 只在 `GatewayDashboard` 解析上下文，Data 只在 `GatewayData` 消费授权结果。`InternalData` 供 Dashboard 与 Ingest 机器调用。两个后端的入口约束见 [ARCHITECTURE](../../docs/ARCHITECTURE.md#运行单元与生产入口)。

## 配置与本地验证

```sh
pnpm check         # typegen、typecheck、test
pnpm deploy:dry
git diff --check
```

公开 origin、Auth0 issuer、audience、客户端 ID 和 `AUTH0_MACHINE_CLIENT_IDS` 在 [wrangler.jsonc](../wrangler.jsonc) 的 vars 中。运行时 Secret 为 `AUTH0_MANAGEMENT_CLIENT_SECRET` 和 `CF_AIG_TOKEN`。

联调：先构建 Dashboard，再运行 `node scripts/verify-integration.mjs`。它执行真实的 SvelteKit 与 Data handler，Auth0、数据库和业务上游用模拟实现。默认使用同级 Dashboard 与 Data，其他工作树用 `DASHBOARD_CHECKOUT`、`DATA_CHECKOUT` 指定。

真实登录与只读探针：`pnpm auth:verify`，流程见 [AUTH](../../docs/AUTH.md#真实登录与只读验证)。

- `AUTH_TEST_ENV_FILE` 指定 `.env` 路径。
- `--ai` 检查 AI 转发，会执行三次小型模型生成，见 [AI](AI.md)。
- `--refresh-permissions` 验证普通账号刷新共享权限缓存会收到 403，并读取其自身权限。
- `--mcp-only` 只跑 MCP 探针。

页面行为：公开首页允许匿名访问。显式带 Bearer 的首页仍验签并检查授权，读取授权失败时按匿名首页处理，不向后端传递部分授权。Dashboard 在 SvelteKit client init 中处理 callback、恢复 token 并安装同源 Bearer fetch。受保护页面 `ssr=false`。文件下载用授权 fetch，HTML 报告在 sandbox iframe 中预览。`/auth/session` 已移除，返回 404。

## Auth0 配置

租户管理流程见 [AUTH](../../docs/AUTH.md#auth0-本地租户管理)，应用与 Action 见 [Auth0 配置](../auth0/README.md)。

- 线上登录声明以已绑定、已部署的 `login claims` Action 为准，用 Auth0 CLI 读取绑定与 deployed version 核对。
- 权限注册到 Gateway audience。API 启用 RBAC，`token_dialect=access_token`，不启用 Add Permissions in the Access Token，JWT 只含身份与角色名称。
- 新增业务权限：按共享 AUTH 的 CLI 流程更新 API scope 和本站角色授权。发布后用管理员刷新缓存，运行 `pnpm auth:verify -- --refresh-permissions` 并读取受影响接口。其他节点按缓存 TTL 更新。

## 生产交付

只有 Gateway 持有 `eastmoney.hasbai.xyz/*`。Dashboard 与 Data 的默认入口返回 404。

1. 被绑定方先发布。Dashboard、Data、Quant 的命名 entrypoint 先于 Gateway，Gateway 的 `IdentityService` 先于 Dashboard 绑定 `IDENTITY`。
2. 发布后用程序化 HTTP 检查公开访问、匿名拒绝、测试账号，以及后端 origin 无法绕过 Gateway。
3. 回读 Worker 版本。

Quant 线上推理与静态报告的发布见 [ONLINE_INFERENCE](../../quant/docs/ONLINE_INFERENCE.md)。

## 错误语义

- 私有 binding 抛错返回 503 `BACKEND_UNAVAILABLE`，日志记服务、路由模板、方法和失败原因。业务后端正常返回的校验、权限、冲突和数据库错误保持原响应。
- Gateway 未分类异常返回 `GATEWAY_UNAVAILABLE`。Auth0 或 JWKS 的身份错误由身份层处理。
- 转发的写请求不自动重放，因为 Gateway 无法判断幂等性。
- 匿名访问保护资源返回 401。已登录但入口未登记返回 403 `ROUTE_NOT_REGISTERED`，账号被拒返回 `ACCESS_DENIED`。

## 身份接口限流

Auth0 Management API 的读取和管理 token 获取遇到 429 时，在当前请求内退避重试。

- 等待取 `Retry-After` / `X-RateLimit-Reset` 与指数退避的较大值，并加抖动。
- 最多重试 4 次，总等待不超过 10 秒。预算不够时直接返回可重试的 `IDENTITY_RATE_LIMITED`。
- 写操作（改资料、改角色）不重试。
- 日志只记阶段、次数、等待时长和状态码。

普通业务准入不调用 Management API。账号状态与角色成员在 Auth0 签发新 token 时检查。

## 历史权限表

`authorization-migrations/0001_permissions.sql` 与 `permission-repository.ts` 仅用于历史回溯。运行时不读写这些表，也不删除旧数据。
