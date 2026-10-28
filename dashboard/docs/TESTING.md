# Dashboard 测试与视觉回归

测试取舍遵循[项目组测试规范](../../docs/TESTING.md)。自 2026-09-17 起，本地推送前执行 `pnpm check:quick` 和改动直接相关的轻量单元测试，完整覆盖率、浏览器测试及构建验收由 GitHub CI 执行。纯文档修改仅检查差异，本地排障可运行所需检查。覆盖率只代表注明的执行范围。

## CI 命令

准备合并时，GitHub merge queue 在合并组提交上运行完整 `Dashboard CI`。普通分支 push 不运行，PR 创建/更新仅检查队列门禁，main 合并后不重复运行。Python/Node 覆盖率与类型/构建/视觉两条任务并行，统一门禁只接受两项均成功。类型检查在构建任务前置，构建阶段只打包。

`test:coverage` 已运行完整 Node 测试集，不再重复调用 `test`。本地可下载 CI 证据并使用报告查看命令。推送、CI 等待与核验由子代理负责，详见 [DEVELOPMENT](DEVELOPMENT.md#默认验证与合并)。

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

`test:coverage` 使用 Node 24 内置 coverage，输出控制台表格和 `coverage/lcov.info`。只统计 Node 加载的 `src/**/*.ts`、`src/**/*.js`，排除 generated。未加载源码、Svelte 与 CSS 不在分母内，不能把总数视为全仓或 UI 覆盖率。Python 授信材料脚本单列，不混入 Node 数量。

## 自动视觉验收

`tests/visual` 使用 Playwright 1.63.0 Chromium，在固定 digest 的 Linux ARM64 自有镜像中运行，并固定上海时区、中文 locale、日期、动画偏好和业务响应。CI 先构建 SvelteKit 生产包，再用 `pnpm build:visual` 编译独立 harness。`prepare-visual-build.mjs` 按生产 route node 的 stylesheet 顺序复制原样压缩 CSS 和资源，删除 harness CSS，记录 SHA-256。浏览器等对应生产 CSS 加载后才挂载组件，通过 8877 的静态 preview 运行，不再使用开发服务器。不加载 SvelteKit hooks、服务端 load、Gateway、数据库、Auth0 或业务环境文件。页面链接通过这个测试入口装配相应组件，因此是浏览器组件集成测试，不是生产路由 E2E。

当前场景：门户、交易总览与管理、交易流程及展开/编辑态、授信总览/日历/周报/失败态、研究辅助、二级池非空与空态、市场点评、融资时点/时段控件及重置，融资择时非空报告，以及 Maia 多选、弹窗、日历筛选与热点键盘交互。桌面 1440×900、手机 390×844 都运行。固定夹具覆盖实际图表与表格，不访问真实业务网络。未注册请求与浏览器异常会失败。

工作台业务截图只取 `.tr-workspace`，使页头和侧栏修改不改变各业务页基线。独立新闻、研报和点评详情取 `.detail-main`。交易、授信、融资、管理四个一级工作台分别截取 `.tr-drawer`。只有含标签页或额外操作的代表顶栏截取 `.page-header`，另保留交易标签悬浮态。

截图样式统一隐藏固定 AI 入口和浮动新增按钮，其行为仍由交互断言检查。门户、市场点评、AI 面板与打印态没有工作台取景容器，继续采用其专用截图。合并组仍执行完整视觉套件，不按改动路径跳过测试。分区取景用于减少无关基线变化。

默认 CI 只比较已提交截图，缺少基线也失败。不自动接受新图、不重试失败。失败时生成 actual/expected/diff、HTML 报告和 trace。页面改动后启动 Docker Desktop，运行 `pnpm visual:local`，按相对 `origin/main` 的页面文件差异在固定 Linux 镜像中生成桌面和手机截图。

共享组件、样式或视觉夹具改动需显式指定 `--page src/routes/.../+page.svelte`（可重复）或 `--all`，脚本不猜测依赖范围。截图写到忽略的 `.local-visual/<时间>/review/`。审阅后执行 `pnpm visual:baseline:import-local .local-visual/<时间> --reviewed`，校验源码与 PNG 后只导入本次截图。`linux-ci` 基线在本地与合并组中共用。

有意视觉变化在本地审阅、导入并提交，再推送入队。默认分支合并组在相同镜像中严格比较全部已提交的 `linux-ci` PNG。远端候选截图工作流已移除。

禁止为消除差异提高容差、屏蔽业务区域或盲目更新。旧 macOS PNG 已清理。日常只维护 Linux ARM64 镜像的 `linux-ci` 基线。合并组和手动重跑 `tests.yml` 均永不更新截图，`Dashboard CI` 不接受跳过比较的输入。镜像、字体或浏览器升级时统一重建本地基线并在 CI 比较。CI 保存覆盖率、HTML 报告和失败 trace 等证据 14 天。

## CI 等待与收尾（2026-09-20）

每个仓库、每次交付只由一个新子代理负责推送、CI/合并和部署核验，主代理不并行查询同一运行。派发时给出任务工作树、允许提交的文件、目标 SHA、PR 与所需验收阶段。CI 失败后返回具体失败证据，由主代理修改，再派新子代理。本地截图待审时先完成审阅和导入，不提前启动必然因缺失基线失败的普通验收。

发现当前运行 ID 后，用仓库内命令等待一次。SHA 使用 GitHub 该运行的完整 head SHA，event 必须符合所需阶段：

```sh
node scripts/wait-ci.mjs fin-research/dashboard <run-id> <full-run-head-sha> merge_group
```

命令先核对仓库、run ID、SHA、event。对进行中的运行只启动一个 `gh run watch --interval 30`，中间重复进度不进入代理上下文，结束后只读取一次终态证据。默认最多等待20分钟（可追加1–1800秒），两次元数据请求各限15秒。不启动或重跑CI。

退出0只表示该运行成功，1表示失败/取消/跳过/证据不匹配/API不可读，2表示仍待完成。返回2或API失败时保留运行链接和明确状态，不把未完成当通过，也不立即循环重开watch。只在新的状态证据或明确继续要求下恢复。

工具返回进程/执行cell仍在运行时，只续等同一进程。每次按工具能力等待较长时段，本地执行最多60秒。禁止每几秒调用`gh run view`/`gh pr checks`，禁止重启watch或将重复日志当新证据。主代理仅等待子代理完成，不读取同一日志、不重复验收。

失败时只下载当前运行的失败job日志、对应截图/trace一次。区分代码缺陷、测试假设、预期视觉变化与runner/API故障。未修改代码/基线/环境且无临时基础设施故障证据时，不盲目重跑。同一问题修复后仍失败，应先重新判断根因。

停止条件：所需普通验收成功、PR合并已确认，以及本任务涉及的部署结果/版本已核对后立即回报并结束。不再额外跑测试、下载已成功的整套artifact或扩展至无关页面。CI/文档工具变更不追加业务登录或浏览器专项验收。回报只需PR、代码/合并SHA、各必要run链接与结论、部署证据及实际未验收项。本地截图和轻量入队成功都不得报告成完整CI通过。

## 视觉变更的提交前准备

先判断是否改变页面视觉，列出影响的页面、状态和设备。更新 `visual-coverage.json` 的对应场景。无意视觉变化时不更新 baseline，差异须先定位根因。需要更新时，在本地固定 Linux 镜像中生成、审阅并导入受影响页面截图，再提交和推送，最后加入合并队列。普通分支 push、PR（含草稿）更新及 main push 不触发完整验收。合并队列必须执行完整视觉比较，PR 的轻量绿色门禁不算验收通过。

```sh
pnpm visual:local --page src/routes/<page>/+page.svelte
# 检查 .local-visual/<时间>/review/ 后执行；不会自动提交。
pnpm visual:baseline:import-local .local-visual/<时间> --reviewed
```

本地候选记录镜像 digest、源码 digest、各 PNG 的 SHA-256。导入验证路径、源码及校验和。代码变化后必须重新生成。导入不自动提交，也不替代随后合并组的严格比较。不要为避免红灯关闭必需检查。

## 并发与证据隔离

不同 Actions job 在独立托管 runner/checkout 运行，固定端口和工作树内输出目录不会跨任务共享。本地候选由镜像 digest、源码 digest 和 PNG 校验和绑定。入队前只导入当前任务、当前源码的已审候选，不导入另一个任务的整个截图目录。合并队列串行产生最终合并结果。共享样式或布局集成后有差异时，须修复或重新审阅候选。不得放宽容差、重复重跑或关闭门禁来消除失败。

本地截图与普通验收分开：生成一次、审阅导入、最终合并组严格比较一次。普通 CI 保持零自动重试。只有已复现抖动或明确排障需要时才安排额外稳定性复跑，并记录原因，不把多轮复跑作为日常流程。依赖/浏览器缓存共用配置但不包含图片、生产输出或测试结果。覆盖率工件为 `unit-evidence`，截图、HTML、trace 和生产 CSS 清单为 `visual-evidence`。

## 页面覆盖清单门禁

`visual-coverage.json` 是页面、URL 场景、状态、设备、测试标题与活跃 CI 截图的可检查清单。`check:visual-coverage` 比对真实页面文件。新增页面、清单遗留项、缺少证据或 baseline 会失败。本地初建基线时清单检查可暂缺 PNG，不能绕过清单与测试要求。Dashboard 另核对现有导航 registry 的动态视图。Financial 另核对 Shell 的 URL 分支，新 view/URL 不会因复用同一页面组件而漏掉。

全量 CI 设置 `VISUAL_COVERAGE_GATE=1`，reporter 再核对声明的测试确实在指定设备执行并通过。截图条目必须逐一实际执行清单所列文件名的 `toHaveScreenshot`，单纯 `page.screenshot`、跳过或删去测试不计作覆盖。`test-results/visual-coverage.json` 保留清单、豁免及结果。该清单不是代码覆盖率，单个正常态不代表所有状态。

已有缺口必须写明豁免原因，不计入已覆盖，修改相应页面时重新评估。常规有覆盖页面不需要新增重复测试。局部排障可不启用全量门禁，不替代 CI。

## 测试维护

- 用接口、状态、焦点、键盘、回滚与权限行为验证交互。页面源码、CSS 文本和控件数量不应代替行为断言。业务口径继续通过单元或 handler 测试验证，截图不替代数值与权限测试。
- 视觉清单只记录实际执行的页面、状态、设备与明确豁免。新增页面和状态时补充真实浏览器场景，现有缺口不计入已覆盖。
- 覆盖率只统计实际加载的 TS/JS。Svelte、CSS、未加载文件和生产鉴权另行验收。运行记录、候选截图与 CI 链接保留在对应 Actions 工件和 Git 历史，不在本规范按次追加。

## 拆借本地目录验收

拆借六项交互同时保护选择/拖放自动执行、目录持久复用、账户锁、文件冲突、未知上传停止和目录权限恢复。固定 Linux Chromium 在最小 OPFS 句柄写入 IndexedDB 后读取时会触发 SIGTRAP，完整 Chromium 与 headless shell 均复现；因此 Linux 夹具仅对 `eastmoney-interbank / directory / archive-root` 的目录描述符恢复方法，文件写入仍使用真实 OPFS，进度和事务仍使用真实浏览器存储。

原生句柄持久化和刷新复用另在 macOS Chrome 运行同一六项交互，不安装描述符适配。Linux 交互通过不能表示其原生句柄反序列化已验收；截图仍由固定 Linux 镜像产生和比较。此差异不进入生产归档代码。
