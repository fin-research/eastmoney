# Eastmoney

市场研究、融资业务、数据采集和量化模型的公开monorepo。
生产站点为[Eastmoney](https://eastmoney.hasbai.xyz)。

| 项目 | 职责 | 技术 |
| --- | --- | --- |
| [Gateway](gateway/README.md) | 公网入口、认证与权限 | Hono / Cloudflare Worker |
| [Dashboard](dashboard/README.md) | 研究、授信、融资与管理页面及API | SvelteKit / Cloudflare Worker |
| [Data](data/README.md) | 统一数据API与私网上游接入 | TypeScript / Cloudflare Worker |
| [Choice](choice/README.md) | office Choice SDK RPC | C++ / Docker |
| [Messenger](messenger/README.md) | 通知、重试与集中调度 | Worker / D1 / Queue |
| [Ingest](ingest/README.md) | 研报、政策采集与归档 | Worker / Workflows |
| [Quant](quant/README.md) | 本地研究、独立推理与最终研究报告 | Python / uv / Worker |

JavaScript 六项目使用根 `pnpm-workspace.yaml` 的精确 catalog 版本和单一 `pnpm-lock.yaml`。

使用 Node 24、根 `packageManager` 指定的 pnpm 10.33.2；根目录执行 `pnpm install --frozen-lockfile`，
也可在子项目执行同一命令。

仅安装一个项目时，在根目录执行
`pnpm --filter ./gateway --filter . install --frozen-lockfile`（替换项目路径）。

升级依赖先修改根 catalog，再生成根锁并运行 `pnpm check:dependencies` 和受影响检查。
各项目命令与发布保持独立；Quant Python 继续使用 `uv.lock`，Choice 继续使用 CMake。
本地使用普通checkout。研究数据、模型和凭证不进入Git。
PR按影响范围检查，合并队列验证后，各服务独立发布。

[开发入口](AGENTS.md) · [架构](docs/ARCHITECTURE.md) ·
[存储](docs/DATABASE.md) · [认证](docs/AUTH.md) ·
[迁移方案](docs/plans/monorepo-2026-10-28.md) ·
[迁移审计](docs/operations/monorepo-migration.md)
