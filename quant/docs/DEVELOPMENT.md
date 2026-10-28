# Development

JavaScript依赖由[根workspace](../../pnpm-workspace.yaml)统一管理，使用Node 24和根packageManager指定的pnpm。`pnpm install --frozen-lockfile`自动使用根锁；只装本项目时在根目录运行 `pnpm --filter ./quant/online --filter . install --frozen-lockfile`。不维护子项目锁文件。

研究源码身份保守地包含完整根package、catalog和锁文件。其它服务的依赖调整也会要求重新审阅Quant源码闭包；这不表示模型权重变化，不自动重训或发布。

本地研究使用普通checkout。数据、模型和运行产物保留在本地忽略目录，可按研究需要更新。下文旧工作树路径只用于历史证据追溯，不要求新建worktree。已发布模型的身份与哈希仍按发布规则保存。
## Environment

项目使用 Python 3.12 和 `uv`，`pyproject.toml` 当前限定 macOS Apple Silicon 环境。

```bash
cd /Users/yueshi/src/eastmoney/eastmoney/quant
uv sync
uv run python --version
```

Python 依赖版本以 `pyproject.toml` 和 `uv.lock` 为准。`online/` 保留独立运行命令，JavaScript依赖版本和锁文件由根workspace维护，命令见 [ONLINE_INFERENCE](ONLINE_INFERENCE.md)。新增Python依赖更新uv锁，新增JavaScript依赖更新根catalog和pnpm锁。

## Local Data and Credentials

Excel、文档和 `.env` 均被 `.gitignore` 排除，只保存在本机。不要在日志、测试夹具、提交或文档中写入真实数据和凭证。

项目根目录 `.env` 可能包含：

- `DATA_API_BASE_URL`：可选，统一 data API 基址。默认为生产 `/data` 服务。
- 旧 `AUTH0_MACHINE_CLIENT_ID`、`AUTH0_MACHINE_CLIENT_SECRET` 已从本机 `.env` 移除，对应 Auth0 机器应用退役。默认 Neon 只读模型不依赖它。重新设计并授权机器身份前，显式 Choice/Data API 补取不可用。不得把本机 Auth0 CLI 管理授权或测试账号密码发送给业务 API。`choice/machine_token.py` 保留旧调用边界代码，不代表当前凭据可用。
- `R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`：只读查询 R2 `article` 桶。
- `DATABASE_URL`：Neon 直连连接串，模型只读输入。Workflow经Dashboard发布函数写入结果。

不得打印这些变量的值。需要诊断时，只报告变量是否存在、调用阶段和脱敏后的错误类型。

`main.py` 默认只读Neon资金和真实一级定价资料，生成三点票面及贡献输出。不刷新业务工作簿，不直接写生产。`--no-upload` 是显式本地标记，默认同样不上传。线上训练/回放/发布按 [ONLINE_INFERENCE](ONLINE_INFERENCE.md) 完成。模型结果仅由已核验的Workflow归档原子发布。旧`--update`和`--backtest`CLI已移除，研究模式使用新目标的成熟标签验证。

`--issuance-backtest` 对全部发行人和条款共同训练并按真实事件评价。`--issuer`只影响预测请求，不裁剪训练样本。使用`--input-snapshot`固定来源，`--backtest-output`指定检查点目录。完整协议见[票面回测](ISSUANCE_BACKTEST.md)。

`--event-overrides`已拒绝，日期纠错需修正有来源的数据并生成新快照。默认预测可用`--evaluation-dir`复用指纹完全匹配的评价结果。当前训练使用全部2026年前数据，训练期报告年度扩展TSCV，2026年固定模型验证。

### data API / Choice 更新边界

- 当前统一模型复用资金、利率、发行历史和主体估值输入，使用何种特征以包声明为准。历史宏观修订和财务可用时点未经核验时不纳入核心效果证据。真实标签与未来市场观测不能进入过去特征。
- 只读Neon不产生Choice更新。显式元数据补取沿用既有Data流程，不随训练或文档修改自动收费更新。
- `ctr`和`css`只通过统一Data API调用。Choice凭据由office RPC持有。无效代码隔离，权限错误不能伪装为无数据。保留请求与版本审计。

### Choice 额度与取数计划

任何实际 Choice 调用先按[项目组 Choice 额度与取数计划](../../docs/CHOICE.md)核实账户额度、计量单位与缓存缺口。本地模型研究授权不等于无限使用共享额度。公司主体利差任务仅取目标公司的历史债池，扩展同业需有具体研究需要和独立预算。离线回放、文档修改和静态测试不触发上游取数。

## Validation

默认静态与单元验证：

```bash
uv run python -m unittest discover -s tests -v
uv run python -m compileall -q main.py pipeline.py issue_timing.py issue_report.py backtest.py margin.py query_weekly_research.py application model data choice archive reports research_sources.py tests
uv run ruff check .
uv run ruff check . --select C901,PLR0912,PLR0915
uv run python scripts/check_repository_data_safety.py
python3 scripts/build_report.py --check
uv lock --check
git diff --check
```

按改动范围增加运行验证：

- 债券pipeline、特征、解释或契约：真实运行`uv run python main.py`，线上端另执行模型导出与Python/JS一致性。
- 发行人报价SQL：执行`QUANT_DATABASE_TESTS=1 uv run python -m unittest tests.test_issuer_quote_sql -v`。该项使用根目录`.env`，只读真实PostgreSQL上的合成CTE；默认单测不连接数据库。
- 定价元数据增量逻辑：只有确需补取时运行`--primary-research --refresh-pricing-metadata`。
- 两融已封存，不再要求默认重训。显式历史复现见 [archive](../archive/README.md)。轻量归档行为测试保留在默认测试中，不安装可选大依赖或加载权重。
- R2 查询：使用受控日期区间和小 `--limit` 做 smoke，不在测试输出正文或凭证。

未实际运行的耗时模型、实时数据、接口或外部服务检查，不得声称通过。

## Git and Task Records

- 本地研究在普通checkout进行。需要提交的源码变更使用任务分支，通过monorepo PR和合并队列进入main；数据与运行产物保持忽略。
- 提交前先检查状态，只暂存本次任务文件，保留用户已有改动。
- 提交和推送前运行 `scripts/check_repository_data_safety.py`。GitHub Actions 会执行同一检查并拒绝受限数据或凭证。
- 长期有效的模型口径放入本项目文档。债券单次原始实验结果留既有忽略目录，两融历史记录留 `archive/margin_flow/archive/`，不要塞进 `AGENTS.md`。
- 每轮研究的代码和记录按 [AGENTS](../AGENTS.md) 存入独立目录。不得提交工作记忆、公司业务数据或原始生成报告。按[研究报告规范](RESEARCH_REPORT.md)审阅的安全聚合证据和最终 `README.md` 可提交。

## 权限专项验证

按 [共享 AUTH](../../docs/AUTH.md#程序化权限测试) 执行本仓库匿名/测试账号覆盖。权限验收禁止 browser。真实登录统一使用 Gateway 的 `pnpm auth:verify`，凭据只从项目组根 `.env` 读取，不复制登录实现或密码到各仓库。

## 测试分层与覆盖率

测试规范与覆盖率口径见 [TESTING](TESTING.md)。
