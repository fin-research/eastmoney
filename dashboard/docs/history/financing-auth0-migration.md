# 历史融资 Auth0 迁移记录

历史档案，不得照此重新部署 Action 或 Worker。当前身份规则以 `docs/SECURITY.md`、`auth0/README.md` 和管理模块为准。

# Auth0 / Access 迁移

统一入口为 `https://eastmoney.hasbai.xyz/auth/login`。身份链路为 Auth0 → Cloudflare Access → Worker。finance 的业务身份仍绑定原 `people.id`，任务负责人和审计归属不变。

## 配置

- Auth0 租户：`hasbai.eu.auth0.com`，应用 `eastmoney` 使用 Regular Web Application / Authorization Code。
- 邮箱连接：`eastmoney-email`，仅此连接对 eastmoney 启用。只接受 `18.cn` 邮箱，新账号验证后登录。
- Access 团队：`hasbai.cloudflareaccess.com`，同一个 eastmoney 应用覆盖统一登录和受保护业务路径。混合读取／写入的 Dashboard API 由 Worker 区分方法并验证 Cookie 中的 Access JWT。
- financing 使用 `AUTH_PROVIDER=auth0-access`，固定的 `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`，以及 Auth0 域名、客户端 ID 和角色 ID 映射。
- `AUTH0_MANAGEMENT_CLIENT_SECRET` 仅在 Worker Secret 中保存。Management 客户端使用 read/create/update users 与 read/update roles。服务令牌按服务有效期缓存，用户授权仍按每次写请求实时读取。
- Dashboard 和 ingest 通过 Data 的 `InternalData` Service Binding。quant 使用独立 Access Service Token。服务身份不允许执行用户操作。

## 账号和权限

2026-09-07 批量迁移 6 个账号：admin 3、handler 2、reviewer 1。三类角色各保留原七类权限，未重设密码。Auth0 用户 ID 固定为 `auth0|<原 Neon UUID>`，由签名的 `custom.eastmoney_user_id` 传到 Worker。

现有 scrypt 参数为 N=16384、r=16、p=1、keylen=64。盐值虽然以十六进制文本展示，参与计算的是 UTF-8 文本，不能按十六进制解码。迁移前以合成账号实测普通字符可直接登录。Neon 对密码做 NFKC 规范化，Auth0 原生导入不做这一处理，已由账号负责人确认现有密码不包含此类特殊字符。

迁移账号保持原 `email_verified` 状态。Post Login Action 的迁移例外同时绑定原 UUID、Auth0 ID 和原邮箱。改邮箱后需要验证新邮箱。新注册账号没有融资角色和人员关联，可以使用 Dashboard 登录功能。融资管理员可在人员页关联已注册邮箱，或在 Auth0 配置融资角色，仍需保持明确的人员关联。

## 发布顺序

1. 对账原账号和角色权限，以受限临时文件导出哈希。导入前验证密码格式，不覆盖已存在账号。
2. 建立 Auth0 邮箱连接、角色、API 权限、Actions 和 Access 身份提供商。批量导入后逐项对账 ID、邮箱、验证状态、角色和 permissions。
3. Data 先发布 `legacy` 兼容模式和 `InternalData`。Dashboard、ingest 和 quant 再切换调用通道。
4. 在隔离 Neon 分支验证 `0025_auth0_identity.sql` 与 `0026_auth0_request_context.sql`。授权有效时可读取原业务行，过期授权必须返回零行。生产用 `scripts/init-database.mjs` 执行并登记 migration。
5. Secret 就绪后发布 financing Auth0 模式和 Dashboard Access 保护，再启用 Data 公网保护与 Access 业务路径。检查公开页面、匿名写入、登录、服务令牌和私有 binding。
6. 新链路确认后执行 `0027_retire_neon_identity.sql`，移除旧身份列／外键及函数依赖，再关闭 Neon Auth 并删除其身份 schema。同时删除已停用的 Neon Data API。业务 schema 保留。部署配置只能使用 `auth0-access`，缺失或错误配置返回服务不可用。

账号导入脚本仅用于一次性迁移。含哈希、Token 或 Secret 的文件必须位于仓库外的受限目录，不纳入版本控制。CLI 配置脚本默认先输出计划，真实导入显式使用 `--apply --confirmed-compatible-passwords`。未经对账不能用 upsert 覆盖现有密码。

## 验收边界

- 单元和类型检查覆盖登录域名、迁移 ID、权限边界、查询白名单、参数化写入和乐观锁。
- 数据后台使用同一 Hyperdrive 连接内的事务身份上下文和 `SET LOCAL ROLE authenticated`，不依赖 Neon Auth 给浏览器签发令牌。
- 旧认证关闭之前可以回退旧应用。旧 schema 删除之后必须从迁移备份恢复才可回退。不能把关闭新保护当作完成迁移。

## 生产验收记录（2026-09-07）

- 六个账号全部导入并完成 ID、角色、权限和邮箱状态对账。原管理员账号用原密码通过 Auth0 → Access → Dashboard 回调。签名 JWT 中的稳定身份声明已核验。
- 登录后交易研究工作台、融资首页、人员管理和数据后台查询均返回 200。未登录首页、市场点评和二级池保持公开。匿名 Data／交易工作台跳转统一登录，跨站写请求返回 403。
- Data 公网强制 Access 验证，Workers.dev 同样受保护。Dashboard、ingest 的私有 `InternalData` binding 和 Quant 专用服务身份已切换。Quant 令牌到期日为 2027-09-07，后续需在到期前更新。
- `0025`、`0026`、`0027` 已通过正式 migration runner 应用生产。生产 `neon_auth` schema、旧人员身份列和 Neon Data API 已删除。保留 6 条人员映射和 9,735 条负债记录。
- 隔离分支删除旧身份 schema 后，授权仍可读取业务行。授权过期返回零行。自动化回归还验证了写入审计保留原人员归属。
- 修复 Workers 不支持 `redirect: error` 导致的 Auth0 请求失败：使用 `manual` 并拒绝全部 3xx，凭证不随跳转发送。诊断日志只记录阶段、状态和错误代码，不记录用户信息或凭证。
- 完成 HTTP 协议登录与只读线上验证。没有执行浏览器视觉验收、真实业务写入或付费 AI 调用。
