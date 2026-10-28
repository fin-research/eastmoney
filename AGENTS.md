# Eastmoney monorepo

公开仓库为 `fin-research/eastmoney`，默认分支为 `main`。
七项目保留独立运行、测试、migration和发布。

## 规则

- 简洁表达，使用最小实现。修改前检索现有代码、类型、测试和文档。
- 开始任务先读目标项目的完整 `AGENTS.md`，再读范围内局部规则。
- 默认在普通本地 checkout 开发，不创建或要求 Git worktree。
- 同一 checkout 的写任务串行执行。保留已有改动，只提交任务文件。
- 大型方案、重复错误和长任务收尾须由 `architect` 审查并处理发现。
- 前端不加解释性小字。UI变化遵循Dashboard设计与视觉验收。
- 本地研究数据、模型、凭证和运行产物留在忽略目录，不提交Git。
- 已发布模型的版本与校验记录继续保留；本地研究不自动触发模型发布。
- 不能用删除测试、关闭检查或忽略错误完成交付。
- 只报告实际执行的测试、构建、HTTP、浏览器和发布验收。

## 项目入口

| 范围 | 入口 |
| --- | --- |
| 公网入口、Auth0、JWT与权限 | [Gateway](gateway/AGENTS.md) |
| 页面、业务API、融资与管理 | [Dashboard](dashboard/AGENTS.md) |
| 公共数据契约、DM、Choice、CAMEL | [Data](data/AGENTS.md) |
| office C++ RPC | [Choice](choice/AGENTS.md) |
| 通知、队列与集中调度 | [Messenger](messenger/AGENTS.md) |
| 研报与政策采集 | [Ingest](ingest/AGENTS.md) |
| 本地量化研究与独立线上推理 | [Quant](quant/AGENTS.md) |

## 共享规范

按任务读取：[架构](docs/ARCHITECTURE.md)、[存储](docs/DATABASE.md)、
[AUTH](docs/AUTH.md)、[AI](docs/AI.md)、[测试](docs/TESTING.md)。
Cloudflare操作读[凭据](docs/CLOUDFLARE.md)，Choice取数先读[额度](docs/CHOICE.md)。
命令、业务规则和migration由各项目维护，根CI只分派检查。

权限登录验收只用程序化HTTP、单测和CLI，禁止browser。
测试凭证只放根目录未跟踪的 `.env`。
Auth0管理先复用本机CLI授权，不反复登录。

## 集成与发布

PR经过必需CI后进入合并队列，队列验证集成提交。
跨服务变更同时核对调用方、契约、绑定和发布顺序。
每个Worker独立构建发布，保留现有资源和migration ledger。
Ingest只走Git自动部署。Quant研究提交不自动部署推理模型。

Choice厂商SDK留在私有构建来源，不进入公开仓库。
必要部署沿用用户授权，执行后核对实际版本和受影响入口。

迁移来源和公开审计见[迁移记录](docs/operations/monorepo-migration.md)。
