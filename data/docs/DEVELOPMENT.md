# Data 开发与验证

依赖由[根 workspace](../../pnpm-workspace.yaml)统一管理，安装见[根 README](../../README.md#开发)。命令见 [AGENTS](../AGENTS.md#commands)，脚本以 [package.json](../package.json) 为准。

## Worker 验证

默认交付运行 `pnpm check`、`pnpm deploy:dry` 和 `git diff --check`。`pnpm check` 已串联类型生成、OpenAPI 生成、类型检查与测试。生成文件变化时先检查来源，不手工修补。

CPU 相关变更另跑 `pnpm benchmark:cpu` 和 `pnpm check:startup`，并按 [CPU 预算](CPU_BUDGET.md)取生产证据。本地 dry-run 和单元测试不能证明生产 CPU 达标。

VPC 连通性测试必须部署到 Cloudflare edge：

```bash
pnpm exec wrangler deploy --config wrangler.vpc-smoke.jsonc
curl https://eastmoney-data-vpc-smoke.hasbai.workers.dev/dm
curl https://eastmoney-data-vpc-smoke.hasbai.workers.dev/camel
pnpm exec wrangler delete --config wrangler.vpc-smoke.jsonc
```

Smoke 只返回连通性、HTTP 状态，不返回 DM 正文或凭据。`wrangler dev --remote` 的 VPC 远程 binding 会在本地超时，office 网络、VPC service 和 tunnel 均正常。以部署后的 edge smoke 判定 VPC 健康。

## 发布

只提交任务文件，推送后核对远端。部署后检查线上版本、受影响资源和真实 VPC smoke。

## Choice 运维

Choice 会话由 `CHOICE_SESSION` 持有，机制、令牌有效期和排障见[原生协议](modules/choice-native.md)。
Choice 返回 `login count up to limit` 时，同一账号被另一个客户端占用。核对没有桌面客户端或本地脚本登录该账号，等待令牌到期或调用 `reset()`。重试无法绕过会话上限。

宿主 cloudflared 和 VPC 状态只影响 DM 与 CAMEL，要实时核验。

## Secrets

Worker 生产 Secret：

```bash
pnpm exec wrangler secret put DM_COOKIE
pnpm exec wrangler secret put CHOICE_CREDENTIALS
pnpm exec wrangler secret put CHOICE_SERVERS
pnpm exec wrangler secret put CF_AIG_TOKEN
pnpm exec wrangler secret put CAMEL_USERNAME
pnpm exec wrangler secret put CAMEL_PASSWORD
```

Worker Secrets `CHOICE_CREDENTIALS` 和 `CHOICE_SERVERS` 持有 Choice 账号和服务器清单。本地 `.dev.vars` 和 `.env` 已被 Git 忽略。

## 权限专项验证

测试账号覆盖按[共享 AUTH](../../docs/AUTH.md#程序化权限测试)执行。`pnpm test:auth` 运行 `tests/access.test.ts`。真实登录用 Gateway 的 `pnpm auth:verify`，不在本项目复制登录实现。

Gateway 联调脚本 `node scripts/verify-integration.mjs` 覆盖真实 Data handler。Choice 探针用缺参数的 422，不消耗额度。

发布后核对 `GatewayData` 与 `InternalData` 均可用。本 Worker 无 routes、workers.dev、preview 和 Custom Domain，默认 fetch 返回 404。

MCP 的 SDK 契约测试在 `tests/mcp.test.ts`，本地基准为 `pnpm exec tsx scripts/benchmark-mcp.ts`。线上用户验证用 Gateway 的 `scripts/verify-mcp-oauth.mjs`，经统一 `/mcp` 验证目录、Data 查询和刷新。
