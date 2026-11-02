# Choice 离线测试

测试取舍遵循[项目组测试规范](../../docs/TESTING.md)。CTest 的两个目标是 `choice-rpc-tests`（RPC 契约）和 `choice-rpc-authorization-tests`（HTTP 层）。

```bash
cmake -S . -B build-coverage -G Ninja -DCMAKE_BUILD_TYPE=Debug -DENABLE_COVERAGE=ON
cmake --build build-coverage
ctest --test-dir build-coverage --output-on-failure
mkdir -p coverage
cd coverage
# macOS / AppleClang；Linux GCC 将 xcrun llvm-cov gcov 替换为 gcov
xcrun llvm-cov gcov -b -c ../build-coverage/CMakeFiles/choice_rpc_core.dir/src/rpc_contract.cpp.gcno
xcrun llvm-cov gcov -b -c ../build-coverage/CMakeFiles/choice_rpc_core.dir/src/choice_backend.cpp.gcno
xcrun llvm-cov gcov -b -c ../build-coverage/CMakeFiles/choice-rpc-authorization-tests.dir/tests/test_authorization.cpp.gcno
```

`ENABLE_COVERAGE` 开启 gcov instrumentation，仅用于 Debug 覆盖率构建。报告写入 `coverage/`，只汇总 `src/`。

CTest 用模拟 backend 验证以下行为。

- 无有效 RPC token 的请求被拒绝，六个 RPC 方法可达。
- 错误请求不调用 SDK，日志与请求 ID 脱敏。
- HTTP 解析与响应正确。

测试不加载 Choice SDK，不登录 office，也不发公网请求。

`main.cpp` 的 HTTP 覆盖不覆盖 `choice_backend.cpp` 的原生数据转换、动态库加载和真实会话，这些在部署后验证（见 [DEVELOPMENT](DEVELOPMENT.md#verification)）。RPC 变更须同时核对 Data 的消费端契约。
