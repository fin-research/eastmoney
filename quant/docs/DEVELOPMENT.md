# Development

## Environment

项目使用 Python 3.12 和 `uv`，`pyproject.toml` 限定 macOS Apple Silicon。Python 依赖版本以 `pyproject.toml` 和 `uv.lock` 为准，新增依赖须更新 uv 锁。

```bash
cd quant
uv sync
```

JavaScript 依赖由[根 workspace](../../pnpm-workspace.yaml)统一管理：Node 24、根 `packageManager` 指定的 pnpm、根 catalog 和单锁，不设子项目锁。新增依赖更新根 catalog 和 pnpm 锁。只装本项目时，在仓库根目录运行 `pnpm --filter ./quant/online --filter . install --frozen-lockfile`。`online/` 命令见 [ONLINE_INFERENCE](ONLINE_INFERENCE.md)。

## Local Data and Credentials

Excel 和 `.env` 被 `.gitignore` 排除，只在本机保存。Python 通过 `load_dotenv()` 向上查找，读取 monorepo 根 `.env`：

- `DATABASE_URL`：Neon 直连串，模型只读输入。线上 Workflow 经 Hyperdrive 读取，经 Dashboard 发布函数写入。
- `DATA_API_BASE_URL`：可选，统一 data API 基址，默认为生产 `/data`。
- `AUTH0_MACHINE_CLIENT_ID`、`AUTH0_MACHINE_CLIENT_SECRET`：Auth0 机器应用已退役，本机 `.env` 不再保存。机器身份重新设计并授权前，显式 Choice / Data API 补取不可用。`choice/machine_token.py` 仍读取这两个变量。
- `R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`：`query_weekly_research.py` 只读查询 R2 `article` 桶，从 `quant/.env` 或进程环境读取。

日志、测试夹具、提交和文档不写真实数据与凭证值。诊断只报告变量是否存在、调用阶段和脱敏后的错误类型。Auth0 CLI 管理授权和测试账号密码不发送给业务 API。

## CLI 模式

`main.py` 默认只读 Neon 的资金和真实一级定价资料，生成 T+1、T+14、T+30 票面及贡献。它不刷新业务工作簿，不写生产。`--no-upload` 是显式本地标记。运行前检查所选模型在 `financing_model.model_eligibility` 中为 `active`，暂停的票面包会被拒绝。

| 模式 | 说明 |
| --- | --- |
| `--issuance-backtest` | 统一真实票面回测，见 [ISSUANCE_BACKTEST](ISSUANCE_BACKTEST.md) |
| `--rate-research`、`--primary-research` | 利率与一级票面研究，见 [RATE_RESEARCH](RATE_RESEARCH.md) |
| `--online train/infer` | 票面包训练导出与 JS 推理，见 [ONLINE_INFERENCE](ONLINE_INFERENCE.md) |
| `--curve-research`、`--timing-research`、`--conditional-research` | 本地研究，不发布 |

模式互斥，`application/cli.py` 负责校验。`--event-overrides` 被拒绝：日期纠错须修正有来源的数据并生成新快照。

### Choice 边界

只读 Neon 不产生 Choice 更新。显式元数据补取沿用 Data 流程，不随训练或文档修改触发。`ctr` 和 `css` 只经统一 Data API 调用，Choice 凭据由 office RPC 持有。无效代码被隔离，权限错误不能当作无数据。额度计划见 [Choice 额度](../../docs/CHOICE.md)。公司主体利差任务只取目标公司的历史债池，扩展同业须有具体研究需要和独立预算。

## Validation

```bash
uv run python -m unittest discover -s tests -v
uv run python -m compileall -q main.py pipeline.py issue_timing.py issue_report.py backtest.py margin.py query_weekly_research.py application model data choice archive reports tests
uvx ruff@0.15.9 check .
uvx ruff@0.15.9 check . --select C901,PLR0912,PLR0915
uv run python scripts/check_repository_data_safety.py
uv lock --check
git diff --check
```

按改动范围增加：

- 票面 pipeline、特征、解释或契约：运行 `uv run python main.py`（需要 `active` 的所选模型），并做模型导出与 Python/JS 一致性。
- 择时包：`scripts/adopt_timing_nowcast.py`（v2）、`scripts/run_timing_advice.py` 和 `online/verify-timing.mjs`，命令见 [ONLINE_INFERENCE](ONLINE_INFERENCE.md#当前三档发行建议)。
- 择时包留出检验与区间校准：`uv run python scripts/timing_diagnostics.py <包目录> --output outputs/timing-diagnostics.json`。只读 Neon，不训练、不取 Choice，约 2 分钟。
- 发行人报价 SQL：`QUANT_DATABASE_TESTS=1 uv run python -m unittest tests.test_issuer_quote_sql -v`。它读取根 `.env`，只对真实 PostgreSQL 执行合成 CTE。默认单测不连库。
- 定价元数据增量逻辑：确需补取时才运行 `--primary-research --refresh-pricing-metadata`。
- R2 查询：用受控日期区间和小 `--limit` 做 smoke，输出不含正文和凭证。
- 两融已封存，不要求重训。显式复现见 [archive](../archive/README.md)，默认测试只含轻量归档行为测试。

## Git 与研究记录

- 需要提交的源码变更走任务分支和 monorepo PR；数据与运行产物保持忽略。
- 提交和推送前运行 `scripts/check_repository_data_safety.py`，CI 执行同一检查。
- 长期有效的模型口径写入本项目文档。债券单次实验的原始结果留在忽略目录，两融历史记录留在 `archive/margin_flow/archive/`。
- 每轮研究目录规则见 [AGENTS](../AGENTS.md)。审阅过的安全聚合证据和最终 `README.md` 可提交，规则见 [RESEARCH_REPORT](RESEARCH_REPORT.md)。

测试分层与覆盖率见 [TESTING](TESTING.md)。权限验收见[共享 AUTH](../../docs/AUTH.md#程序化权限测试)。
