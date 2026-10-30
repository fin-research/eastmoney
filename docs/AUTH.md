# 认证与权限

本文件拥有项目组共享认证架构、权限范围与程序化验收规范。实现事实来源为 Gateway [权限目录](../gateway/src/lib/permissions.ts)、[路由策略](../gateway/src/lib/server/permission-policy.ts)、[授权入口](../gateway/src/lib/server/authorization.ts) 和 [Data 分流](../gateway/src/data.ts)。Dashboard 的权限目录是前端展示契约，不执行 JWT 或角色授权。

## 身份与权限架构

```text
浏览器 → Auth0 SPA SDK: 授权码 + PKCE / state / nonce → 内存 Access JWT
浏览器页面外壳 → Gateway → Dashboard CSR（不含业务数据）
浏览器数据 / API Authorization: Bearer
       → Gateway: Auth0 JWKS → 顶层身份 / _roles 名称 → Gateway 权限 JSON 缓存 → 路由权限
           ├─ DASHBOARD: GatewayDashboard → 业务处理
           └─ DATA: GatewayData → 单资源 REST / GraphQL
Dashboard → IDENTITY: IdentityService → Gateway 目录 / 角色权限缓存
Dashboard / Ingest → DATA: InternalData → Data
Quant → Neon 只读数据；旧 Auth0 机器 Choice 入口已退役
```

1. Auth0 管理用户、密码、邮箱验证、账号状态、角色与成员关系。管理 API 使用 `hasbai.eu.auth0.com`，登录及 API token issuer 为 `https://auth.hasbai.xyz/`。Gateway 校验 RS256、JWKS、issuer、API audience、subject、azp、iat/exp/nbf。ID token 仅在回调校验，不能调用业务 API。本站不再使用 Cloudflare Access 登录或 Service Token。
2. 浏览器由 Auth0 SPA SDK 完成授权码 + PKCE、state、nonce。现有 `eastmoney` 客户端配置为公开 SPA（token endpoint auth method `none`），已登记 callback/origin/组织约束保持。Access JWT 只存内存，浏览器和 API 统一用 `Authorization: Bearer`。刷新先静默恢复，失败转入公开登录页。

   Gateway 不交换浏览器 code、不读取登录 Cookie。旧 `__Host-eastmoney_session` 等 Cookie 只清理，不作凭据。受保护真实 `+page` 使用客户端渲染，Gateway 仅按代码中的精确名单放行匿名 HTML 外壳，`/__data.json`、`.html__data.json`、API、actions 与报告/材料文件仍验签和授权。token 不写 localStorage、URL、SSR HTML、日志或后端转发请求。

   客户端展示直接读当前 JWT，并在 `/auth/permissions` 验证成功后发布登录状态。该接口只返回有效权限和缓存时间，`/auth/session` 已移除。
3. 用户邮箱必须属于 `18.cn`。当前组织只启用 `eastmoney-email` 连接。已绑定的合并登录 Action 在签发时拒绝封禁账号和未验证邮箱。Action 写入顶层 `username`、`email`、`role`、`_roles`，以及本站组织可选的 `department`、`picture`。`role` 是数据库角色字符串，不用于业务授权。`_roles` 是业务角色名称数组。

   Gateway 验签并校验组织与应用，再把角色名称匹配到当前组织缓存的角色 ID。角色解析、admin/credit 检查与权限合并共用同一份快照。重复、未知、歧义或格式错误拒绝，缺角色声明要求重新登录。`username` 用作显示姓名，缺失时显示邮箱。不补造旧 connection/verified 标记。

   旧 nested `user` 和 URL 字段 token 一律拒绝，没有兼容或补值。`id` 与 `auth0Id` 均为 Auth0 `sub`。角色成员关系由 Auth0 管理，当前 Action 不自动分配基础角色。账号状态与角色成员变更在新 token 签发后生效。

   JWKS、公用管理 token 按各自时效缓存。
4. 角色与权限统一在 Auth0 管理。API 注册业务 scope，但不把 permissions 列表写入用户 token。Gateway 将本组织角色及授权序列化为 JSON，保存在命名 Cloudflare Cache API，TTL 为 1 小时。受保护请求按已验证 JWT 的业务角色名称匹配缓存目录，再合并授权并检查路由。缓存缺失或过期时从 Auth0 完整加载，加载失败则拒绝。

   无 `beta-open` 旁路。缓存按边缘节点独立，管理员手动刷新当前节点后立即使用，其他节点到期按需刷新。前端展示不是授权输入。个人“刷新我的权限”读取当前缓存，“刷新登录角色”通过 Auth0 SDK 取得新 token。

   Gateway 不再绑定 `AUTHORIZATION_DB`，旧表只保留历史回溯。
5. Gateway 默认拒绝未知路由、HTTP 方法、named action 和重复 action。HEAD 采用 GET 业务权限。写入保留同源检查。业务层继续校验输入白名单、记录归属、业务状态、RLS 与乐观锁。Gateway 的路由权限不能替代这些领域规则。
6. Gateway 是唯一公网入口。Dashboard/Data 配置 `routes=[]`、`workers_dev=false`、`preview_urls=false`，没有 Custom Domain，默认 fetch 固定 404。命名 Service Binding 是可信边界。Gateway 移除外部身份头和凭据，再生成版本化上下文。Dashboard 只在 `GatewayDashboard` 中解析为请求内 `GATEWAY_CONTEXT`，hooks 只设置 `locals.user`/permissions。Data 只执行 Gateway 的字段授权与 CAMEL 专用准入结果。

存储与 migration 所有权见 [DATABASE](DATABASE.md)，应用业务安全约束见 [Dashboard SECURITY](../dashboard/docs/SECURITY.md)，切换和回退见 [Gateway DEVELOPMENT](../gateway/docs/DEVELOPMENT.md)。

## 公开、仅登录与业务权限

| 边界 | 匿名 | 有效测试账号 | 说明 |
|---|---|---|---|
| 门户 `/`、登记静态文件、市场点评页/定稿 GET/HEAD | 公开只读 | 公开只读 | 不调用身份服务。报告写入仍受权限约束 |
| `/auth/login`、`/auth/callback`、退出和邮箱验证提示 | 身份流程公开 | 相同 | 客户端页面仅 GET。state、nonce、PKCE 由 Auth0 SPA SDK 执行，API 同源规则由 Gateway 执行 |
| `/auth/permissions` GET | 401 | 返回权限与缓存时间 | no-store。姓名和角色从当前 JWT 展示，`/auth/session` 已移除 |
| Data DM、东方财富网、固定行情与基础文档 GET/HEAD | 公开只读 | 公开只读 | 精确白名单由 Gateway 维护 |
| Gateway `POST /api/ai/responses` | 401 | 本站用户 Bearer 即可 | 直接生成 JSON/SSE，任意来源 CORS，OPTIONS 公开。POST 只接受 application/json；仍需本站用户 Bearer，机器 token 拒绝 |
| Data 通用 Choice | 401 | 有效登录即可 | 未知路径按原契约返回 |
| Data CAMEL | 401 | 精确资源按 research.interbank:read/import 检查 | POST 同源；无机器身份、GraphQL 或 MCP 入口 |
| GraphQL | 公开字段执行。Choice 字段返回登录错误 | Choice 字段按 Gateway 身份结果执行 | 别名、片段、混合查询保持字段边界。不消费匿名 Choice 额度 |
| 受保护 Dashboard 页面外壳 | 精确 CSR 页面外壳可读 | 相同外壳，数据另取 | 不加载或包含业务数据 |
| Dashboard 数据、API、actions、文件 | 拒绝或跳转 | 按 Bearer 权限与模式检查 | SvelteKit `__data.json` 保留 redirect 数据协议 |
| Ingest / Choice / Quant | 入口边界保持原状 | 用户 Bearer 不能替代服务凭据 | Ingest 仅 GET health。Choice 私网 RPC token。Quant 默认 HTTP 404。研究报告仅经 Gateway 模型读权限及命名绑定提供，旧机器 Choice 客户端已退役 |

私有 `InternalData` 不对应公网 URL。Dashboard/Ingest 不依赖用户 token。Quant 的独立 Auth0 client_credentials 应用已退役，Gateway 机器客户端白名单为空。旧代码中的机器 token 分支仅保留历史边界，不能据此认为当前 Quant 可以调用 Data Choice。重新开放须单独配置客户端、scope 与白名单并验证完整调用链。

## 内测授权

- 只使用 `AUTHORIZATION_MODE=enforce`，每个请求都检查角色权限。未知模式失败关闭。
- 本站组织用户通过成员关系配置 `authenticated` 基础角色，当前登录 Action 不自动分配。权限以 Auth0 当前角色授权为准。授信维护仅授予 `credit` 或全站 `admin`。后台管理与资金日报上传要求 `admin`。
- 内测结束后直接在 Auth0 调整角色权限，再刷新缓存。不修改鉴权流程。角色成员变更仍需重新签发 token。
- `GET /auth/permissions` 要求本站用户 Bearer 登录，只返回当前缓存有效权限和缓存时间。角色展示直接读取 JWT `_roles`。无业务权限用户也可查询自己，不触发强制同步。
- `POST /auth/permissions/refresh` 要求同源和 `admin`，从 Auth0 刷新当前 Cloudflare 节点的授权 JSON。不会更改 Auth0 配置。普通用户的展示刷新与管理员缓存同步是两个独立操作。
- Dashboard 个人权限与后台角色视图复用 `PermissionExplorer`，按 scope → resource → action 展示。编辑统一在 Auth0。

## 权限范围

业务权限代码与路由、方法、named action 的完整对应关系以 Gateway [权限目录](../gateway/src/lib/permissions.ts) 和 [路由策略](../gateway/src/lib/route-permissions.ts) 为准。Dashboard 的 [模块入口](../dashboard/AGENTS.md#context-routing) 说明各页面业务边界。新增或调整权限时同步修改代码、契约测试与受影响模块文档。GET 权限同时覆盖 HEAD。兼容入口沿用目标资源权限，目录中预留的权限不表示接口已上线。

交易流程共享配置由 `research.workflow:update` 维护。每日调度进度经 `/api/trading-workflow/day` 按登录账号读写，仍由 Gateway 校验登录与 `research.workspace:read`。询价记录和名单留在本地。

### 范围限制

- `financing.task:update_own` 只办理分配给本人任务的状态。完整任务编辑需要 `financing.task:update`，不能据此更改其他人的任务。
- `account.profile:*` 只操作当前 Auth0 账号，允许本人修改姓名及 `user_metadata.department`。修改邮箱仍需确认并重新验证，密码使用既有重置邮件流程。它不授权更改角色、权限或他人账号。
- `auth.permission:update` 保留为权限目录代码，不能替代 `admin` 缓存刷新边界。用户、角色、成员及角色权限均在 Auth0 管理。
- 通用 AI 侧栏的浏览器端会话按登录身份在本机隔离。通用 Responses 请求由 Gateway 持有 AI Gateway 访问 Secret 并直接转发。MCP 授信台账仅发布脱敏 `credit_report`，使用 `credit.institution:read` 权限；公开材料与搜索工具未发布。旧 CreditAgent 会话接口保留历史兼容。
- `financing.data:*` 只作用于数据后台白名单表/字段，并经事务身份与 RLS 检查。不是任意 SQL、任意 schema 或数据库管理员权限。
- `data.choice:read` 对外允许只读 Choice 查询。原生 SDK 的登录/退出和任意方法仍不开放。`data.camel:read` 不用于资金业务准入。拆借台账页及 `/data/camel/*` 精确查询使用 `research.interbank:read`，解析、导入、附件上传和草稿保存使用 `research.interbank:import`。Gateway 校验权限和 POST 同源后经 GatewayData 转发，Dashboard 不处理中转。
- `generate`、`import`、`upload`、`update`、`delete` 等权限可以产生业务副作用。真实访问验证只发只读探针，写操作通过模拟单元测试验证拦截与放行。

## 程序化权限测试

**权限登录与验收必须通过程序化 HTTP、单元测试或命令行执行，禁止使用 browser、Chrome、Playwright、浏览器 MCP 或人工浏览器操作。** 遇到 MFA、验证码、资料补全或邮箱验证阻断，明确报告当前步骤。不得关闭认证、伪造生产 JWT 或用管理 token/Service Token 冒充测试用户来通过验收。

### 凭据

项目组根目录 `.env` 保存 `AUTH_TEST_EMAIL` 与 `AUTH_TEST_PASSWORD`，测试账号固定为 `test@18.cn`。文件权限为 `0600`，不提交凭据、Cookie、JWT、OAuth code、事务 URL 或完整登录 HTML。文档与测试夹具不得出现真实密码。常规单元测试使用签名模拟 Auth0 token，不读取这份密码。

真实验证默认从标准同级布局读取根 `.env`。worktree 或独立 checkout 用 `AUTH_TEST_ENV_FILE` 指向该文件。程序不把登录凭据加入 URL，不向非 Auth0 origin 提交密码。Cookie 在内存中按域与路径隔离，最多一次密码提交，失败不自动重试。

### 各仓库与联调

- Gateway `pnpm test` 覆盖 Auth0 JWKS、PKCE/state/nonce、Bearer、旧 Cookie 拒绝、客户端 PKCE、全部已登记权限与路由、机器范围、GraphQL 字段、JWT 角色快照与 权限 JSON 缓存到期/手动刷新及撤销。
- Dashboard `pnpm test:auth` 覆盖私有上下文、前端展示、资料转发与 HTTP 登录。既有业务、记录归属与 RLS 回归仍在 `pnpm test`。
- Data `pnpm test:auth` 覆盖默认公网入口拒绝、私有上下文、GraphQL 混合查询与拒绝时零 Choice 调用。
- Quant `uv run python -m unittest tests.test_choice_data_api -v` 保留旧机器 JWT、目标域限制、凭据缓存与错误口径的回归测试。该测试不代表当前生产机器客户端仍可用。
- 在 Gateway 执行 `node scripts/verify-integration.mjs`，使用构建后的真实 SvelteKit 与 Data handler、模拟外部服务，验证 Gateway 联调、`__data.json`、公开/保护资源和账号撤销。可用 `DASHBOARD_CHECKOUT` / `DATA_CHECKOUT` 指定工作树。

### 真实登录与只读验证

在 Gateway 执行 `pnpm auth:verify`。Dashboard 保留兼容命令。脚本从项目组根 `.env` 读取 `test@18.cn`，生成客户端 PKCE/state/nonce。经 Auth0 Universal Login 的 HTTP 表单只提交一次密码。

按公开客户端 PKCE 交换并验证 token，再以 Bearer 读取 `/api/profile` 确认身份。最后串行执行公开与受保护的只读探针。Choice 用缺参数 422，不消耗 SDK 查询额度。不执行真实业务写入。



未通过验证码、MFA、资料补全或邮箱验证时明确报告阻断，禁止关闭保护、伪造生产 token 或用管理/机器 token 代替用户。上线后另核对两个后端的 routes、workers.dev、preview、Custom Domain 和默认入口，不能只用 Gateway 成功证明无绕过。

## Auth0 本地租户管理

本地配置与资源操作使用 Auth0 skill 和 `auth0` CLI，目标租户为 `hasbai.eu.auth0.com`。先运行 `auth0 tenants list` 核对活动租户，再用只读请求确认授权。租户出现在列表中不代表 token 有效。

远程会话优先使用专用 `development cli` 机器应用。本机凭据位于 `~/.config/auth0/codex-machine.json`，不输出 Secret 或 token。读取凭据后，在进程内调用 `auth0 login --domain … --client-id … --client-secret … --no-input`。机器应用现有权限为 `read:clients`、`update:clients`、`read:actions`、`update:actions`、`create:actions`、`read:forms`。`create:actions` 用于部署 Action 版本。没有客户端授权写权限，不扩展 Gateway 运行时凭据。

CLI 用户会话过期时，先复用机器凭据，不直接要求人工登录。机器请求返回 403 时核对缺少的 scope，重复登录不会增加授权。只有机器权限不足且无法由现有管理员授权修复时，才发起一次用户设备授权。可用机器权限完成本次操作后，恢复机器 CLI 登录。

能读取目标资源时直接复用。查询或修改前先用 `auth0 commands` / 对应命令的 `--help` 核对参数，再读取目标资源和关联关系。对具体资源执行已授权的变更后，按 ID 回读核验。不要用全租户导入覆盖并行会话的改动。

多个 agent 会话共用本机 Auth0 CLI 授权状态。需要恢复授权时，只由一个会话登录，其他会话等待后重试。机器应用缺少 scope 时，须由管理员更新 client grant；`auth0 login --scopes` 不能扩展机器授权。不要把 `auth0 login` 当作每次任务的初始化步骤，也不要随任务结束执行 `auth0 logout`。

多租户操作尽量给单条命令指定 `--tenant`，避免一个会话通过 `auth0 tenants use` 改动其他会话的默认租户。并发写入同一资源必须先协调所有权和顺序，写前重读、写后回读。临时导出各用独立目录，不共享默认输出路径。

Agent mode 下 CLI 已输出 JSON，不能给所有命令盲加 `--json`。错误信息保留在 stderr，不把 `2>&1` 接入 `jq`，也不打印 token、client secret、完整用户资料或含凭据的配置。删除命令在 agent mode 下需要 `--force`，仅对已核对的精确 ID 执行。Auth0 skill 的 CLI 参考是命令语法依据，应用业务权限和生产身份边界仍以本文件及 Gateway 实现为准。

原有 `pnpm auth0:export` / `auth0:plan` / `auth0:apply` 与 Management API helper 是依赖专用机器凭据的历史迁移工具，不作为新任务的本地 Auth0 管理入口。不能在机器应用退役后继续运行。Gateway 运行时使用的 `eastmoney gateway management` 是另一应用，供身份服务和登录 Actions 使用，不受本地 CLI 授权变化影响。worktree 的权限测试仍可用 `AUTH_TEST_ENV_FILE` 指向项目组根 `.env`。身份验收继续只允许程序化流程，禁止 browser。

## 维护与来源

新增权限或路由时，同时更新 Gateway 权限目录、路由策略、受影响模块文档和匿名/测试账号矩阵。新增复杂角色验收需另列范围。现行部署见 [Gateway 开发](../gateway/docs/DEVELOPMENT.md)，旧跨 schema 迁移仅供 [Dashboard 历史记录](../dashboard/docs/UNIFIED_PERMISSIONS.md) 追溯。

HTTP 登录遵循现有 [Auth0 Universal Login](https://auth0.com/docs/authenticate/login/auth0-universal-login) 重定向流程。应用会话由 Gateway 校验 Auth0 签名 JWT，API token 遵循 [Auth0 Access Token 校验](https://auth0.com/docs/secure/tokens/access-tokens/validate-access-tokens)。登录表单可能变化，脚本遇到未知步骤必须显式失败，不退回浏览器。

测试账号资料准备使用 [Auth0 Update a User](https://auth0.com/docs/api/management/v2/users/patch-users-by-id)。metadata 仅提交所需一级字段，沿用 [Auth0 合并语义](https://auth0.com/docs/manage-users/user-accounts/metadata/manage-metadata-api) 保留其他字段。

## MCP 边界

统一 `/mcp` 要求有效 Auth0 用户登录。客户端连接 `https://eastmoney.hasbai.xyz/mcp`，不经过 Cloudflare MCP Portal。Gateway 的公开 Protected Resource Metadata 和 401 挑战指向真实 Auth0 issuer，使用官方 ChatGPT/Codex/OpenCode CIMD 自动识别客户端和授权码 + PKCE；Auth0 原生开启 CIMD discovery 与 RFC9207，动态注册与 DCR 未开放。三个精确客户端仅准入 `/mcp`，不准入普通 REST。MCP 身份来自签名 `https://eastmoney.hasbai.xyz/identity`，不回退顶层保留字段；网站声明协议保持。本站 API resource 为 `https://eastmoney.hasbai.xyz/`，Auth0 原生支持 resource 参数，组织限定与角色校验继续生效。Gateway 不签发或代理 token。旧公网 `/api/mcp`、`/data/mcp` 返回410。Gateway 通过命名应用 binding 聚合 Dashboard 与 Data 目录，用户 token 不进入应用；Data 使用可信用户和 Choice 准入上下文，MCP 不开放 CAMEL 或 InternalData。Gateway 按当前业务 route/action 权限筛选 Dashboard 工具目录，并校验每次执行；不发布 AI 生成工具。

旧 Quant Choice 机器 scope 不扩展到 MCP。匿名及无效登录返回 401，账号拒绝返回 403。已登录请求未登记入口时返回 403 `ROUTE_NOT_REGISTERED`，不再混淆为账号缺少权限。当前连接与工具范围见 [Dashboard MCP](../dashboard/docs/MCP.md)，门户历史配置见 [Gateway MCP](../gateway/docs/MCP.md)。



## 消息投递权限

`messenger.delivery:read` 允许 GET `/management/messenger`（含详情/筛选）。`messenger.delivery:retry` 允许该页 `POST:retry`。MessengerAdmin 仅由 Dashboard 私有绑定调用，操作者从 Gateway 已验证的身份派生，浏览器不能指定 actor。

## admin 管理边界

本组织新增 `admin` 全站管理员角色，唯一成员为 shiyue@18.cn。Gateway 将经验证签名角色与当前 Auth0 角色目录匹配后授予全部本站业务权限。后台管理页、人员姓名及部门编辑、权限缓存刷新、资金日报上传要求 admin，内测角色拥有全部 scope 也不能越过此边界。Gateway 公网 `/api/management/people` 直接处理人员目录与编辑，校验 admin。

目标仅限本站组织成员和 `eastmoney-email` 账号，只写 Auth0 `name`、`user_metadata.department`。后台“我的 / 权限 / 通知”面向所有登录用户，订阅还按业务类别资格过滤。前端无权入口和写控件隐藏，服务端保持独立校验。
