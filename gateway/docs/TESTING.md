# Gateway 测试

测试取舍遵循[项目组测试规范](../../docs/TESTING.md)。`pnpm test` 运行全部测试，`pnpm test:coverage` 生成覆盖率，统计范围为已加载的 `src/**/*.ts/js`。

安全边界必须由测试保护：路由权限、匿名与登录身份、组织隔离、机器 scope、JWT、客户端 PKCE、遗留 Cookie 的拒绝与清理。合并测试时不削弱这些行为。

真实 Auth0 登录和生产路由绕过按 [AUTH](../../docs/AUTH.md#程序化权限测试)用程序化 HTTP 验收。
