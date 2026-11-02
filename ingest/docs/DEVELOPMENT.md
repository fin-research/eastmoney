# 开发、维护与发布

依赖由[根 workspace](../../pnpm-workspace.yaml)统一管理，安装见[根 README](../../README.md#开发)。

## 本地验证

```bash
pnpm types
pnpm db:migrate:local
pnpm check
pnpm test
pnpm deploy:dry
git diff --check
```

- `pnpm types` 按 `wrangler.jsonc` 更新 Worker binding 类型。
- `pnpm check` 检查 Worker TypeScript 与生成的 binding 类型。
- `pnpm test` 用 Vitest Workers pool，不访问真实生产资源。
- `pnpm deploy:dry` 验证打包与绑定，不发布。
- `article` Workflow 由研报采集按文章创建实例。有新增央行资讯时，才为整批创建一个 `telegram` Workflow。两者都可在 Cloudflare Workflow 实例中逐步排查。

## 调度

Cloudflare 原生 Workflow schedule 的创建接口曾返回 403、code `10208`（账户未启用所需计划），因此定时触发由 Messenger 的分钟 Cron 承担。再次尝试原生 schedule 前，须重查账户资格和 API 响应，本地 dry-run 不能证明可创建。

## 资源初始化

仅用于首次配置或明确的迁移任务：

```bash
pnpm exec wrangler whoami
pnpm exec wrangler secret put CF_AIG_TOKEN
pnpm exec wrangler d1 create eastmoney --location apac
pnpm db:migrate:remote
pnpm exec wrangler r2 bucket info article
```

资源名称和 binding 以 `wrangler.jsonc` 为准。

## R2 与 AI Search 验收

- 日常归档只用 R2 `article` 的 `report/` 与 `policy/`，`type` 分别为文本 `研报`、`政策`。
- 分别检查 R2 归档状态和 AI Search 索引状态，检索日期用原始 `published_at`。
- 一次性迁移的备份和验收记录在本地 `var/research-migration-20260907/`，不提交 Git。

## Git 与发布

- 完成验证后经 monorepo PR 和合并队列进入 `main`，由 Cloudflare Git 自动构建部署。不手动运行 `pnpm deploy:worker`，除非用户明确覆盖该约定。
- 需要发布确认时，检查 Cloudflare 构建和 Worker 健康状态。`git push` 成功不等于线上部署完成。

## 文档维护

- 新命令或交付流程更新本文件。调度依赖更新 `ARCHITECTURE.md`，Workflow 步骤更新目标模块，新增模块在 [AGENTS](../AGENTS.md#context-routing) 登记入口。
- D1 幂等与 migration 更新 `DATABASE.md`。Secret、权限或外部校验更新 `SECURITY.md`。
- 跨仓库表、归档协议与 AI 变更，更新[项目组对应共享专题](../../AGENTS.md#context-routing)。

## 权限专项验证

按[共享 AUTH](../../docs/AUTH.md#程序化权限测试)执行匿名与测试账号覆盖。真实登录在 Gateway 运行 `pnpm auth:verify`。`pnpm test:auth` 运行本仓库的 `access` 与 `data-fetcher` 测试。

测试规范与覆盖率口径见 [TESTING](TESTING.md)。
