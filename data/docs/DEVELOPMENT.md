# Data 开发与验证

JavaScript依赖由[根workspace](../../pnpm-workspace.yaml)统一管理，使用Node 24和根packageManager指定的pnpm。`pnpm install --frozen-lockfile`自动使用根锁；只装本项目时在根目录运行 `pnpm --filter ./data --filter . install --frozen-lockfile`。不维护子项目锁文件。

常用命令见 [AGENTS](../AGENTS.md#commands)，脚本以 [package.json](../package.json) 为准。跨项目工作树规则见 [项目组 AGENTS](../../AGENTS.md#parallel-development)。

## Worker 验证

```bash
pnpm install
pnpm check
pnpm benchmark:cpu
pnpm check:startup
pnpm deploy:dry
```

三条 VPC 连通性测试必须部署到 Cloudflare edge：

```bash
pnpm exec wrangler deploy --config wrangler.vpc-smoke.jsonc
curl https://eastmoney-data-vpc-smoke.hasbai.workers.dev/dm
curl https://eastmoney-data-vpc-smoke.hasbai.workers.dev/choice
curl https://eastmoney-data-vpc-smoke.hasbai.workers.dev/camel
pnpm exec wrangler delete --config wrangler.vpc-smoke.jsonc
```

Smoke 只返回连通性、HTTP 状态和 RPC 契约版本，不返回 DM 正文或凭据。Wrangler
`dev --remote` 的 VPC remote binding 在历史排查中曾出现本地超时，不能据此判定生产 VPC
故障。以部署后的 edge smoke 为准。

## 默认交付

执行 `pnpm typegen`、`pnpm typecheck`、`pnpm test`、`pnpm check`、`pnpm deploy:dry`、`git diff --check`。`pnpm check` 已串联类型生成、OpenAPI 生成、类型检查与测试。生成结果变化必须检查来源，不能手工修补生成文件。

只提交任务文件，推送后核对远端。必要手动部署已授权，无需再次询问。部署后检查线上版本、受影响资源及真实 VPC smoke。CPU 变化时加做 [CPU 预算验证](CPU_BUDGET.md)，不能以单元测试或本地 dry-run 宣称生产 CPU 达标。

## Office 运维所有权

Choice 镜像、SDK、受限 env file 与容器恢复只按 [Choice 开发文档](../../choice/docs/DEVELOPMENT.md) 操作。Data 只维护 VPC 客户端和 Worker binding。不要在本仓库维护第二套 office 安装命令。

历史版本、切换与故障证据见 [MIGRATION](MIGRATION.md)。宿主 cloudflared / 容器状态与 WUD 运行状态必须实时核验，不能把历史 SSH 记录当成现状。

## Secrets

Worker 生产 Secret：

```bash
pnpm exec wrangler secret put DM_COOKIE
pnpm exec wrangler secret put CHOICE_RPC_TOKEN
pnpm exec wrangler secret put CF_AIG_TOKEN
pnpm exec wrangler secret put CAMEL_USERNAME
pnpm exec wrangler secret put CAMEL_PASSWORD
```

office 主机的 `CHOICE_AUTH` 只存在受限 env file。Worker 不持有 Choice 账号。
`.dev.vars`、`.env` 和所有真实凭据均不得提交。

## 文档维护

公共协议在 API，内部依赖在 ARCHITECTURE，CAMEL 会话在模块文档。跨仓库职责和存储归属回到项目组 docs。新增资源更新代码契约和 [AGENTS 的模块分流](../AGENTS.md#context-routing)，不复制完整端点清单。

## 权限专项验证

按 [共享 AUTH](../../docs/AUTH.md#程序化权限测试) 执行本仓库匿名/测试账号覆盖。权限验收禁止 browser。真实登录统一使用 Gateway 的 `pnpm auth:verify`，凭据只从项目组根 `.env` 读取，不复制登录实现或密码到各仓库。

本站公网流量由 Gateway 按 `/data` 分流，Data 不再配置 Access 应用或 Service Token。发布后核对 `GatewayData` 与 `InternalData` 均可用，且本 Worker 无 routes、workers.dev、preview 或 Custom Domain，默认 fetch 404。原 `InternalData` 消费者保持可用。

MCP 的 SDK 契约测试在 `tests/mcp.test.ts`，本地基准为 `pnpm exec tsx scripts/benchmark-mcp.ts`。线上真实用户验证使用 Gateway `scripts/verify-mcp-oauth.mjs`，通过统一 `/mcp` 验证目录、Data/业务查询和刷新；旧公网 Data MCP 入口返回410。

## 测试分层与覆盖率

测试规范与覆盖率口径见 [TESTING](TESTING.md)。
