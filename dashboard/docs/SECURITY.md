# 安全边界

## Secret 与配置

- 生成式 AI 只通过 `src/lib/server/ai-gateway.ts`。传输、重试、BYOK 和 AI 日志规则只在 [共享 AI](../../docs/AI.md) 维护。业务代码不读取上游 API Key。
- `CF_AIG_TOKEN` 只通过 Worker Secret 注入。`CLOUDFLARE_ACCOUNT_ID`、`AI_GATEWAY_ID` 和数据服务基址是非敏感配置，但仍应通过 Worker/Vite 配置读取。
- Neon 直连 `DATABASE_URL` 只供本地 migration、回填和授信 Excel 导入脚本使用。本地 `pnpm dev` 通过未跟踪的 `.env.local` 注入 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`，生产 Dashboard Worker 仅使用 `HYPERDRIVE` 业务连接。Gateway 使用 Cache API 权限 JSON 缓存，见下文权限边界。
- Quant 本地通过 `DATABASE_URL` 只读输入。线上 Workflow 经所有方发布函数写入结果。连接串不得经页面或 API 暴露。
- Neon 开发直连从 `.env.local.example` 创建未跟踪的 `.env.local`。不要提交该文件。

## 客户端与服务端边界

- 授信助手只调用 AI Search `credit` 当前公开 PDF 索引。对话不查询客户、协议或内部材料。Gateway 的登录身份用于隔离用户会话，文件下载限定在 R2 `eastmoney/credit/public/` 的单层 PDF。具体流程见 `CREDIT_ASSISTANT.md`。

- 浏览器不得取得 Provider 密钥、数据库连接字符串、D1/R2 binding、完整二级池 Excel 数据缓存或授信源 Excel。本地授信导入不得上传文件到 Worker、R2 或浏览器接口。
- `$lib/server` 模块不得被客户端代码导入。
- Dashboard Worker 到同一 zone 的 Data Worker 使用 `DATA` Service Binding。服务端代码不得以公开 hostname 做 Worker-to-Worker 回环请求。市场点评浏览器只读定稿，后台 Workflow 通过 DATA 读取原始行情。旧 `/api/market-resources/*` 使用同一公开只读边界，保留资源与参数白名单。
- 生成式 AI 输出必须经 Zod Schema 或明确的文本协议校验后进入业务层。
- 融资择时卖方观点先调用固定 AI Search MCP 公共端点，仅把限长、去重后的证据交给 AI Gateway。机构、标题、日期和源 key 由检索元数据回填，不接受模型自由生成。
- R2 下载路径必须使用固定前缀与严格文件名校验。授信助手仅接受 `credit/public/` 的单层 PDF。
- 资金日报列表只枚举 `fund-reports/` 固定前缀并过滤严格日期文件名。单期读取只允许用严格日期派生 `fund-reports/YYYY-MM-DD.html`，不得把 URL 路径直接拼为 R2 key。返回的交互 HTML 使用 CSP sandbox 保留脚本交互，但不授予同源访问能力，并禁用摄像头、麦克风和定位。

## 请求保护与私有入口

- Gateway 是本站唯一公网入口，Auth0 JWT 验签、JWKS、账号状态、角色及路由权限全部由 Gateway 处理。详细协议见 [共享 AUTH](../../docs/AUTH.md)。
- Dashboard `routes=[]`、`workers_dev=false`、`preview_urls=false`，没有 Custom Domain，默认 fetch 固定 404。静态资产 `run_worker_first=true`，不能绕开默认入口。
- 只有 `GatewayDashboard` 命名 Service Binding 接收 Gateway 的 Base64URL 上下文，解析后移入请求内 `env.GATEWAY_CONTEXT` 并删除身份头。`hooks.server.ts` 仅从该元数据设置 `locals.user` 和 permissions，不读取 Cookie、外部身份头，不验证 JWT，也不调用 Auth0/权限库。缺少元数据失败关闭。
- 独立授信助手 HTTP 从同一私有入口取得已验证 `user`，按用户隔离会话。DO 不新增公网旁路。
- Gateway 的同源、方法和 named action 检查发生在转发前。业务仍验证输入白名单、记录归属、乐观锁、文件类型/大小/内容和事务 RLS。上传登录检查、菜单及前端权限只用于交互。
- Dashboard 的 `/auth/login`、`/auth/callback`、`/auth/logout` 是公开 CSR 页面，使用 Auth0 SPA SDK 授权码 + PKCE。SDK 令牌只存内存。浏览器所有业务请求使用 `Authorization: Bearer`，不读取登录 Cookie。`/auth/session` 已移除。Gateway 只匿名放行实际 CSR 页面 HTML 壳，页面的 `__data.json`、actions、API 与文件输出仍校验 Bearer。
- 新账号的邮箱/姓名/部门和验证流程仍由 Auth0 Actions/Forms 管理。用户字段不授予角色。Auth0 token 的 email 必须与当前账号一致，旧邮箱会话不能修改资料。
- 个人信息白名单与本人校验由 Gateway 维护。本人姓名和部门写入 Auth0，邮箱变更需明确确认，重置验证并退出。密码使用既有重置邮件流程。管理员可经私有 IdentityService 更新本组织账号的姓名、部门，Gateway 再次核对 admin、组织成员及连接。管理凭据不留在 Dashboard Worker，目录及角色配置通过 `IDENTITY: IdentityService` 取得。

## 数据与日志

- D1 不保存研报正文。政策正文仍存 `policy_news`，见 [共享数据库](../../docs/DATABASE.md#共享-d1)。热点只读取结构化摘要和关键词。
- Worker 日志记录事件、状态、范围、Provider 尝试次序、任务类型、effort、reasoning summary/context 模式、返回摘要条数与字符数、Prompt Cache token 计数、加密推理存在性、输出长度和 Gateway log ID，不记录 token、连接串、推理摘要正文、完整 AI 输入输出、完整文章正文、授信源文件路径或 Excel 内容。
- Data/API 错误可对外返回用于排查的结构化安全诊断：接口路径、HTTP 状态、错误码、数据源、
  处理阶段，以及限长后的字段路径、收到类型和标量值。不得返回堆栈、Cookie、token、签名
  URL、连接串、完整正文或大段原始响应。详细堆栈仍只进入服务端日志。

## 权限结果与业务约束

`src/lib/permissions.ts` 与 `route-permissions.ts` 是 Gateway 生成的前端展示契约，供菜单与导航使用。不可作为服务端授权输入。修改权限在 Gateway 完成，再同步契约。`locals.user.id` 与 `auth0Id` 均为 Auth0 subject，业务负责人只用 Auth0 ID，不能按邮箱/姓名关联。

客户端展示由 Auth0 SPA SDK 当前 access token 的 `username/email/department/picture/role/_roles` 派生。`role` 为数据库字符串，`_roles` 为业务角色名称数组，不接受旧 namespace 或 `roles` 声明。解码不执行授权：只有 Gateway 的 `GET /auth/permissions` 验证 Bearer 并返回 `{ permissions, updatedAt }` 后，客户端才建立登录展示。令牌不写 localStorage、不放 URL、不发送给外部 origin。

根 layout 复用展示状态，受保护直达在 SvelteKit 启动前静默恢复，失败立即走 SDK redirect。回调先完成 code 交换再恢复。公开市场报告保留既有渲染方式。角色变化通过重新登录取得新 token。

业务服务端继续只消费 Gateway 的 `locals.user` 和权限，不从客户端展示做授权。

原生 GET 筛选走 SvelteKit 导航，POST actions 使用 enhance/fetch。下载使用认证 fetch 和 Blob，资金日报 HTML 使用 `sandbox="allow-scripts allow-downloads"`、无 referrer 并禁止摄像头/麦克风/定位的 iframe 预览，不给同源能力。SSE 继续使用现有 fetch 流，不把 Bearer 放 URL。

Dashboard 不持有 `AUTHORIZATION_DB` 或 Auth0 管理 Secret。`/management/people` 经私有 Gateway 服务读取人员目录及缓存中的角色授权。人员姓名和部门写回 Auth0，角色与成员关系链接 Auth0 管理。个人页与角色页复用 scope/resource/action 权限组件。

个人 `GET /auth/permissions` 获取自己的缓存权限，管理员 `POST /auth/permissions/refresh` 在同源及权限检查后更新当前 Cloudflare 节点缓存。其他节点最长 1 小时后按需更新。角色与权限以 Auth0 为唯一来源，基础 authenticated 角色通过组织成员关系分配。有效权限由 Auth0 当前授权决定。

授信维护和管理员边界见 [共享 AUTH](../../docs/AUTH.md)。

融资数据后台继续使用表/字段白名单、参数化 SQL、完整主键与乐观条件。事务用 Gateway 已确认的 Auth0 ID、permissions 和 operation 设置 `request.auth.*` 后 `SET LOCAL ROLE authenticated`。提交/回滚清除上下文。RLS 保留 read/create/update/delete 及记录归属约束，不接受浏览器提供的权限集合。

## MCP 业务调用

`/api/mcp` 仅消费 Gateway 已验证用户，目录与每次执行通过 IDENTITY 私有桥接向 Gateway 查询真实路由权限，再执行原业务接口。不使用前端权限契约代替服务端授权。详见 [MCP](MCP.md)。
