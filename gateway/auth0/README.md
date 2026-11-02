# Auth0 配置

本站应用 `eastmoney` 使用自定义登录域 `auth.hasbai.xyz`，管理 API 使用租户域 `hasbai.eu.auth0.com`，API audience 为 `https://eastmoney.hasbai.xyz/`。

登录架构与 token 规则见 [AUTH](../../docs/AUTH.md)，租户操作流程见 [本地租户管理](../../docs/AUTH.md#auth0-本地租户管理)，组织与应用边界见[组织与应用边界](../docs/AUTH0_ORGANIZATIONS.md)，交付见 [DEVELOPMENT](../docs/DEVELOPMENT.md)。

## 登录 Action

post-login 绑定两个 Action：注册资料 Action 和 `login claims`（`35884b07-e1f4-4ab8-b66c-0325d5a055e4`）。线上状态用 Auth0 CLI 读取，不从本地文件推断。

- [login-claims.cjs](actions/login-claims.cjs)：写入顶层 `username`、`email`、`role`、`_roles`，本站组织另有可选 `department`、`picture`。拒绝封禁账号和未验证邮箱。三个 MCP 客户端改写签名 claim `https://eastmoney.hasbai.xyz/identity`，见 [MCP](../docs/MCP.md)。
- `role` 供数据库使用，不用于业务授权。`_roles` 由 Gateway 按组织权限缓存解析为角色 ID。
- `eastmoney-signup-profile` 只处理新账号的 pending 标记。姓名和部门不授予权限，也不自动关联业务负责人。
- 基础角色来自 Auth0 组织成员关系，Action 不自动分配。
- `actions/eastmoney-login.cjs` 实现旧 nested `user` 协议。网站已拒绝该协议，发布会破坏登录。

发布 Action 只修改目标 code，保留 Secret、依赖和 post-login 绑定，并避免覆盖其他会话未发布的草稿。

## SPA 客户端

`eastmoney` 客户端为 `spa`、`token_endpoint_auth_method=none`，无 M2M grant。保留 callback、logout URL、web origins、organization 和授权码 grant。token 时长由 API 配置控制，Gateway 按签名 `exp` 校验。

## 管理应用

`eastmoney gateway management` 声明在 [gateway-management-client.yaml](gateway-management-client.yaml)，供 Gateway 身份服务和注册资料 Action 读写用户与角色。Gateway 的 `AUTH0_MANAGEMENT_*` 与注册资料 Action 的 `PROFILE_CLIENT_*` 使用同一凭据，Secret 不进入声明文件。
