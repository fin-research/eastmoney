# Choice 离线测试

测试取舍遵循[项目组测试规范](../../docs/TESTING.md)。覆盖率只代表注明的离线执行范围。

```bash
cmake -S . -B build-coverage -G Ninja -DCMAKE_BUILD_TYPE=Debug -DENABLE_COVERAGE=ON
cmake --build build-coverage
ctest --test-dir build-coverage --output-on-failure
mkdir -p coverage
cd coverage
# macOS / AppleClang; Linux GCC 将 xcrun llvm-cov gcov 替换为 gcov
xcrun llvm-cov gcov -b -c ../build-coverage/CMakeFiles/choice_rpc_core.dir/src/rpc_contract.cpp.gcno
xcrun llvm-cov gcov -b -c ../build-coverage/CMakeFiles/choice_rpc_core.dir/src/choice_backend.cpp.gcno
xcrun llvm-cov gcov -b -c ../build-coverage/CMakeFiles/choice-rpc-authorization-tests.dir/tests/test_authorization.cpp.gcno
```

`ENABLE_COVERAGE` 显式启用 gcov instrumentation，常规 Release 构建不变。Linux GCC 用 gcov。macOS AppleClang 用 `xcrun llvm-cov gcov` 读取 `build-coverage/CMakeFiles/` 中对应 `.gcno`，在 `coverage/` 中生成报告，避免污染仓库。只汇总 `src/`，不统计测试与第三方 C++ 头文件。

CTest 使用模拟 backend 验证匿名/用户拒绝、机器 RPC 方法、错误请求不调用 SDK，以及 HTTP 解析与响应。测试不加载 Choice SDK、不登录 office 或发送公网请求。`ENABLE_COVERAGE` 仅在 Debug 覆盖率构建启用，Release 镜像仍执行 CTest。

`main.cpp` 的 HTTP 边界覆盖不等于 `choice_backend.cpp` 的原生 SDK 数据转换、动态库加载和真实会话验收。RPC 变更还须核对 Data 消费端契约。线上可用性按 [开发与运行](DEVELOPMENT.md) 在 office 与 Data edge 分层验证。
