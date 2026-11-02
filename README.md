# Eastmoney

市场研究、融资业务、数据采集和量化模型的公开 monorepo。
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

## 开发

- 使用 Node 24 和根 `packageManager` 指定的 pnpm。
- JavaScript 六项目（gateway、dashboard、data、messenger、ingest、quant/online）共用根 `pnpm-workspace.yaml` 的精确 catalog 和单一 `pnpm-lock.yaml`。
- 在根目录安装：`pnpm install --frozen-lockfile`。只装一个项目：`pnpm --filter ./gateway --filter . install --frozen-lockfile`（替换项目路径）。
- 升级依赖：改根 catalog，更新根锁，运行 `pnpm check:dependencies` 和受影响检查。
- SheetJS 0.20.3 由根 override 指向[已校验的官方包](vendor/README.md)，避免依赖厂商 CDN。
- Quant Python 用 `uv.lock`，Choice 用 CMake。各项目的命令与发布相互独立。
- 研究数据、模型和凭证不进入 Git。PR 按影响范围检查，合并队列验证后，各服务独立发布。

[开发入口](AGENTS.md) · [架构](docs/ARCHITECTURE.md) ·
[存储](docs/DATABASE.md) · [认证](docs/AUTH.md)
