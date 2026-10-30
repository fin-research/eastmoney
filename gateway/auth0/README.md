# Auth0 配置

本站应用 `eastmoney` 使用自定义登录域 `auth.hasbai.xyz`，管理 API 使用租户域 `hasbai.eu.auth0.com`，API audience 为 `https://eastmoney.hasbai.xyz/`。使用 New Universal Login，Auth0 负责密码和身份验证，发布用 `auth0` CLI。登录域 CNAME 指向 `hasbai-cd-j8r0mxglxwb2knim.edge.tenants.eu.auth0.com`，使用 Auth0 托管证书，保留该记录用于续期。

登录架构与 token 规则见 [AUTH](../../docs/AUTH.md)，租户操作流程见 [本地租户管理](../../docs/AUTH.md#auth0-本地租户管理)，组织与应用边界见[组织与应用边界](../docs/AUTH0_ORGANIZATIONS.md)，交付见 [DEVELOPMENT](../docs/DEVELOPMENT.md)。

## 登录 Action

post-login 只绑定 `eastmoney signup profile`（`91736f7a-024c-406d-905b-7d2daa20ec8f`），显示名为 `login claims and profile`，源码为 `actions/login-claims.cjs`。线上状态用 Auth0 CLI 读取，不从本地文件推断。

- [login-claims.cjs](actions/login-claims.cjs)：本组织 email 连接账号缺少姓名或部门时显示注册资料 Form，保存成功后以返回的新资料签发声明。写入顶层 `username`、`email`、`role`、`_roles`，本站组织另有可选 `department`、`picture`。拒绝封禁账号和未验证邮箱。`tpc_` 第三方 MCP 客户端改写签名 claim `https://eastmoney.hasbai.xyz/identity`，见 [MCP](../docs/MCP.md)。
- `role` 供数据库使用，不用于业务授权。`_roles` 由 Gateway 按组织权限缓存解析为角色 ID。
- 姓名和部门不授予权限，也不自动关联业务负责人。
- 旧 `login claims`（`35884b07-e1f4-4ab8-b66c-0325d5a055e4`）保留但未绑定。回退时部署原资料 Action 版本，再按原顺序绑定资料 Action 和旧 `login claims`。
- 基础角色来自 Auth0 组织成员关系，Action 不自动分配。

发布 Action 只修改目标 code，保留 Secret、依赖和 post-login 绑定，并避免覆盖其他会话未发布的草稿。

## SPA 客户端

`eastmoney` 客户端为 `spa`、`token_endpoint_auth_method=none`，无 M2M grant。保留 callback、logout URL、web origins、organization 和授权码 grant。token 时长由 API 配置控制，Gateway 按签名 `exp` 校验。

## 管理应用

`eastmoney gateway management` 声明在 [gateway-management-client.yaml](gateway-management-client.yaml)，供 Gateway 身份服务和注册资料 Action 读写用户与角色。Gateway 的 `AUTH0_MANAGEMENT_*` 与注册资料 Action 的 `PROFILE_CLIENT_*` 使用同一凭据，Secret 不进入声明文件。

## 中文主题

- `branding/theme.json` 映射 [DESIGN](../../dashboard/DESIGN.md)：品牌蓝 `#2f6fd6`、冷灰 `#f6f8fb`、白色卡片、8px 控件和 10px 卡片圆角。
- `branding/zh-CN.json` 管理登录、注册和密码重置的中文文案。涉及 prompt：`login-id`、`login-password`、`signup-id`、`signup-password`，以及 `passkeys` 下的 `passkey-enrollment`、`passkey-enrollment-local`。其余文案用 Auth0 内置中文翻译。
- 登录、注册和 Passkey 注册提示的 `description` 用单个空格隐藏默认说明。不能写空字符串，否则 Auth0 恢复默认文案。启用 Passkey 后登录页是 `login-id`，只改 `login` 不影响它。
- 仅启用 `zh-CN`，英文浏览器也显示中文。主题与语言是租户级配置。

## Passkey

用 Auth0 原生 Identifier First 流程。连接的 Passkey Authentication UI 设为“按钮与自动填充”。浏览器可在邮箱输入框建议已保存的密钥，用户仍须选择账号并完成设备验证。

## 两步注册

当前套餐的 New Universal Login Page Template 返回 402，Partials 返回 403，所以用 Auth0 Forms 补充注册资料：第一步邮箱、密码，第二步姓名、部门。第二步完成后才继续邮箱验证。

| 字段 | 必填与校验 | Auth0 存储 |
| --- | --- | --- |
| 邮箱 | `18.cn`，服务端校验 | `email` |
| 密码 | Auth0 密码策略 | Auth0 密码凭证 |
| 姓名 | 去除首尾空白，1–50 字符 | `name`、`nickname`、`user_metadata.name` |
| 部门 | 去除首尾空白，1–100 字符 | `user_metadata.department` |

- 姓名用作显示名，允许同名。邮箱是登录标识，不增加要求唯一的 `username`。姓名和部门不授予角色，也不关联业务人员。
- `branding/signup-profile-form.json` 是原生 Auth0 Form，标签与按钮为中文，继承主题。两个字段必填，结束节点恢复原登录事务。
- `actions/login-claims.cjs` 渲染 Form，恢复时再校验 Form ID、组织、连接、姓名和部门，只更新当前 Auth0 ID 的白名单字段。保存失败拒绝登录，不签发声明。
- `actions/eastmoney-registration.cjs`、`actions/eastmoney-signup-profile.cjs` 是历史实现，不代表线上代码，不要重新发布其 pending 标记逻辑。

## Actions 与 Forms 额度

免费套餐含 5 项 Actions + Forms，额度按订阅共享，只统计已绑定并部署的 Action 与已创建的 Form。[Auth0 额度说明](https://support.auth0.com/center/s/article/managing-auth0-actions-and-forms-quota-exceedance-notifications)。2026-10-30 本租户合并前为 3 个 Action 和 1 个 Form，共 4 项；合并后为 2 个 Action 和 1 个 Form，共 3 项。该盘点不证明同订阅其他租户的用量。
- 凭据见 [管理应用](#管理应用)，不写入 Action 代码。

## 参考

- [自定义注册字段的前提](https://auth0.com/docs/customize/login-pages/universal-login/customize-signup-and-login-prompts)
- [Forms 补充注册资料](https://auth0.com/docs/customize/forms/configure-additional-signup-steps)
- [Forms 的 Action 渲染与恢复](https://auth0.com/docs/customize/forms/render)
- [中文文案字段契约](https://auth0.com/docs/customize/login-pages/universal-login/customize-text-elements)
