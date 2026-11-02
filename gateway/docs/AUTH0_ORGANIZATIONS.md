# Eastmoney Auth0 组织与应用边界

Eastmoney 在共享租户 `hasbai.eu.auth0.com` 内使用组织 `org_6yvoRRCkzk3eGkBS`，组织限定业务用户身份。管理 API、签名密钥、登录域名、邮件服务、套餐和租户管理员由整个租户共用。账号与权限规则见 [AUTH](../../docs/AUTH.md)。

## 用户应用

- 网站 `eastmoney` 使用授权码 + PKCE。ChatGPT、Codex、OpenCode 的 MCP 客户端使用官方 CIMD，精确 ID 见 [MCP](MCP.md)。两类登录都在 Eastmoney 组织内进行，Gateway 校验签名 `org_id`，CIMD token 只准入 `/mcp`。
- 当前 `login claims` Action 的行为见 [Auth0 配置](../auth0/README.md#登录-action)。
- `eastmoney-email` 是 domain connection，用于严格的第三方登录。本组织允许 third-party user flow，每个 CIMD 客户端有独立的 API user grant，未开放全体第三方默认授权。其他连接不变。
- `eastmoney gateway management` 机器应用供 Gateway 身份服务和注册资料保存使用，见[管理应用](../auth0/README.md#管理应用)。角色准入使用 JWT 声明和授权缓存。

## 隔离

- 网站与 MCP 用户都绑定本组织，账号目录和成员角色限定在本组织。
- 当前套餐不支持 M2M Organizations。Gateway 的机器客户端白名单为空。
- 恢复机器 Choice 调用时，须重新登记客户端、scope 和白名单，并验证 `gty=client-credentials`、机器 subject、audience 和 Choice 路由边界。
- 缺少本组织 `org_id` 的用户 token、未登记的机器客户端和跨组织 token 一律拒绝。

## 变更

按[本地租户管理](../../docs/AUTH.md#auth0-本地租户管理)操作。变更网站、MCP 或组织关联后，按 [DEVELOPMENT](DEVELOPMENT.md) 做程序化登录与只读探针，并确认机器身份被拒绝。回退时逐项恢复受影响的应用和成员关系，不做整租户导入，以免覆盖其他应用的改动。
