# Eastmoney Gateway

本站唯一公网 Worker：Auth0 登录、JWT 校验、账号目录、角色权限和路由准入。Dashboard 与 Data 只经命名 Service Binding 接收请求，不校验 JWT。

## Rules

- 遵循 [项目组入口](../AGENTS.md)、[AUTH](../docs/AUTH.md) 和 [架构](../docs/ARCHITECTURE.md)。认证、token 和权限缓存规则只在 AUTH 维护。
- Gateway 维护路由权限目录。记录归属、输入白名单、业务状态、RLS 和材料保密检查留在业务层。
- 转发前移除外部身份头与凭据，重新生成可信上下文。默认拒绝未知路由、方法和重复 action。
- 绑定类型用 `pnpm typegen` 生成。交付运行 `pnpm check`、`pnpm deploy:dry`、`git diff --check`。
- 跨仓库集成后，用 `pnpm auth:verify` 核对真实登录，并检查后端 origin 无法绕过 Gateway。
- 迁移测试随所有权移动。

命令、Auth0 配置和发布顺序见 [DEVELOPMENT](docs/DEVELOPMENT.md)，测试取舍见 [TESTING](docs/TESTING.md)。
