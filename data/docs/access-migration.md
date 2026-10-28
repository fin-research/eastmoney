# Data 私有接入与访问边界

本站公网认证、公开资源白名单、机器凭据与路由权限由独立 [Gateway](../../gateway/AGENTS.md) 维护。Data 不校验 JWT、不查询 Auth0 或权限表，不接受旧 Cloudflare Access Service Token。

## 私有入口

- `GatewayData`：只由 Gateway 的 `DATA` binding 调用，接收版本化 Base64URL 上下文。GraphQL Choice 字段在调用上游前应用 Gateway 的授权结果。
- `InternalData`：保留 Dashboard/Ingest 的原机器调用，直接执行内部资源，不依赖用户会话。
- 默认 fetch：所有路径、方法和自报身份头均返回 404。Wrangler `routes=[]`、`workers_dev=false`、`preview_urls=false`。不设置 Custom Domain。

命名入口由 Cloudflare binding 选择，不能通过 HTTP URL、Host、Referer、Cookie 或自报头选中。Data 可消费已批准结果，但不重新决定用户/角色权限。

## 保留的公开契约

Gateway 允许 DM、东方财富网、固定市场行业快照、health/config/API 文档等精确 GET/HEAD 资源公开。通用 Choice 及 CAMEL 需要有效用户登录。CAMEL 未新增公网业务 handler。未知资源和不支持方法沿用 Data 的 404/405/参数错误契约。

GraphQL 的公开字段不依赖身份服务。Gateway 对实际选中的操作、别名和片段判断 Choice 范围，并提供字段结果。Data 保留公开字段、返回受保护字段错误，不消耗匿名 Choice 额度。内部查询由 `InternalData` 的机器边界覆盖。

不改变 REST DTO、fields/参数白名单、GraphQL 子请求预算或 Cache-Control。内部 DM/Choice/CAMEL 继续 VPC binding，不能加公网回退。

## 验证与发布

执行 `pnpm check`、`pnpm deploy:dry` 与 `git diff --check`。Gateway 联调脚本覆盖真实 Data handler。真实登录使用 Gateway `pnpm auth:verify`，只执行 HTTP/CLI，禁止 browser。Choice 用缺参数 422 探针。VPC 连通性按 DEVELOPMENT。

跨 Worker 发布与移除本站 Access 应用的顺序由 [Gateway DEVELOPMENT](../../gateway/docs/DEVELOPMENT.md) 维护。原 `configure-public-access.mjs` 是旧架构迁移脚本，不再用于生产配置。
