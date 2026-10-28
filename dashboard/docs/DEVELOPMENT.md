# 开发与验证

## 本地环境

```bash
pnpm install
pnpm dev
```

- Vite 开发服务器绑定 `127.0.0.1:8765`。独立 Vite 受保护请求因缺少 Gateway 上下文而拒绝。不得加开发身份头旁路。完整请求链使用 Gateway 的多 Worker 开发配置或程序化联调夹具。
- `.env.dev` 必须提供 `DATA_PROXY_TARGET`。Vite 代理 `/data/*` 与本地二级池接口。
- 从 `.env.local.example` 创建未跟踪的 `.env.local`，并把 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` 设置为带 TLS 参数的线上 Neon 直连连接串。`pnpm dev` 会在 Vite 启动前加载该文件，使本地 Worker 直连线上 Neon。本地开发不经过 Hyperdrive 缓存。
- `pnpm dev` 通过 SvelteKit 平台代理使用本地 R2 模拟，避免页面请求连接或写入生产 bucket。本地资金日报初始为空，可通过历史资金日报页的上传模态框上传。
- `pnpm dev` 仍使用本地 D1，不自动同步远端 D1 数据。
- 只有明确需要热点证据时运行 `pnpm db:sync:remote`。本地模型请求仍会产生外部调用。

## 默认验证与合并

本地负责快速反馈，GitHub Actions 负责完整合并验收。使用与 CI 一致的 Node 24 和仓库 `packageManager` 指定的 pnpm。推送前必须运行 `pnpm check:quick`，依次检查差异、Svelte/应用类型和 Worker 类型。逻辑变更或缺陷修复还须运行直接相关的轻量单元测试，例如 `node --test tests/market-briefing-workflow.test.mjs`。同一份改动已有通过结果时不重复运行。纯文档修改只需 `git diff --check`。

本地默认不重复全量覆盖率。页面视觉改动先用 `pnpm visual:local` 审阅受影响页，生产构建是该命令的准备步骤。其它排障检查按需运行。`pnpm build` 仍包含两类类型检查，已经对同一份改动成功构建时无需另跑类型检查。

`check:quick` 不连接业务数据库、不调用线上服务。SvelteKit 类型同步会写入本地生成目录 `.svelte-kit`。本地检查通过后才进入以下流程，不能用本地结果替代 CI。

1. 在普通checkout中串行开发，提交任务文件并推送分支。前端、共享UI、API契约及影响页面输出的改动仍由新的子代理交付。有意视觉变化先在固定Linux镜像中审阅、导入基线并提交。
2. 根工作流 [Eastmoney CI](../../.github/workflows/ci.yml) 按影响范围运行项目检查，统一必需门禁为 `Monorepo CI`。Dashboard的PR检查核对线上合并队列规则；其绿色结果仅表示可以入队。完整覆盖率和视觉验收在合并组执行。
3. 使用 `gh pr merge <number> --repo fin-research/eastmoney --auto` 入队，禁止 `--admin`。队列基于最新main生成集成提交，执行受影响项目及跨服务检查。真实Git和视觉冲突须修复。
4. Dashboard子工作流 [dashboard.yml](../../.github/workflows/dashboard.yml) 并行执行Python/Node覆盖率与类型/构建/完整视觉套件。组件门禁 `Dashboard CI` 要求两项均成功，根 `Monorepo CI` 再汇总全部受影响项目。失败、取消、缺失或非预期跳过均拒绝合并。
5. 根 [main-ruleset.json](../../.github/main-ruleset.json) 是规则配置源，应用后须回读。main要求PR、串行合并队列及GitHub Actions的 `Monorepo CI`，无审批数量要求、无bypass，禁止删除或强推。不使用 `direct:push`。
6. 按 [CI等待与收尾](TESTING.md#ci-等待与收尾2026-09-20) 等待唯一对应运行。记录PR head、合并组SHA、运行链接、合并提交和Cloudflare构建状态。CI成功后仍须核对实际发布。

单元任务使用根 `.github/actions/setup-dashboard` 安装锁定依赖。视觉任务保留固定digest的Linux ARM64镜像、Playwright 1.63.0和字体。缓存仅保存依赖，不保存截图或验收结论。Python uv缓存键使用 `tests/test_credit_materials.py`。本次迁移不保留旧仓独立的缓存预热工作流。

本地视觉候选的生产构建与应用构建统一使用 4GB Node 堆上限。

截图基线、覆盖范围与候选生成规则见 [TESTING](TESTING.md)。本地 Linux 截图由作者审阅并导入，合并组的 `Dashboard CI` 严格比较。

## 专项验证

下列轻量测试可在本地按改动范围先运行，完整测试集仍由 CI 执行。涉及真实数据、权限或线上服务的专项验证按任务单独安排，不因常规 CI 通过而省略或声称通过。

- 报告口径：运行 `report-view`、`text-report`、`primary-issues` 相关测试，并核对视觉/文字共用字段。
- 热点：运行热点、快照、AI Gateway 测试。必要时在本地 D1 请求 GET/POST。
- 二级池：运行 `bond-ledger` 测试。解析或事务变化先使用 `pnpm bond:db:backfill` 只读盘点。
- 授信：运行 `tests/credit.test.mjs`，并对实际 Excel 执行 `pnpm credit:import -- --file <xlsx> --date YYYY-MM-DD --dry-run`，核对一览表和周报两套口径后再写入。
- Worker binding：运行 `pnpm worker:typegen` 后检查生成差异，再运行 `pnpm build`。

## 数据库

- D1 本地 migration：`pnpm db:migrate:local`。
- D1 远端 migration：`pnpm db:migrate:remote`。只在明确的 schema 交付任务中执行。
- Neon migration：配置直连 `DATABASE_URL` 后运行 `pnpm bond:db:migrate`。
- 融资择时 schema：配置同一 Neon `DATABASE_URL` 后运行 `pnpm financing-model:db:migrate`。
- 授信 schema：配置同一 Neon直连 `DATABASE_URL` 后运行 `pnpm credit:db:migrate`。长表切换默认只运行 `0018` 增量阶段，新 Worker 100% 流量核验后才运行 `pnpm credit:db:migrate -- --finalize` 收尾，详见[授信工作台](modules/credit-workbench.md#历史修订与切换)。`0009` 依赖融资 `0034_bond_investors.sql`，须先应用融资 migration，并先在生产副本分支核对逐期债券真实值与其它合并结果。
- 授信导入：先运行 `pnpm credit:import -- --file <xlsx> --date YYYY-MM-DD --dry-run`。确认报告日、目标数据库和汇总后，去掉 `--dry-run` 写入。写入须提供 `--user-id`。同日重导只写发生变化的 `credit.entry` 字段，未变时不增加记录。
- 台账回填默认只读。`--apply` 会写数据库，必须先确认目标环境和授权。

## 发布

- `pnpm worker:dev` 用于构建后本地 Worker 检查。
- 默认将 PR 加入合并队列，队列完整 CI 成功后自动合并到 GitHub `main`，由 Cloudflare Git 自动构建部署 `eastmoney-dashboard`。核对对应提交的构建状态和线上受影响路由。
- 合并后先运行 `pnpm worker:status -- --commit=<main完整SHA> --wait=600`，通过当前 deployment 的实际流量版本关联 Cloudflare Build，再核对 `build_trigger_metadata.commit_hash`。合并队列 SHA、最终 main SHA 与 Worker UUID 是不同标识。版本缺少 SHA tag 或 `source=wrangler` 不能证明自动部署失败。命令只读取发布记录，未证明成功时返回非零。API 失败或没有关联记录属于未知状态。
- Cloudflare 生产触发器仍执行 `pnpm run build` 与 `npx wrangler deploy`。自动构建的 Vite 进程使用 4GB 堆，避免默认约 2GB 堆在完整构建时偶发 OOM。这不修改 Worker 运行 CPU 预算或付费订阅。
- 只有明确的自动构建失败才使用 `pnpm worker:deploy -- --reason=<失败原因>` 发布同一份已验证 main。手动入口在本地构建前及上传前分别核对发布记录、最新 main、干净 checkout 和该提交的 `Monorepo CI`。已部署则直接退出，构建等待中或状态未知则停止补发。手动版本附 `git:<完整SHA>` tag 供后续核验。

  不要因等待时间短或标识不同而重复发布。先修复失败原因并优先重试自动构建。发布无需再次授权，不得覆盖其它任务改动。
- 手动补发需要目标 main SHA 上成功的 `Monorepo CI`。若合并队列使用不同 SHA 且 GitHub 未把检查关联到最终提交，先对当前 main 执行根 `Eastmoney CI` 的 `workflow_dispatch` 并等待成功。不能复用未经核对的其它提交的绿色检查。正常自动部署仍由受保护的合并队列验收，不增加 main 上的重复 CI。
- JWT、Auth0、会话、角色配置及其 Secret 由 Gateway 维护。Dashboard 只需要 `IDENTITY` Service Binding。新建或变更绑定须先部署提供对应 entrypoint 的 Gateway。
- Gateway 变更的发布顺序见 [Gateway DEVELOPMENT](../../gateway/docs/DEVELOPMENT.md)。不能恢复本 Worker 的公网 route、workers.dev、preview 或旧 Access 开关。
- 程序化联调在 Gateway 执行 `node scripts/verify-integration.mjs`，使用本仓库构建结果验证 SvelteKit 页面、数据预取、登录状态及 Data 契约。`DASHBOARD_CHECKOUT` / `DATA_CHECKOUT` 可指定独立工作树。
- Auth0 注册配置、资料更新与登录脚本当前在 Gateway 维护。Dashboard 的旧 Auth0 provisioning 仅供迁移回溯，不用于当前生产切换。`verify-profile-routes` / `verify-navigation-routes` 兼容转到 Gateway 集成脚本。`verify-financing-routes` 通过真实 Gateway 校验后执行构建应用和 PGlite 业务回归，工作树设置 `GATEWAY_CHECKOUT`。
- 发布前核对 `wrangler.jsonc` 中绑定、migration 顺序和生产数据服务路径，但不要把 Secret 写入配置。

## 运行追踪

- `wrangler.jsonc` 显式开启 `observability.traces.enabled`，采样率 `head_sampling_rate: 0.1`，并以 `persist: true` 保存至 Cloudflare Observability。日志仍为全量采样，保留失败诊断。
- 此开关作用于整个 `eastmoney-dashboard` Worker，而非仅授信助手。发布后的新请求可产生平台自动追踪（HTTP、binding 和 handler）。不会补录历史请求或把 DO 会话转换成追踪记录。
- 在 `eastmoney-dashboard → Observability` 查看平台追踪。授信助手按 [Cloudflare Agents tracing](https://developers.cloudflare.com/agents/runtime/operations/observability/tracing/#custom-harnesses) 记录 `invoke_agent`、`chat`、`execute_tool` 与 Agent/会话标识，不记录问题或检索正文。
- 追踪不增加问题、授信材料正文、提示词、模型输出或工具参数/结果的内容采集，也不配置外部导出目的地。自定义埋点只记录安全元数据。
- 日常追踪采用 10% 头部采样。专项排障可临时恢复全量并在完成后回调。抽样不保证每次问答都有追踪，不能替代日志和业务状态。额度与计费以 [Cloudflare Workers tracing](https://developers.cloudflare.com/workers/observability/traces/#limits--pricing) 为准。

## 云资源审计

[2026-09-21 审计](operations/cloud-resource-audit-2026-09-21.md) 记录 Neon、Workers、D1、R2、Hyperdrive、Queue、Workflow、AI Gateway 和构建用量、数据可见性与优化证据。`scripts/audit-cloud-resources.mjs --help` 提供只读的聚合指标采集命令。使用有 Analytics Read 权限的令牌，输出不包含消息、用户资料或凭据。空数据、无权限和账单不可用必须分别记录，不能视为零消耗。

## 文档维护

- UI 规则变化更新 `DESIGN.md`。
- 业务公式、状态与页面契约更新目标模块文档。跨模块不变量才更新 `docs/DOMAIN.md`。
- 数据、接口或安全边界变化更新对应专题。跨项目架构/存储/AI 更新 [项目组共享专题](../../AGENTS.md#context-routing)。新增页面或模块在 `AGENTS.md` 登记文档入口，模块细节仍归模块文档。

## 融资模块维护

融资代码、测试、迁移与脚本全部由本仓库维护，不再向旧 financing 仓库提交功能。默认 `pnpm test` 同时运行两组测试。专项可使用 `pnpm test:financing`。生产构建仍用同一版本的 SvelteKit、Svelte、Tailwind、ECharts 与 pg。

迁移：`pnpm financing:db:init -- --schema-only`。Excel 盘点：`pnpm financing:db:import -- --dry-run`。SQLite 盘点：`pnpm financing:db:migrate:sqlite -- --dry-run`。提醒盘点：`pnpm financing:reminders:send -- --dry-run`。凭证与原始 Excel 留在未跟踪本地文件中，导入时显式指定源路径，不把旧 checkout 作为运行依赖。

Gateway 切换验证后，删除 Dashboard 不再使用的 Auth0 管理 Secret。常规 Git 构建使用私有 IDENTITY binding。合并切换历史见 [合并记录](FINANCING_MERGE.md)。

浏览器关键表单交互、200% 缩放和甘特图大字号视觉回归仍作为专项验收。未执行时不得写成已通过。仓库内已覆盖 Excel 映射/勾稽、提醒周期、项目建档和构建后路由测试，旧待办中的对应“缺少单元测试”不再重复列为待办。

统一权限的历史迁移边界见 [UNIFIED_PERMISSIONS](UNIFIED_PERMISSIONS.md)。当前发布按 Gateway 和本仓库交付流程执行。旧融资人员管理和 Auth0 初次账号导入脚本仅供历史迁移参考。当前人员和角色直接在 Auth0 管理，不重建已删除人员表。

## 权限专项验证

按 [共享 AUTH](../../docs/AUTH.md#程序化权限测试) 执行本仓库匿名/测试账号覆盖。权限验收禁止 browser。真实登录在 Gateway 执行 `pnpm auth:verify`。Dashboard 保留兼容命令。凭据只从项目组根 `.env` 读取，不复制登录实现或密码到各仓库。

本地 Auth0 租户管理使用 Auth0 skill 和 `auth0` CLI，先复用已有授权。并行会话按[共享 AUTH](../../docs/AUTH.md#auth0-本地租户管理)协调资源变更。登录验收和测试账号准备也见共享 AUTH。

## 测试分层与覆盖率

测试规范、覆盖率口径及视觉门禁见 [TESTING](TESTING.md)。
