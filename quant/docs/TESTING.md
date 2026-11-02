# Quant 测试

测试取舍遵循[项目组测试规范](../../docs/TESTING.md)。默认验证命令见 [DEVELOPMENT](DEVELOPMENT.md#validation)。

## 覆盖率

`coverage.py` 配置在 `pyproject.toml`：统计应用 Python 和分支，排除测试、虚拟环境、`scripts/` 与 `skills/`。报告写入忽略的 `coverage/`。

```bash
uv run coverage run -m unittest discover -s tests -v
uv run coverage report
uv run coverage html
```

保留的行为测试覆盖时序切分、原始索引、完整验证窗口、模型输入范围、Choice 错误语义和报告业务契约。覆盖率不证明真实数据更新、写库、线上 Workflow 或长耗时模型已验收。未执行的模块留在分母内。

## 持续验证

[根 CI](../../.github/workflows/ci.yml) 在 Quant 或 `dashboard/financing-model-migrations/` 受影响时调用 [quant.yml](../../.github/workflows/quant.yml)。两个 job 都不配置业务凭据，不训练真实模型、不调用付费 Choice、不部署 Worker。

- `python`：macOS 15 ARM64、Python 3.12、`uv sync --locked`（不装两融可选依赖）。运行全部单元测试、compileall、`uvx ruff@0.15.9` 的 lint 与复杂度检查、`uv lock --check`、`scripts/check_repository_data_safety.py` 和 `scripts/build_report.py --check`。
- `node`：Ubuntu、Node 24、根 pnpm 锁。运行 `online/` 的 `pnpm test`、`typegen`（并核对 `worker-configuration.d.ts` 无差异）、`typecheck` 和 `deploy:dry`（含静态报告构建）。

CI 通过不能替代真实研究、模型激活或生产验收。
