---
name: install-mcp
description: 在 AIWork、OpenCode、Codex 或 ChatGPT 中安装和配置 Eastmoney 远程 MCP，处理不支持自动注册、client_id、CIMD、OAuth 登录及回调错误。用于客户端接入，不用于部署 MCP 服务器。
---

# 安装 Eastmoney MCP

将已有远程服务接入用户指定的客户端。服务地址为 `https://eastmoney.hasbai.xyz/mcp`，传输为 Streamable HTTP，认证为 OAuth 授权码 + PKCE。无需安装本地 MCP 服务、npm 包、代理门户或项目源码。

## 识别与修改

1. 从会话及本机安装信息识别客户端、版本、所用 OpenCode 内核和当前配置范围。能直接查明的信息不重复询问；无法识别时再问客户端名称及版本。
2. 先发现宿主已有的 Eastmoney 连接；如果已经可用，不重复添加。需要安装时，定位客户端实际读取的配置或 MCP 设置入口，再做最小修改。保留其他服务器、模型、权限设置及 JSONC 注释；不要用下面的示例覆盖整个配置文件。
3. AIWork 可能使用独立配置目录、活动 profile 或 `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR` / `OPENCODE_CONFIG_CONTENT` 覆盖。优先通过客户端自己的设置保存；编辑文件前确认其为持久配置来源。不要假定系统 `opencode` 与 AIWork 共用配置，也不要只改会被客户端重建的临时文件。不输出环境变量全文、认证缓存或配置中的密钥。
4. 用户要求安装时直接完成可执行的配置与检查；只有没有本地操作能力时才给出对应片段。不要为了接入去修改服务端 Auth0、开放 DCR 或改变组织策略。

## AIWork 与旧版 OpenCode

2026-10-27 检查的本地 `AiWork-sec 1.6.0` 内置 `OpenCode 1.18.18`：支持显式 OAuth clientId，未接通 CIMD 自动识别。此结论只适用于该构建；其他版本先检查其实际配置 schema。

对这一构建，在 MCP 接入方式中选择“有 client_id / client_secret”，填写：

| 字段 | 值 |
| --- | --- |
| 名称 | `eastmoney` |
| 类型 | 远程 / Streamable HTTP |
| URL | `https://eastmoney.hasbai.xyz/mcp` |
| client_id | `https://opencode.ai/oauth/opencode/client.json` |
| client_secret | 留空，不生成也不填占位值 |

使用旧版 OpenCode JSON 配置时，服务器直接放在 `mcp.eastmoney`，OAuth 键名为 camelCase：

```json
{
  "mcp": {
    "eastmoney": {
      "type": "remote",
      "url": "https://eastmoney.hasbai.xyz/mcp",
      "enabled": true,
      "oauth": {
        "clientId": "https://opencode.ai/oauth/opencode/client.json"
      }
    }
  }
}
```

这个 URL 就是服务端已登记的公开客户端 ID，不是密钥，也不是让 Agent 下载后自行注册。省略 `clientSecret`；不要改成 `oauth: false` 或添加手工 Bearer token。

保存后，从 AIWork 的 Eastmoney 连接发起登录；仅对独立 OpenCode 或已确认使用相同配置环境的内置 CLI，使用 `opencode mcp auth eastmoney`。AIWork 上述构建默认回调是 `http://127.0.0.1:19876/mcp/oauth/callback`，已在服务端兼容范围内，不必手填。

## 支持 CIMD 的 OpenCode V2

确认实际版本支持 CIMD 后，只配 URL。V2 使用 `mcp.servers.eastmoney`，不能套用旧版结构：

```json
{
  "mcp": {
    "servers": {
      "eastmoney": {
        "type": "remote",
        "url": "https://eastmoney.hasbai.xyz/mcp"
      }
    }
  }
}
```

通过 `/mcps` 或 `opencode mcp auth eastmoney` 发起登录。默认不设置 OAuth client ID、secret 或 redirect URI；自定义 `oauth.redirect_uri` 会使 V2 的 CIMD 自动路径回退到 DCR。需要显式预登记配置时，V2 使用 `oauth.client_id`，不要使用旧版 `clientId`。V2 启用状态使用 `disabled`，不要添加旧版 `enabled`。

## Codex、ChatGPT 与其他客户端

- Codex：复用现有 Eastmoney 连接。新增时仅为 `mcp_servers.eastmoney` 配置 `url = "https://eastmoney.hasbai.xyz/mcp"`，再通过 `codex mcp login eastmoney` 发起授权。使用当前版本自带的 CIMD；不要填 OpenCode 的 client ID。
- ChatGPT：在连接器设置中添加同一 URL，认证选择 OAuth，额外 client ID / secret 留空，由宿主使用官方 CIMD。已经安装并连接本插件时，直接发现工具，无需重复添加。
- 其他自研客户端：不能仅凭“支持 MCP”判断 OAuth 兼容。需要支持 Streamable HTTP、OAuth 发现、PKCE 及服务端已登记的客户端身份和回调。支持 CIMD 的客户端无需登记，直接发起授权即可，Auth0 自动注册。仅 DCR 或固定 client_id 的客户端不被接受；不要套用 Codex、ChatGPT 或 OpenCode 身份。

## 授权与验收

配置完成后，由用户在客户端的授权流程中自行完成登录和同意；Agent 不代填密码、验证码，不读取或复制 token。需要用户操作时，明确告知当前已完成配置、下一步是在哪个客户端登录。禁止使用浏览器自动化执行权限登录或登录验收。

使用有权访问本站且邮箱已验证的 `18.cn` 账号。客户端负责保存和刷新凭据，配置文件中不写 access token、refresh token、Cookie 或 client secret。不能用网页会话 token 替代 MCP OAuth。

登录后通过同一个客户端检查连接状态，并让宿主重新发现工具；必要时重新连接或开始新会话。工具目录按用户权限筛选，不能把历史“38 项”当作每个账号的固定验收数量。选一个已发布的轻量只读工具，按实际 schema 调用一次，例如具备权限时调用 `trading_days`；不要调用写入、上传、删除、消息或付费 Choice 查询来测试安装。

分别报告“配置已保存”“授权已完成”“工具发现成功”“只读调用成功”的实际结果。没有在目标客户端完成的步骤必须标明待完成；独立 HTTP 验证不等于 AIWork 界面登录成功。

## 故障定位

| 现象 | 处理 |
| --- | --- |
| 不支持自动注册 / 缺少 registration_endpoint | 服务当前关闭 DCR。AIWork 上述构建使用显式 `clientId`；支持 CIMD 的 V2 检查版本、schema 和自定义 redirect URI。不要反复触发注册。 |
| invalid_client | 检查该客户端身份是否已登记、client ID 是否精确、camelCase / snake_case 是否符合版本，是否误填 secret。 |
| redirect_uri 不允许 | 检查回调路径和本地监听器是否一致。OpenCode 已登记 `http://127.0.0.1/callback`、`http://localhost/callback`、`http://127.0.0.1/mcp/oauth/callback`，loopback 端口可变化；不要任意换路径或外网域名。 |
| 401 | 未认证的初次请求返回 401 是正常发现流程。授权后仍出现时，检查同一客户端是否拿到有效授权；不要复制其他客户端 token。 |
| 403 / 组织、邮箱或工具权限拒绝 | 核对账号、邮箱验证和本站权限，由管理员处理；不要关闭组织限制或扩大权限以通过安装。 |
| TLS / 网络失败 | 分别检查服务域名和授权域名 `auth.hasbai.xyz` 的连通性及客户端代理；不要关闭 TLS 校验。 |
| auth0.auth0.com/device/denied | 这是 Auth0 管理 CLI 的设备授权失败，不能据此认定 Eastmoney MCP 不兼容。普通客户端安装不需要执行 `auth0 login` 或申请管理权限。 |

修正已查明的配置问题后重试。若客户端仍复用失败的旧授权，只使用该客户端针对 Eastmoney 的重新授权或注销功能，不清空全部凭据；操作前明确它会退出此连接。仍失败时报告客户端版本、失败阶段和脱敏错误，不无限重试或改服务端策略。

配置格式参考：[OpenCode V1](https://docs.opencode.ai/docs/mcp-servers/)、[OpenCode V2](https://opencode.ai/v2/docs/mcp-servers)、[官方 OpenCode 客户端元数据](https://opencode.ai/oauth/opencode/client.json)。
