# 认证与权限

本文件拥有项目组共享的认证架构、权限范围和程序化验收规范。事实来源：Gateway 的[权限目录](../gateway/src/lib/permissions.ts)、[路由权限](../gateway/src/lib/route-permissions.ts)、[路由策略](../gateway/src/lib/server/permission-policy.ts)、[授权入口](../gateway/src/lib/server/authorization.ts)和 [Data 分流](../gateway/src/data.ts)。Dashboard 的权限目录只是前端展示契约，不执行 JWT 或角色授权。

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
```

1. **Auth0**：管理用户、密码、邮箱验证、账号状态、角色和成员关系。管理 API 域为 `hasbai.eu.auth0.com`，登录与 API token 的 issuer 为 `https://auth.hasbai.xyz/`。Gateway 校验 RS256 签名、JWKS、issuer、API audience、subject、azp 和 iat/exp/nbf。ID token 只在回调校验，不能调用业务 API。
2. **浏览器登录**：Auth0 SPA SDK 完成授权码 + PKCE、state、nonce。`eastmoney` 客户端是公开 SPA（token endpoint auth method `none`），callback、origin 和组织约束已登记。Access JWT 只存内存，浏览器和 API 统一用 `Authorization: Bearer`。刷新先静默恢复，失败转入公开登录页。
   - Gateway 不交换浏览器 code，不读登录 Cookie。遗留 Cookie 只清理，不作凭据。
   - 受保护页面用客户端渲染。Gateway 只按代码中的精确名单放行匿名 HTML 外壳。`/__data.json`、`.html__data.json`、API、actions 和报告/材料文件仍验签授权。
   - token 不写入 localStorage、URL、SSR HTML、日志或后端转发请求。
   - 客户端直接读当前 JWT 展示身份，并在 `/auth/permissions` 验证成功后发布登录状态。
3. **账号与声明**：邮箱须属于 `18.cn`，当前组织只启用 `eastmoney-email` 连接。合并登录 Action 在签发时拒绝封禁账号和未验证邮箱，并写入顶层 `username`、`email`、`role`、`_roles`，以及可选的 `department`、`picture`。`role` 是数据库角色字符串，不用于业务授权。`_roles` 是业务角色名称数组。
   - Gateway 验签并校验组织与应用，再把角色名称匹配到当前组织缓存的角色 ID。角色解析、admin/credit 检查和权限合并共用同一份快照。
   - 角色重复、未知、歧义或格式错误时拒绝。缺角色声明时要求重新登录。旧的 nested `user` 和 URL 字段 token 一律拒绝。
   - `username` 作显示姓名，缺失时显示邮箱。`id` 与 `auth0Id` 均为 Auth0 `sub`。
   - 角色成员关系由 Auth0 管理，Action 不自动分配基础角色。账号状态和角色成员变更在新 token 签发后生效。
4. **角色权限缓存**：角色与权限统一在 Auth0 管理。API 注册业务 scope，但 token 不带 permissions 列表。Gateway 把本组织角色及授权序列化为 JSON，存入命名 Cloudflare Cache API，TTL 为 1 小时。请求按 JWT 的角色名匹配缓存目录，合并授权后检查路由。缓存缺失或过期时从 Auth0 完整加载，加载失败则拒绝。
   - 缓存按边缘节点独立。管理员手动刷新只对当前节点立即生效，其他节点到期后按需刷新。
   - 前端展示不是授权输入。个人“刷新我的权限”读当前缓存，“刷新登录角色”经 SDK 取新 token。
5. **路由与业务校验**：Gateway 默认拒绝未知路由、HTTP 方法、named action 和重复 action。HEAD 采用 GET 的权限。写入保留同源检查。路由权限不替代业务层的输入白名单、记录归属、业务状态、RLS 和乐观锁。
6. **信任边界**：Gateway 是唯一公网入口。命名 Service Binding 和身份上下文的传递见 [ARCHITECTURE](ARCHITECTURE.md#运行单元与生产入口)。

存储与 migration 所有权见 [DATABASE](DATABASE.md)，业务安全约束见 [Dashboard SECURITY](../dashboard/docs/SECURITY.md)，发布顺序见 [Gateway DEVELOPMENT](../gateway/docs/DEVELOPMENT.md)。

## 公开、仅登录与业务权限

| 边界 | 匿名 | 有效测试账号 | 说明 |
|---|---|---|---|
| 门户 `/`、登记静态文件、市场点评页/定稿 GET/HEAD | 公开只读 | 公开只读 | 不调用身份服务。报告写入需权限 |
| `/auth/login`、`/auth/callback`、退出、邮箱验证提示 | 公开 | 相同 | 页面仅 GET。state、nonce、PKCE 由 SDK 执行 |
| `/auth/permissions` GET | 401 | 返回权限与缓存时间 | no-store |
| Data 的 DM、东方财富网、固定行情、基础文档 GET/HEAD | 公开只读 | 公开只读 | 精确白名单在 Gateway |
| `POST /api/ai/responses` | 401 | 本站用户 Bearer | 机器 token 拒绝。CORS 和请求规则见 [Gateway AI](../gateway/docs/AI.md) |
| Data 通用 Choice | 401 | 有效登录即可 | 未知路径按原契约返回 |
| Data CAMEL | 401 | 精确资源按 `research.interbank:read` / `import` | POST 同源。无机器身份、GraphQL 或 MCP 入口 |
| GraphQL | 公开字段执行。Choice 字段返回登录错误 | Choice 字段按身份结果执行 | 别名、片段、混合查询保持字段边界。匿名不消耗 Choice 额度 |
| Dashboard 页面外壳 | 精确 CSR 外壳可读 | 相同，数据另取 | 外壳不含业务数据 |
| Dashboard 数据、API、actions、文件 | 拒绝或跳转 | 按 Bearer 权限检查 | `__data.json` 保留 redirect 协议 |
| Ingest / Quant | 入口边界不变 | 用户 Bearer 不能替代服务凭据 | Ingest 仅 GET health。Quant 默认 HTTP 404，研究报告只经 Gateway 模型读权限和命名绑定提供 |

`InternalData` 没有公网 URL，调用方不依赖用户 token。Gateway 机器客户端白名单为空（`AUTH0_MACHINE_CLIENT_IDS`），Quant 目前不能经公网调用 Data Choice。重新开放须单独配置客户端、scope 和白名单，并验证完整调用链。

## 角色与管理边界

- `AUTHORIZATION_MODE=enforce`，每个请求都检查角色权限。未知模式失败关闭。`beta-open` 已停用，配置后返回 503。
- 本站组织用户通过成员关系获得 `authenticated` 基础角色。授信维护仅授予 `credit` 或全站 `admin`。
- `admin` 是全站管理员角色，唯一成员为 shiyue@18.cn。Gateway 把验签角色与当前 Auth0 角色目录匹配后，授予全部站点业务权限。后台管理页、人员姓名与部门编辑、权限缓存刷新、资金日报上传要求 `admin`，其他角色即使拥有全部 scope 也不能越过。
- `GET /auth/permissions`：登录即可，返回当前缓存的有效权限和缓存时间。无业务权限的用户也可查询自己，不触发同步。
- `POST /auth/permissions/refresh`：要求同源和 `admin`，从 Auth0 刷新当前节点的授权 JSON，不改 Auth0 配置。
- `/api/management/people`（admin）只写 Auth0 `name` 和 `user_metadata.department`，目标限本站组织成员和 `eastmoney-email` 账号。
- 后台“我的 / 权限 / 通知”面向所有登录用户，订阅按业务类别资格过滤。前端隐藏无权入口和写控件，服务端独立校验。
- Dashboard 个人权限与后台角色视图复用 `PermissionExplorer`，按 scope → resource → action 展示。编辑在 Auth0。
- 调整权限：在 Auth0 修改角色权限，再刷新缓存。角色成员变更需重新签发 token。
- 消息投递：`messenger.delivery:read` 允许 GET `/management/messenger`（含详情和筛选），`messenger.delivery:retry` 允许该页 `POST:retry`。`MessengerAdmin` 只由 Dashboard 私有绑定调用，操作者取自 Gateway 已验证的身份，浏览器不能指定 actor。

## 权限范围

权限码与路由、方法、named action 的完整对应关系以 Gateway [权限目录](../gateway/src/lib/permissions.ts)和[路由权限](../gateway/src/lib/route-permissions.ts)为准。各页面业务边界见 [Dashboard 模块入口](../dashboard/AGENTS.md#context-routing)。新增或调整权限时，同步修改代码、契约测试和受影响的模块文档。GET 权限同时覆盖 HEAD。兼容入口沿用目标资源的权限。目录中预留的权限不表示接口已上线。

交易流程共享配置由 `research.workflow:update` 维护。每日调度进度经 `/api/trading-workflow/day` 按登录账号读写，Gateway 校验登录和 `research.workspace:read`。

范围限制：

- `financing.task:update_own` 只办理分配给本人任务的状态。完整任务编辑需要 `financing.task:update`。
- `account.profile:*` 只操作当前 Auth0 账号，允许本人改姓名和 `user_metadata.department`。改邮箱须确认并重新验证，密码用既有重置邮件流程。它不授权更改角色、权限或他人账号。
- `auth.permission:update` 是目录中保留的权限码，不替代 `admin` 的缓存刷新边界。
- `financing.data:*` 只作用于数据后台白名单的表和字段，并经事务身份和 RLS 检查。它不是任意 SQL、任意 schema 或数据库管理员权限。
- `data.choice:read` 开放只读 Choice 查询，不开放原生 SDK 的登录、退出和任意方法。`data.camel:read` 不用于资金业务准入。拆借台账页和 `/data/camel/*` 的精确查询用 `research.interbank:read`，解析、导入、附件上传和草稿保存用 `research.interbank:import`。
- `generate`、`import`、`upload`、`update`、`delete` 等权限会产生业务副作用。真实访问验证只发只读探针，写操作用模拟单元测试验证拦截与放行。

## 程序化权限测试

**权限登录与验收只用程序化 HTTP、单元测试或命令行，禁止使用 browser、Chrome、Playwright、浏览器 MCP 或人工浏览器操作。** 遇到 MFA、验证码、资料补全或邮箱验证阻断时，报告当前步骤。不要关闭认证、伪造生产 JWT，或用管理 token / Service Token 冒充测试用户。

### 凭据

根目录 `.env` 保存 `AUTH_TEST_EMAIL` 与 `AUTH_TEST_PASSWORD`，测试账号为 `test@18.cn`，文件权限 `0600`。凭据、Cookie、JWT、OAuth code、事务 URL 和完整登录 HTML 不进入 Git、文档或测试夹具。常规单元测试用签名模拟的 Auth0 token，不读取密码。

真实验证默认读取标准同级布局的根 `.env`，独立 checkout 用 `AUTH_TEST_ENV_FILE` 指向它。密码只提交给 Auth0 origin，且只提交一次，失败不重试。

### 各项目与联调

- Gateway `pnpm test`：覆盖 Auth0 JWKS、PKCE/state/nonce、Bearer 和遗留 Cookie 拒绝。也覆盖已登记的权限与路由、机器范围、GraphQL 字段、JWT 角色快照，以及权限缓存的到期与手动刷新。
- Dashboard `pnpm test:auth`：私有上下文、前端展示、资料转发和 HTTP 登录。业务、记录归属和 RLS 回归在 `pnpm test`。
- Data `pnpm test:auth`：默认公网入口拒绝、私有上下文、GraphQL 混合查询，以及拒绝时零 Choice 调用。
- Quant `uv run python -m unittest tests.test_choice_data_api -v`：旧机器 JWT 路径的回归测试，不代表机器客户端当前可用。
- Gateway `node scripts/verify-integration.mjs`：用构建后的真实 SvelteKit 和 Data handler、模拟外部服务，验证 Gateway 联调、`__data.json`、公开与受保护资源和账号撤销。`DASHBOARD_CHECKOUT` / `DATA_CHECKOUT` 可指定工作树。

### 真实登录与只读验证

在 Gateway 执行 `pnpm auth:verify`（Dashboard 保留同名兼容命令）。脚本从根 `.env` 读取 `test@18.cn`，生成客户端 PKCE/state/nonce，经 Auth0 Universal Login 的 HTTP 表单提交一次密码，按公开客户端 PKCE 交换并验证 token。随后以 Bearer 读取 `/api/profile` 确认身份，再串行执行公开与受保护的只读探针。Choice 探针用缺参数的 422，不消耗 SDK 额度。不做真实业务写入。

登录表单可能变化，脚本遇到未知步骤必须显式失败，不退回浏览器。上线后另行核对 Dashboard 与 Data 的 routes、workers.dev、preview、Custom Domain 和默认入口，Gateway 成功不能证明无绕过。

参考：[Auth0 Universal Login](https://auth0.com/docs/authenticate/login/auth0-universal-login)、[Access Token 校验](https://auth0.com/docs/secure/tokens/access-tokens/validate-access-tokens)。准备测试账号资料时用 [Update a User](https://auth0.com/docs/api/management/v2/users/patch-users-by-id)，只提交所需的一级 metadata 字段，依靠[合并语义](https://auth0.com/docs/manage-users/user-accounts/metadata/manage-metadata-api)保留其他字段。

## Auth0 本地租户管理

用 Auth0 skill 的 CLI 工作流和 `auth0` 命令，目标租户为 `hasbai.eu.auth0.com`。

- 开始前运行 `auth0 tenants list`，核对授权和活动租户。能读取目标资源就直接复用。
- 先用 `--help` 核对参数，再读取目标资源和关联关系。变更某个资源后，按 ID 回读核验。
- 本机 agent 使用 M2M 应用 `eastmoney agent management`（`r4iobbtIy8S5bPjUFqxlS6flW6LA4cDG`），凭据在根 `.env` 的 `AUTH0_AGENT_CLIENT_ID` / `AUTH0_AGENT_CLIENT_SECRET`。用 `auth0 login --domain hasbai.eu.auth0.com --client-id … --client-secret …` 机器登录，CLI 自动续期。范围覆盖 clients、client grants、client profiles、租户设置、API、Actions、日志，以及组织、角色、用户只读和连接读写，无 delete。
- 多个 agent 会话共用本机 CLI 授权。只有确认未授权，或命令因缺 scope 失败时，才由一个会话执行一次 `auth0 login`（缺 scope 时请求所需 scope），其他会话等待后重试。不要把 `auth0 login` 当初始化步骤，也不要在任务结束时 `auth0 logout`。
- 命令尽量带 `--tenant`，避免 `auth0 tenants use` 改动其他会话的默认租户。
- 并行写同一资源前先协调所有权和顺序，写前重读，写后回读。临时导出各用独立目录。不要用全租户导入覆盖其他会话的改动。
- Agent mode 下 CLI 已输出 JSON，不要盲加 `--json`。错误留在 stderr，不要把 `2>&1` 接入 `jq`。不打印 token、client secret、完整用户资料或含凭据的配置。删除命令需 `--force`，只对已核对的精确 ID 使用。
- 本地 Auth0 管理只用 `auth0` CLI。Gateway 运行时用的 `eastmoney gateway management` 是另一个应用，不受本地 CLI 授权影响。

## 新增权限或路由

同时更新 Gateway 权限目录、路由策略、受影响的模块文档，以及匿名/测试账号矩阵。复杂角色的验收范围另列。

## MCP 边界

- **入口**：统一 `/mcp`，要求有效的 Auth0 用户登录。客户端连接 `https://eastmoney.hasbai.xyz/mcp`。
- **发现与授权**：Gateway 的公开 Protected Resource Metadata 和 401 挑战指向真实 Auth0 issuer。ChatGPT、Codex、OpenCode 用官方 CIMD 自动识别，走授权码 + PKCE。Auth0 原生开启 CIMD discovery 与 RFC9207，动态 CIMD 已开放（client profile 强制组织登录，默认 grant 授予本站 API），DCR 未开放。所有 CIMD 客户端只准入 `/mcp`，不准入普通 REST。Gateway 不签发或代理 token。
- **身份**：来自签名声明 `https://eastmoney.hasbai.xyz/identity`，不回退到顶层保留字段。本站 API resource 为 `https://eastmoney.hasbai.xyz/`，组织限定和角色校验照常生效。
- **工具**：Gateway 经命名绑定聚合 Dashboard 与 Data 的工具目录，用户 token 不进入应用。Gateway 按当前业务 route/action 权限筛选 Dashboard 工具，并校验每次执行。Data 使用可信用户和 Choice 准入上下文。MCP 不开放 CAMEL 和 `InternalData`，不发布 AI 生成工具。
- **错误码**：匿名和无效登录返回 401，账号被拒返回 403。已登录但入口未登记时返回 403 `ROUTE_NOT_REGISTERED`。
- **授信**：MCP 的授信台账只发布脱敏的 `credit_report`，用 `credit.institution:read`。授信公开材料和搜索工具未发布。

当前连接和工具范围见 [Dashboard MCP](../dashboard/docs/MCP.md)。
