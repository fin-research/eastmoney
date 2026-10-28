# 当前所有权

Auth0 配置与 Actions 当前由 [Gateway](../../gateway/auth0/README.md) 维护。以下是旧配置说明与历史来源，不用于恢复 Cloudflare Access。

# Auth0 中文主题与注册资料（历史）

以下正文记录旧 Access 与注册配置，不作为现行部署指令。当前浏览器 Bearer 登录与统一管理应用以 [Gateway Auth0](../../gateway/auth0/README.md) 为准。

账号租户为 `hasbai.eu.auth0.com`，用户登录域名为 `auth.hasbai.xyz`。继续使用 New Universal Login，Auth0 负责密码和身份验证。Access 回调与稳定账号 ID 保持原契约。

## 当前管理入口

后续本地租户管理按[项目组 AUTH 的 Auth0 skill 与 CLI 规范](../../docs/AUTH.md#auth0-本地租户管理)执行。先用 `auth0 tenants list` 检查并复用现有授权。多个 agent 会话不要各自重复 `auth0 login`，修改时只操作已核对的目标资源并回读。

本文件下面的专题脚本保存历史配置细节。依赖已退役 `cli` 机器应用的 Deploy CLI 包装器和 `management()` helper 不再是当前入口。当前套餐的 Universal Login template 402 曾使 Deploy CLI `branding` 导出失败。权限和登录验收禁止 browser，使用 `pnpm test:auth` 与 `pnpm auth:verify`。

## 中文主题

- `branding/theme.json` 映射 `DESIGN.md`：品牌蓝 `#2f6fd6`、冷灰 `#f6f8fb`、白色卡片、8px 控件和 10px 卡片圆角。
- `branding/zh-CN.json` 管理登录、注册和密码重置的中文文案，包括 Identifier First 的 `login-id` / `login-password`、`signup-id` / `signup-password` 以及 `passkeys` prompt 下的两个 Passkey 注册提示。其余错误及验证文案由 Auth0 内置中文翻译提供。Management API 的 prompt 名为 `passkeys`，其 screen 名分别为 `passkey-enrollment`、`passkey-enrollment-local`。
- 上述登录、注册和 Passkey 注册提示的 `description` 使用单个空格隐藏默认说明。不能改为空字符串，否则 Auth0 会恢复“登录／注册以继续使用”的默认文案。启用 Passkey 后使用 `login-id`，只修改 `login` 不会影响该页面。
- 仅启用 `zh-CN`，确保英文浏览器也显示中文。主题和语言是 Auth0 租户级配置。
- `node --use-env-proxy scripts/publish-auth0-branding.mjs` 输出计划。加 `--apply` 发布并回读验证。发布前在系统临时目录保存不含密钥的配置备份，输出备份目录。
- 仅更新文案时增加 `--text-only`，保留线上主题和语言设置。仍先读取、逐屏合并现有文案再 PUT。

## Passkey 与退出

- Passkey 使用 Auth0 原生 Identifier First 流程。连接的 Passkey Authentication UI 支持“按钮与自动填充”。浏览器可在邮箱输入框建议已保存的密钥，用户仍需选择账号并完成设备验证。
- `/auth/logout` 清理本站 Cookie，依次跳转 Auth0 `/v2/logout`、Access 团队 `/cdn-cgi/access/logout`，最后回到本站 `/`。两层 `returnTo` 分别使用 `URLSearchParams` 编码，最终首页只从本站 origin 派生，不接受请求的返回地址。
- 可用 `node --use-env-proxy scripts/verify-auth0-branding.mjs --login-domain=auth.hasbai.xyz --branding-only` 检查实际登录／注册 HTML、Passkey 按钮与自动填充属性，以及全部中文覆盖配置。此选项跳过无关的注册资料 Form 检查。

## 两步注册

当前套餐的 New Universal Login Page Template 返回 402，Partials 返回 403。自定义域名本身已验证且证书就绪。采用 Auth0 Forms 补充注册资料，无需升级套餐：第一步邮箱、密码，第二步姓名、部门。第二步完成后才继续既有邮箱验证流程。

| 字段 | 必填与校验 | Auth0 存储 |
| --- | --- | --- |
| 邮箱 | `18.cn`，既有服务端校验 | `email` |
| 密码 | 既有 Auth0 密码策略 | Auth0 密码凭证 |
| 姓名 | 去除首尾空白，1–50 字符 | `name`、`nickname`、`user_metadata.name` |
| 部门 | 去除首尾空白，1–100 字符 | `user_metadata.department` |

姓名作为显示用户名，允许同名用户。邮箱仍为登录标识，不增加要求唯一的 `username` 凭证。部门由 Auth0 用户详情的 User Metadata 管理。姓名和部门不授予融资角色或关联业务人员。

- `branding/signup-profile-form.json` 是原生 Auth0 Form，标签与按钮为中文，继承 Universal Login 主题。两个字段均必填，结束节点恢复原登录事务。
- `eastmoney-registration.cjs` 保留 `18.cn` 限制，并为新注册用户设置 `app_metadata.eastmoney_signup_profile_pending`。
- `eastmoney-signup-profile.cjs` 在原邮箱验证 Action 之前运行。新注册用户必须完成 Form。恢复时再次校验 Form ID、姓名及部门，只更新当前 Auth0 ID 的白名单字段。保存成功后清除 pending 标记。失败保留标记以供重试。
- 原有账号没有 pending 标记，继续原登录流程。资料填写 Action 与邮箱验证 Action 分离，满足 Auth0 不允许同一个 Action 同时渲染 Form 和重定向的要求。
- 运行时使用独立 M2M 应用 `eastmoney signup profile`，仅授予 `update:users`。不使用或轮换 Worker 密钥。Form 发布临时创建仅有 Form 读写权限的 M2M 应用，并在 `finally` 删除。部署密钥不留在 Action 中。

## 配置和发布

1. Auth0 Custom Domain `auth.hasbai.xyz` 使用 Auth0-managed certificate。DNS-only CNAME 为 `hasbai-cd-j8r0mxglxwb2knim.edge.tenants.eu.auth0.com`。保留该记录用于证书续期。
2. Dashboard 的 `scripts/publish-auth0-signup.mjs` 已退役。Auth0 signup Form、资料 Action、绑定和 M2M 凭据由 Gateway 维护。本地配置变更使用共享 AUTH 所述 Auth0 skill 与 CLI 流程，本仓库旧脚本会直接拒绝执行。
3. Dashboard `AUTH0_LOGIN_DOMAIN` 控制浏览器退出域名，管理服务继续使用 `AUTH0_DOMAIN`。变更后运行 `pnpm worker:typegen`、正式检查和构建，再推送 GitHub 触发自动部署。必要时手动部署 Worker，两种方式均无需再次申请授权。
4. 提供 `CLOUDFLARE_ACCESS_API_TOKEN` 后运行 `node --use-env-proxy scripts/configure-auth0-login-domain.mjs` 查看 Access OIDC 修改计划，加 `--apply` 切换授权、token、JWKS 地址。复用现有客户端密钥、PKCE、claims、scopes 和回调白名单。
5. `node --use-env-proxy scripts/verify-auth0-branding.mjs --login-domain=auth.hasbai.xyz` 检查实际登录／注册 HTML 的中文及配色，并回读 Form 字段和 Action 绑定。它不提交登录、注册或发送邮件，也不打印 Cookie／事务 URL。这是 HTTP 和配置检查，不是浏览器视觉验收。
6. `node scripts/verify-profile-routes.mjs` 在生产构建上验证退出域名、本站 Cookie 清理、固定 Access 退出目标及最终首页。上游为模拟实现。

## 参考

- [Auth0 自定义注册字段的前提](https://auth0.com/docs/customize/login-pages/universal-login/customize-signup-and-login-prompts)
- [Forms 补充注册资料](https://auth0.com/docs/customize/forms/configure-additional-signup-steps)
- [Forms 的 Action 渲染与恢复](https://auth0.com/docs/customize/forms/render)
- [Auth0 中文文案字段契约](https://auth0.com/docs/customize/login-pages/universal-login/customize-text-elements)
