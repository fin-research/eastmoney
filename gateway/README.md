# Eastmoney Gateway

Eastmoney 的唯一公网 Hono Worker：Auth0 登录与 JWT/JWKS 校验、账号与角色、路由权限、账号目录和角色权限配置。

```
Browser / HTTP client → Gateway → Service Binding → Dashboard / Data / Quant ResearchReport
Dashboard → IdentityService → Gateway
Dashboard / Ingest → InternalData → Data
```

Dashboard 与 Data 不公开 origin，也不验证 JWT。应用校验记录归属、业务状态、输入、RLS 和材料访问。

开发约定见 [AGENTS](AGENTS.md)，配置与验证见 [DEVELOPMENT](docs/DEVELOPMENT.md)，认证规则见 [AUTH](../docs/AUTH.md)。权限与路由以[权限目录](src/lib/permissions.ts)和[路由权限](src/lib/route-permissions.ts)为准。
