# Quant 测试

测试取舍遵循[项目组测试规范](../../docs/TESTING.md)。覆盖率使用 `coverage.py`，配置见 `pyproject.toml`：统计应用 Python 与分支，排除测试、虚拟环境和维护脚本。报告只写入忽略的 `coverage/`。

```bash
uv run coverage run -m unittest discover -s tests -v
uv run coverage report
uv run coverage html
```

保留时序切分、原始索引、完整验证窗口、模型输入范围、Choice 错误语义和报告业务契约的行为测试。覆盖率不证明真实数据更新、写库、线上 Workflow 或长耗时模型已验收。未执行模块仍在分母内，不能靠排除业务代码提高数字。

## 持续验证

GitHub Actions 在 push 和 pull request 时分别执行[数据安全与报告检查](../.github/workflows/data-safety.yml)及[工程回归](../.github/workflows/tests.yml)。Python 使用 macOS ARM64、Python 3.12 和锁定的默认依赖，执行全部单元测试、编译、lint、复杂度及锁文件检查。不安装两融可选训练依赖。Node 使用 Node 24 和冻结的 pnpm 锁文件，执行全部行为测试、绑定生成差异、类型和 Worker dry-run，包含静态报告构建。

两个测试 job 不配置业务凭据，不训练真实模型、调用付费 Choice 或部署 Worker。Python 测试中的 Node 子进程同样使用显式配置的 Node 24。Ruff 是工作流中固定版本的独立检查工具，不改变科学依赖锁。托管运行失败必须修复，不通过跳过测试或忽略错误交付。工程回归通过不能替代真实研究、模型激活或生产验收。
