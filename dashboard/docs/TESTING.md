# Dashboard 测试与视觉回归

取舍遵循[项目组测试规范](../../docs/TESTING.md)。本地推送前运行 `pnpm check:quick` 和直接相关的轻量单元测试，完整覆盖率、浏览器测试和构建验收由 GitHub CI 执行。纯文档修改只检查差异。

## CI 命令

合并队列在合并组提交上运行完整 `Dashboard CI`。普通分支 push 和 main 合并后不运行，PR 创建或更新只检查队列门禁。Python / Node 覆盖率与类型 / 构建 / 视觉两条任务并行，统一门禁要求两项均成功。类型检查在构建前执行，构建阶段只打包。推送、CI 等待与核验由子代理负责，流程见 [DEVELOPMENT](DEVELOPMENT.md#默认验证与合并)。

```bash
pnpm check:quick
pnpm test:ci-tools
pnpm check:visual-coverage
pnpm test:python
pnpm test:coverage
pnpm exec vite build
pnpm build:visual
pnpm test:visual
pnpm test:visual:report
```

`test:coverage` 已运行完整 Node 测试集，不再重复调用 `test`。用 Node 24 内置 coverage，输出控制台表格和 `coverage/lcov.info`，只统计 Node 加载的 `src/**/*.ts`、`src/**/*.js`（排除 generated）。Svelte、CSS 和未加载源码不在分母内，总数不代表全仓或 UI 覆盖率。Python 授信材料脚本单列。

## 自动视觉验收

`tests/visual` 用 Playwright Chromium 在固定 digest 的 Linux ARM64 镜像中运行，版本见 [dashboard.yml](../../.github/workflows/dashboard.yml)。测试固定上海时区、中文 locale、日期、动画偏好和业务响应，桌面 1440×900、手机 390×844 各跑一遍。

- CI 先构建 SvelteKit 生产包，再用 `pnpm build:visual` 编译独立 harness。`prepare-visual-build.mjs` 按生产 route node 的 stylesheet 顺序复制压缩后的 CSS 和资源并记录 SHA-256。浏览器等生产 CSS 加载后才挂载组件，经 8877 端口静态 preview 运行。
- 测试不加载 SvelteKit hooks、服务端 load、Gateway、数据库、Auth0 和业务环境文件。它是浏览器组件集成测试，不是生产路由 E2E。
- 固定夹具覆盖实际图表与表格，不访问真实网络。未注册请求和浏览器异常使测试失败。
- 场景范围以 `visual-coverage.json` 为准，覆盖门户、交易、授信、研究辅助、二级池、市场点评、融资和 Maia 交互。

截图取景：

- 工作台业务截图只取 `.tr-workspace`，使页头和侧栏修改不改变各业务页基线。
- 独立新闻、研报和点评详情取 `.detail-main`。交易、授信、融资、管理四个一级工作台分别取 `.tr-drawer`。
- 只有含标签页或额外操作的代表顶栏取 `.page-header`，另保留交易标签悬浮态。
- 截图样式隐藏固定 AI 入口和浮动新增按钮，其行为由交互断言检查。门户、市场点评、AI 面板和打印态用各自专用截图。
- 合并组仍运行完整视觉套件，不按改动路径跳过。

基线与候选：

- CI 只比较已提交的 `linux-ci` 截图，缺基线也失败。不自动接受新图，不重试，失败时生成 actual / expected / diff、HTML 报告和 trace，证据保留 14 天。
- 页面改动后启动 Docker Desktop，运行 `pnpm visual:local`，按相对 `origin/main` 的页面文件差异在固定镜像中生成桌面和手机截图。
- 共享组件、样式或视觉夹具改动须显式传 `--page src/routes/.../+page.svelte`（可重复）或 `--all`。
- 截图写到忽略的 `.local-visual/<时间>/review/`。审阅后运行 `pnpm visual:baseline:import-local .local-visual/<时间> --reviewed`，校验源码与 PNG 后只导入本次截图。
- 候选记录镜像 digest、源码 digest 和各 PNG 的 SHA-256。代码变化后须重新生成。导入不自动提交，也不替代合并组的严格比较。
- 有意的视觉变化先本地审阅、导入、提交，再推送入队。
- 为消除差异而提高容差、屏蔽业务区域或盲目更新基线都不可接受，合并组和手动重跑的 `ci.yml` 不更新截图。镜像、字体或浏览器升级时统一重建基线。

## CI 等待与收尾

每次交付由一名代理负责 CI 等待和取证，其他代理不并行查询同一运行。派发时给出普通 checkout、允许提交的文件、目标 SHA、PR 与所需验收阶段。CI 失败后返回具体失败证据，由主代理修改，再派新子代理。本地截图待审时先完成审阅和导入，不提前启动必然因缺基线失败的验收。

找到当前运行 ID 后，用仓库命令等待一次。SHA 用 GitHub 该运行的完整 head SHA，event 符合所需阶段：

```sh
node scripts/wait-ci.mjs fin-research/eastmoney <run-id> <full-run-head-sha> merge_group
```

- 命令先核对仓库、run ID、SHA 和 event，对进行中的运行只启动一个 `gh run watch --interval 30`，结束后读取一次终态证据。默认最多等 20 分钟（可追加 1–1800 秒），不启动或重跑 CI。
- 退出码 0 表示该运行成功，1 表示失败、取消、跳过、证据不匹配或 API 不可读，2 表示仍待完成。返回 2 或 API 失败时保留运行链接与状态，不当作通过，也不立即重开 watch。
- 工具返回进程仍在运行时只续等同一进程，本地每次最多等 60 秒。不每几秒调用 `gh run view` / `gh pr checks`，不重启 watch。主代理只等子代理完成，不读取同一日志。
- 失败时只下载当前运行的失败 job 日志和对应截图 / trace 一次，区分代码缺陷、测试假设、预期视觉变化和 runner / API 故障。未改代码、基线、环境且无基础设施故障证据时不盲目重跑。同一问题修复后仍失败，先重新判断根因。

停止条件：所需验收成功、PR 合并已确认、本任务涉及的部署结果已核对，之后立即回报。回报含 PR、代码 / 合并 SHA、必要 run 链接与结论、部署证据和未验收项。本地截图和入队成功不能报告为完整 CI 通过。

## 页面覆盖清单门禁

`visual-coverage.json` 是页面、URL 场景、状态、设备、测试标题与活跃 CI 截图的清单。`check:visual-coverage` 比对真实页面文件：新增页面、遗留项、缺证据或缺基线会失败。本地初建基线时可暂缺 PNG，但清单与测试要求不能绕过。

- Dashboard 另核对导航 registry 的动态视图，融资页另核对 Shell 的 URL 分支，新 view / URL 不会因复用页面组件而漏掉。
- 全量 CI 设置 `VISUAL_COVERAGE_GATE=1`，reporter 核对声明的测试在指定设备执行并通过。截图条目须实际执行清单所列文件名的 `toHaveScreenshot`，单纯 `page.screenshot`、跳过或删测试不计作覆盖。结果保存在 `test-results/visual-coverage.json`。
- 已有缺口须写明豁免原因，不计入已覆盖，修改相应页面时重新评估。有覆盖的页面不新增重复测试。局部排障可不启用全量门禁。
- 该清单不是代码覆盖率，单个正常态不代表所有状态。

## 测试维护

- 交互用接口、状态、焦点、键盘、回滚和权限行为验证，不用页面源码、CSS 文本或控件数量代替。业务口径用单元或 handler 测试验证，截图不替代数值与权限测试。
- 新增页面和状态时补真实浏览器场景。
- 覆盖率只统计实际加载的 TS/JS，Svelte、CSS、未加载文件和生产鉴权另行验收。
- 证据隔离：不同 Actions job 在独立 runner 和 checkout 运行。本地候选由镜像 digest、源码 digest 和 PNG 校验和绑定，入队前只导入当前任务、当前源码的已审候选。覆盖率工件为 `unit-evidence`，截图、HTML、trace 和生产 CSS 清单为 `visual-evidence`。
- 共享样式或布局集成后出现差异时，修复或重新审阅候选。普通 CI 零自动重试，只有已复现的抖动才安排复跑并记录原因。

## 拆借本地目录验收

拆借六项交互保护选择 / 拖放自动执行、目录持久复用、账户锁、文件冲突、未知上传停止和目录权限恢复。

固定 Linux Chromium 把最小 OPFS 句柄写入 IndexedDB 后读取会触发 SIGTRAP（完整 Chromium 与 headless shell 均复现）。因此 Linux 夹具只对 `eastmoney-interbank / directory / archive-root` 的目录描述符恢复方法，文件写入仍用真实 OPFS，进度和事务仍用真实浏览器存储。该适配不进入生产归档代码。

原生句柄持久化和刷新复用另在 macOS Chrome 运行同一六项交互，不安装描述符适配。Linux 交互不能代表原生句柄反序列化已验收。
