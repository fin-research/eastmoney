# 安全边界

认证、权限范围、Auth0 管理和程序化验收见 [共享 AUTH](../../docs/AUTH.md)。本文只维护 Dashboard 应用层的约束。

## Secret 与配置

- Worker Secret 为 `CF_AIG_TOKEN`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`。`CLOUDFLARE_ACCOUNT_ID`、`AI_GATEWAY_ID` 和数据服务基址是非敏感 vars。
- 生成式 AI 只经 `src/lib/server/ai-gateway.ts`，传输、BYOK 和日志规则见 [共享 AI](../../docs/AI.md)。业务代码不读上游 API Key。
- 生产 Worker 只用 `HYPERDRIVE` 业务连接。Neon 直连 `DATABASE_URL` 只供本地 migration、回填和授信 Excel 导入脚本。
- 本地 `pnpm dev` 经未跟踪的 `.env.local` 注入 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`，模板为 `.env.local.example`。
- Quant 本地用 `DATABASE_URL` 只读输入，线上 Workflow 经所有方发布函数写结果。连接串不经页面或 API 暴露。

## 私有入口与身份

- Dashboard 配置 `routes=[]`、`workers_dev=false`、`preview_urls=false`，默认 fetch 返回 404。静态资产 `run_worker_first=true`，不能绕开默认入口。
- 只有 `GatewayDashboard` 命名 Service Binding 接收 Gateway 的 Base64URL 上下文。入口解析后移入请求内 `env.GATEWAY_CONTEXT` 并删除身份头。
- `hooks.server.ts` 只从该元数据设置 `locals.user` 和 `locals.permissions`。它不读 Cookie 和外部身份头，不验证 JWT，缺少元数据则失败关闭。
- 授信助手 HTTP 从同一入口取已验证 `user`，按用户隔离会话，DO 无公网旁路。
- `locals.user.id` 与 `auth0Id` 均为 Auth0 subject。业务负责人只存 Auth0 ID，不按邮箱或姓名关联。
- `src/lib/permissions.ts` 与 `route-permissions.ts` 是 Gateway 生成的前端展示契约，供菜单与导航使用，不是授权输入。权限变更在 Gateway 完成后再同步。
- 个人信息白名单与本人校验由 Gateway 维护，管理员改姓名和部门经私有 `IdentityService`。Dashboard 不持有 `AUTH0_MANAGEMENT_*` 或权限库连接。

## 客户端展示与请求

- 客户端展示由 Auth0 SPA SDK 当前 access token 的 `username/email/department/picture/role/_roles` 派生。`role` 是数据库字符串，`_roles` 是业务角色名数组，不接受旧 namespace 或 `roles` 声明。
- 解码不执行授权。只有 Gateway 的 `GET /auth/permissions` 验证 Bearer 并返回 `{ permissions, updatedAt }` 后，客户端才建立登录展示。令牌规则见 [共享 AUTH](../../docs/AUTH.md#身份与权限架构)。
- 根 layout 复用展示状态。受保护直达在 SvelteKit 启动前静默恢复，失败走 SDK redirect。回调先完成 code 交换再恢复。角色变化需重新登录。
- 原生 GET 筛选走 SvelteKit 导航，POST actions 用 enhance / fetch。下载用认证 fetch 加 Blob，SSE 用现有 fetch 流，Bearer 不放 URL。
- 资金日报 HTML 用 `sandbox="allow-scripts allow-downloads"`、无 referrer、禁摄像头 / 麦克风 / 定位的 iframe 预览，无同源能力。

## 服务端边界

- 浏览器不取得 Provider 密钥、数据库连接串、D1/R2 binding、完整二级池 Excel 缓存和授信源 Excel。`$lib/server` 不被客户端代码导入。
- 本地授信导入不把文件上传到 Worker、R2 或浏览器接口。
- Worker 到同一 zone 的 Data 用 `DATA` Service Binding，服务端不用公开 hostname 回环请求。
- 同源、方法和 named action 检查在 Gateway 转发前完成。业务层仍验证输入白名单、记录归属、乐观锁、文件类型 / 大小 / 内容和事务 RLS。上传登录检查、菜单和前端权限只用于交互。
- 生成式 AI 输出经 Zod Schema 或明确的文本协议校验后才进业务层。
- 融资择时卖方观点先调用固定 AI Search MCP 端点，只把限长、去重后的证据交给 AI Gateway。机构、标题、日期和源 key 由检索元数据回填，不取自模型输出。
- R2 下载路径用固定前缀和严格文件名校验。授信助手只接受 `credit/public/` 的单层 PDF，`credit/` 下其他前缀不对外。资金日报 key 规则见 [DATABASE](DATABASE.md#r2)。
- 授信助手只查 AI Search `credit` 的公开 PDF 索引，不查客户、协议和内部材料，见 [授信助手](CREDIT_ASSISTANT.md)。
- 融资数据后台用表 / 字段白名单、参数化 SQL、完整主键和乐观条件。事务用 Gateway 确认的 Auth0 ID、permissions 和 operation 设置 `request.auth.*` 后 `SET LOCAL ROLE authenticated`，提交或回滚清除上下文。RLS 保留 read/create/update/delete 与记录归属约束，不接受浏览器提供的权限集合。

## 数据与日志

- D1 不存研报正文。政策正文在 `policy_news`，见 [共享数据库](../../docs/DATABASE.md#共享-d1)。热点只读结构化摘要和关键词。
- Worker 日志只记录元数据：事件、状态、范围、Provider 尝试次序、任务类型。
- 另记 effort、reasoning 模式、摘要条数与字符数、Prompt Cache token 数、输出长度和 Gateway log ID。
- 日志不含 token、连接串、推理摘要正文、完整 AI 输入输出、完整文章正文、授信源文件路径和 Excel 内容。
- Data / API 错误可返回结构化安全诊断：接口路径、HTTP 状态、错误码、数据源和处理阶段。
- 诊断还可含限长的字段路径、收到类型和标量值。
- 对外错误不返回堆栈、Cookie、token、签名 URL、连接串、完整正文或大段原始响应。详细堆栈只进服务端日志。

## MCP

`/api/mcp` 只消费 Gateway 已验证的用户。目录与每次执行经 IDENTITY 私有桥接向 Gateway 查询真实路由权限，再调用原业务接口。详见 [MCP](MCP.md)。
