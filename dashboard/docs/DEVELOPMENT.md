# 开发与验证

JavaScript 依赖由[根 workspace](../../pnpm-workspace.yaml) 统一管理，用 Node 24 和根 `packageManager` 指定的 pnpm。`pnpm install --frozen-lockfile` 使用根锁。只装本项目时在根目录运行 `pnpm --filter ./dashboard --filter . install --frozen-lockfile`。

## 本地环境

```bash
pnpm install
pnpm dev
```

- Vite 绑定 `127.0.0.1:8765`。独立 Vite 的受保护请求因缺少 Gateway 上下文被拒绝，完整请求链用 Gateway 的多 Worker 开发配置或程序化联调夹具。
- `.env.dev` 须提供 `DATA_PROXY_TARGET`，Vite 据此代理 `/data/*` 与本地二级池接口。
- 从 `.env.local.example` 创建未跟踪的 `.env.local`，设置 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` 为带 TLS 参数的线上 Neon 直连串。`pnpm dev` 启动前加载它，本地 Worker 直连 Neon，不经 Hyperdrive 缓存。
- 本地 R2 是模拟存储，页面请求不会连接生产 bucket。本地资金日报初始为空，用历史资金日报页的上传弹窗添加。
- 本地 D1 不自动同步远端。需要热点证据时运行 `pnpm db:sync:remote`。本地模型请求仍产生外部调用。

## 默认验证与合并

本地负责快速反馈，GitHub Actions 负责完整合并验收。

- 推送前运行 `pnpm check:quick`（diff 检查、Svelte / 应用类型、Worker 类型）。逻辑变更或缺陷修复另跑直接相关的轻量单元测试，例如 `node --test tests/market-briefing-workflow.test.mjs`。同一份改动已有通过结果时不重复。纯文档修改只需 `git diff --check`。
- 页面视觉改动先用 `pnpm visual:local` 审阅受影响页。`pnpm build` 已含两类类型检查。
- `check:quick` 不连接业务数据库和线上服务。SvelteKit 类型同步会写本地生成目录 `.svelte-kit`。

合并流程：

1. 在普通 checkout 串行开发，提交任务文件并推送分支。有意的视觉变化先在固定 Linux 镜像中审阅、导入基线并提交。
2. 根 [Eastmoney CI](../../.github/workflows/ci.yml) 按影响范围运行项目检查，必需门禁为 `Monorepo CI`。PR 上的 Dashboard 检查只核对线上队列规则，绿色仅表示可入队。
3. 用 `gh pr merge <number> --repo fin-research/eastmoney --auto` 入队。队列基于最新 `main` 生成集成提交，运行受影响项目与跨服务检查。代码变更不用 `--admin` 绕过队列。管理员对文档类改动的例外见[项目组 AGENTS](../../AGENTS.md#集成与发布)。
4. 子工作流 [dashboard.yml](../../.github/workflows/dashboard.yml) 并行运行 Python / Node 覆盖率与类型 / 构建 / 完整视觉套件。组件门禁 `Dashboard CI` 要求两项均成功，失败、取消、缺失或非预期跳过都拒绝合并。
5. 规则集配置源是根 [main-ruleset.json](../../.github/main-ruleset.json)，应用后须回读。
6. 按 [CI 等待与收尾](TESTING.md#ci-等待与收尾) 等待对应运行。记录 PR head、合并组 SHA、运行链接、合并提交和构建状态。CI 成功后核对实际发布。

单元任务用根 `.github/actions/setup-dashboard` 安装锁定依赖。视觉任务的镜像、Playwright 和字体版本固定在 [dashboard.yml](../../.github/workflows/dashboard.yml)。缓存只存依赖，不存截图或验收结论。截图基线与覆盖规则见 [TESTING](TESTING.md)。

## 专项验证

下列轻量测试按改动范围先在本地运行，完整测试集由 CI 执行。涉及真实数据、权限或线上服务的验证按任务单独安排，不用常规 CI 结果代替。

- 报告口径：`report-view`、`text-report`、`primary-issues` 相关测试，并核对视觉与文字共用字段。
- 热点：热点、快照、AI Gateway 测试，必要时在本地 D1 请求 GET / POST。
- 二级池：`bond-ledger` 测试。解析或事务变化先用 `pnpm bond:db:backfill` 只读盘点。
- 授信：`tests/credit.test.mjs`，并对实际 Excel 运行 `pnpm credit:import -- --file <xlsx> --date YYYY-MM-DD --dry-run`，核对一览表和周报两套口径后再写入。
- Worker binding：`pnpm worker:typegen` 后检查生成差异，再 `pnpm build`。
- 权限：按 [共享 AUTH](../../docs/AUTH.md#程序化权限测试) 执行匿名 / 测试账号覆盖，Dashboard 用 `pnpm test:auth`，真实登录用 `pnpm auth:verify`。Auth0 租户管理见 [本地租户管理](../../docs/AUTH.md#auth0-本地租户管理)。

## 数据库

- D1：本地 `pnpm db:migrate:local`，远端 `pnpm db:migrate:remote`（只在明确的 schema 交付任务中执行）。
- Neon：配置直连 `DATABASE_URL` 后运行 `pnpm bond:db:migrate`（二级池）、`pnpm financing-model:db:migrate`（融资择时）、`pnpm credit:db:migrate`（授信）。
- 授信 `0009` 依赖融资 `0034_bond_investors.sql`，须先应用融资 migration，并在生产副本分支核对逐期债券真实值。长表切换步骤和 `--finalize` 见[授信工作台](modules/credit-workbench.md#历史修订与切换)。
- 授信导入：先 `--dry-run`，确认报告日、目标数据库和汇总后去掉 `--dry-run`，写入须带 `--user-id`。同日重导只写变化的 `credit.entry` 字段。
- 台账回填默认只读，`--apply` 写库前须确认目标环境和授权。

## 融资模块维护

融资代码、测试、迁移与脚本由本仓库维护。`pnpm test` 同时运行融资测试，专项用 `pnpm test:financing`。

- 初始化 schema：`pnpm financing:db:init -- --schema-only`。
- 盘点：`pnpm financing:db:import -- --dry-run`（Excel）、`pnpm financing:db:migrate:sqlite -- --dry-run`（SQLite）、`pnpm financing:reminders:send -- --dry-run`（提醒）。
- 凭证与原始 Excel 留在未跟踪的本地文件中，导入时显式指定源路径。
- 当前人员和角色在 Auth0 管理。
- 浏览器关键表单交互、200% 缩放和甘特图大字号视觉回归是专项验收，未执行不写成已通过。

## 发布

- `pnpm worker:dev` 用于构建后的本地 Worker 检查。
- 默认路径：PR 经合并队列合入 `main`，Cloudflare Git 自动构建部署 `eastmoney-dashboard`。Cloudflare 触发器执行 `pnpm run build` 与 `npx wrangler deploy`，自动构建的 Vite 进程用 4GB 堆，避免默认堆在完整构建时 OOM。
- 合并后运行 `pnpm worker:status -- --commit=<main完整SHA> --wait=600`。它经当前 deployment 的流量版本关联 Cloudflare Build，再核对 `build_trigger_metadata.commit_hash`，只读发布记录，未证明成功时返回非零。
- 合并队列 SHA、最终 `main` SHA 与 Worker UUID 是不同标识。版本缺少 SHA tag 或 `source=wrangler` 不能证明自动部署失败。API 失败或无关联记录属于未知状态，不是失败。
- 只有明确的自动构建失败才用 `pnpm worker:deploy -- --reason=<失败原因>` 补发同一份已验证的 `main`。脚本在本地构建前和上传前，核对发布记录、最新 `main`、干净 checkout 和该提交的 `Monorepo CI`。已部署则退出，构建等待中或状态未知则停止。手动版本带 `git:<完整SHA>` tag。
- 补发需要目标 `main` SHA 上成功的 `Monorepo CI`。队列 SHA 不同且 GitHub 未关联检查时，先对当前 `main` 手动触发根 `Eastmoney CI`（`workflow_dispatch`）并等待成功。
- 不因等待短或标识不同而重复发布，先修复失败原因并重试自动构建。发布沿用用户授权，不覆盖其他任务的改动。
- JWT、Auth0、会话和角色配置及其 Secret 由 Gateway 维护。Dashboard 只需 `IDENTITY` binding，新建或变更绑定须先部署提供对应 entrypoint 的 Gateway。发布顺序见 [Gateway DEVELOPMENT](../../gateway/docs/DEVELOPMENT.md)。
- 程序化联调在 Gateway 运行 `node scripts/verify-integration.mjs`。`pnpm verify:routes` 通过 Gateway 集成脚本校验路由，再用构建应用和 PGlite 做融资业务回归，Gateway 路径用 `GATEWAY_CHECKOUT` 指定。
- 发布前核对 `wrangler.jsonc` 中的绑定、migration 顺序和数据服务路径。Secret 不写进配置。

## 运行追踪

- `wrangler.jsonc` 开启 `observability.traces`：采样率 0.1，`persist: true`；日志全量采样。开关作用于整个 `eastmoney-dashboard` Worker，发布后的新请求产生平台自动追踪。
- 在 Cloudflare 控制台 `eastmoney-dashboard → Observability` 查看。授信助手按 [Cloudflare Agents tracing](https://developers.cloudflare.com/agents/runtime/operations/observability/tracing/#custom-harnesses) 记录 `invoke_agent`、`chat`、`execute_tool` 与会话标识。
- 追踪只含安全元数据，不采集问题、授信材料正文、提示词、模型输出和工具参数 / 结果，也不配置外部导出。
- 专项排障可临时恢复全量采样，完成后回调。抽样不保证每次问答都有追踪，额度与计费见 [Workers tracing](https://developers.cloudflare.com/workers/observability/traces/#limits--pricing)。

## 云资源审计

`scripts/audit-cloud-resources.mjs --help` 提供只读聚合指标采集，需有 Analytics Read 权限的令牌。空数据、无权限和账单不可用分别记录，不视为零消耗。

- 检查 Neon 是否休眠时用控制面 API，不运行 SQL 唤醒数据库。
- 交易、RLS 上下文和写后读不靠拉长 Hyperdrive 全局缓存 TTL 提速。
- Gateway 目录读取超 CPU 时，在 Gateway 优化投影或批量读取，不跨请求长期缓存用户资格来规避权限校验。
- Neon 每个项目最多 10 个分支。新增并行验证分支前先核对剩余容量，不足时先处理。删除历史分支前先确认对应任务和回滚用途。
- Workers AI 每日 neuron 额度有限，批量重建索引按剩余额度分批。

## 文档维护

- UI 规则变化更新 `DESIGN.md`。业务公式、状态和页面契约更新目标模块文档，跨模块不变量才更新 `DOMAIN.md`。
- 数据、接口或安全边界变化更新对应专题。跨项目架构、存储和 AI 更新[项目组共享专题](../../AGENTS.md#context-routing)。
- 新增页面或模块在 `AGENTS.md` 登记入口，模块细节归模块文档。
