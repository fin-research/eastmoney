# Eastmoney MCP

客户端连接 `https://eastmoney.hasbai.xyz/mcp`，使用 Streamable HTTP 和 Auth0 OAuth 授权码 + PKCE。ChatGPT 与 Codex 的配置、工具目录见 [Dashboard MCP](../../dashboard/docs/MCP.md)，认证边界见 [AUTH](../../docs/AUTH.md#mcp-边界)。

## 发现与授权

Gateway 在 `/.well-known/oauth-protected-resource` 及其 `/mcp` 子路径公开本站 API resource 与 Auth0 issuer。未登录请求返回 401，`WWW-Authenticate` 指向该文档。Gateway 不代理登录，不签发 token。

Auth0 开启 CIMD discovery、RFC9207 和动态 CIMD 注册，DCR 关闭。动态客户端首次授权时由 Auth0 自动创建（`tpc_` 前缀），统一策略来自租户唯一的 client profile `Dynamic MCP clients`（强制组织登录，refresh token 轮换、最长 30 天、闲置 7 天），以及本站 API 的第三方默认 client grant（`default_for=third_party_clients`，user，scope 为空）。Application Profiles 为 Early Access，每租户一个，不能逐个豁免，改动约 5 分钟生效。

## 客户端

[mcp-auth.ts](../src/mcp-auth.ts) 列出参考客户端（测试与验收用）。Gateway 仅在 `/mcp` 接受 https CIMD `azp` 且要求签名身份声明，不准入普通 REST 或 `/data/mcp`。

| 客户端 | CIMD URL | 类型 | 回调 |
| --- | --- | --- | --- |
| ChatGPT | `https://chatgpt.com/oauth/client.json` | private-key JWT | `https://chatgpt.com/connector_platform_oauth_redirect` |
| Codex | `https://chatgpt.com/oauth/codex/client.json` | public PKCE | loopback `/callback`，动态端口 |
| OpenCode | `https://opencode.ai/oauth/opencode/client.json` | public PKCE | loopback `/callback`，另允许 `localhost` 和 `/mcp/oauth/callback` |

预登记的三个客户端各有独立内部 ID 和本站 API 的 user grant，并强制组织登录；动态客户端使用默认 grant 与 profile。`eastmoney-email` 是 domain connection，本组织允许 third-party user flow。

Auth0 第三方 access token 会过滤保留字段 `email`。因此 [login-claims.cjs](../auth0/actions/login-claims.cjs) 对所有 `tpc_` 第三方客户端写入签名的 `https://eastmoney.hasbai.xyz/identity`，并校验组织、连接、18.cn 邮箱和邮箱验证。Gateway 只从该 claim 读身份。网站仍用顶层声明。

OpenCode 配置如下，然后执行 `opencode mcp auth eastmoney`。不要设置 `oauth.client_id`、`oauth.client_secret` 或 `oauth.redirect_uri`，自定义 redirect URI 会使 OpenCode 回退到 DCR。旧版或自研分支须已支持 CIMD，见 [OpenCode 说明](https://opencode.ai/v2/docs/mcp-servers#client-registration)。

```json
{
  "mcp": {
    "servers": {
      "eastmoney": { "type": "remote", "url": "https://eastmoney.hasbai.xyz/mcp" }
    }
  }
}
```

新增 CIMD 客户端无需登记，客户端发起授权时自动注册。仅需独立策略时，用 Auth0 CLI 的 `clients/cimd/preview` 与 `clients/cimd/register` 手动导入，并单独配置 user grant、组织登录和刷新策略。线上绑定的 Action 是合并了注册资料逻辑的 `eastmoney signup profile`，与仓库源码不完全一致，以 Auth0 线上版本为准。

参考：[Auth0 CIMD 配置](https://auth0.com/docs/get-started/auth0-overview/create-applications/register-applications-with-cimd)。

## 工具聚合

Gateway 用无状态 MCP SDK 聚合 Dashboard 25 项和 Data 22 项工具，工具名单见 [mcp.ts](../src/mcp.ts)。目录按应用返回的当前用户权限筛选。Schema 和业务执行在应用层，经 `GatewayDashboard` / `GatewayData` 命名 Service Binding 调用，用户 token 不进入应用。

- Dashboard 的授权桥接是 [mcp-bridge.ts](../src/mcp-bridge.ts)，经私有 `IDENTITY` binding 的 `/mcp/policies` 和 `/mcp/dispatch`，按当前角色缓存和真实路由策略校验，再执行原业务 handler。不开放管理员操作。
- Data 使用 Gateway 注入的已验证用户和 Choice 准入上下文，不用 `InternalData`、机器身份或 CAMEL 上下文。
- 二级池 `bond_ledger` 只读，权限同 `/bond` 的 `bond.ledger:read`。上传用 `file_upload_request`（R2 预签名直传）和 `bond_ledger_import`（按 `uploadId` 导入），均需 `bond.ledger:import`，执行时重新检查。
- Data 资讯列表命名 `news_list`。不发布 health、config、stock_summary、下载、删除和 AI 生成工具。
- `research_search` 经 POST `/api/research/search` 读研究 AI Search，权限 `research.article:read`。工具只读，调用时重新检查权限，不转发用户 token，不调用生成模型。
- 旧公网 `/api/mcp`、`/data/mcp` 返回 410，内部路径只供绑定调用。

## 程序化验收

```sh
AUTH_TEST_ENV_FILE=<项目组 .env> node --use-env-proxy scripts/verify-mcp-oauth.mjs
```

脚本覆盖发现、CIMD、成功与错误 issuer、真实账号 PKCE、签名身份、刷新、工具目录（至少 40 项）与只读调用，以及普通 REST/Data 拒绝。

- `MCP_EVIDENCE_DIR` 保存工具目录和二级池业务回包，不保存身份或凭据。
- `MCP_OAUTH_CLIENT_ID=https://opencode.ai/oauth/opencode/client.json` 验证 OpenCode。`MCP_OAUTH_REDIRECT_URI` 可检查旧回调 `http://127.0.0.1:53683/mcp/oauth/callback`。
- ChatGPT 的 private-key token exchange 由 ChatGPT 主机完成，脚本只验证其授权与回调。
