# AGENTS.md

## Project Overview

Private Cloudflare data API. A Hono TypeScript Worker serves `/data` resources
behind the Gateway through named Service Bindings. DM uses the `DM` Workers VPC binding. Choice uses `CHOICE_RPC` to call the small C++ SDK service on the office host.
CAMEL funding-system calls use the `CAMEL` VPC binding, Cloudflare Secrets for
the source credentials, AI Gateway for CAPTCHA recognition, and a named Cache
API cache for the short-lived login session. Do not use Cloudflare Containers or other paid compute.

## Mandatory Rules

- Public paths at the Gateway retain `/data`; private/local handlers may use
  historical prefix-free paths. No origin is publicly reachable.
- Every request to `rest.innodealing.com` must use `env.DM.fetch`; never fall
  back to global `fetch` for this host.
- Every Choice request must use `env.CHOICE_RPC.fetch`; do not expose the office
  RPC service publicly or call it through ordinary Internet fetch.
- Every CAMEL request must use `env.CAMEL.fetch`; never expose the office
  funding system publicly or call it through ordinary Internet fetch.
- `DM_COOKIE`, `CHOICE_RPC_TOKEN`, `CF_AIG_TOKEN`, `CAMEL_USERNAME`, and
  `CAMEL_PASSWORD` are Worker secrets. `CHOICE_AUTH` exists only on the office
  Docker host. Never place them in source, Wrangler vars, logs, fixtures, image
  layers, or docs. CAMEL session cache entries may contain only the access
  token, token name, device ID, and server-derived expiry.
- Preserve established status codes, the thin compatibility GraphQL, and
  `Cache-Control` behavior. GraphQL mirrors every public data resource by
  delegating to the same REST handler and contract. Market-report aggregation
  is intentionally absent: expose single-resource fields without adding
  report-specific wrappers, business calculations, or upstream envelopes.
- Gateway owns public authentication and authorization.
  Data has no public routes, workers.dev or preview URLs; its default fetch is 404.

  Only `GatewayData` consumes the Gateway verdict/context; `InternalData` is the
  existing machine binding for Dashboard/Ingest. Never infer internal trust from
  a public header or restore an Access JWT verifier. GraphQL applies the Gateway
  Choice verdict before upstream execution and preserves partial public results.
- REST upstream values must pass the Zod contracts in `src/contracts.ts` before
  they cross the public boundary. List resources return a top-level JSON array;
  object resources return a top-level object. Keep the `fields` allowlist and
  generated OpenAPI synchronized with those contracts; never expose arbitrary
  upstream keys.
- Keep the Worker compatible with the Workers Free 10 ms CPU limit. Record both
  local CPU profiles and production invocation CPU before calling a route safe.
- The user authorizes necessary manual deployments. Do not ask again. Validate with typegen,
  typecheck, Worker tests, dry-run, and diff checks. Validate RPC changes in the
  independent `choice` repository.

## Commands

- Install: `pnpm install`
- Generate bindings: `pnpm typegen`
- Typecheck: `pnpm typecheck`
- Worker tests: `pnpm test`
- Full static validation: `pnpm check`
- Worker/config dry run: `pnpm deploy:dry`
- Startup profile: `pnpm check:startup`
- CPU route benchmark: `pnpm benchmark:cpu`

## Context Routing

Cross-project execution and worktree rules: [project AGENTS](../AGENTS.md), read once when absent from context. Select only the affected topic below; do not load all documentation or reread existing context.

- Worker entrypoints, Hono routing and local dependencies: [ARCHITECTURE](docs/ARCHITECTURE.md); cross-service changes: [shared architecture](../docs/ARCHITECTURE.md).
- REST/GraphQL/MCP contracts, DM, Eastmoney web and ChinaMoney resources: [API](docs/API.md); login and authorization: [access protection](docs/access-migration.md).
- Choice queries, market snapshots and trading calendar: [Choice RPC API](../choice/docs/API.md) and [quota and rate-limit planning](../docs/CHOICE.md); implementation begins in `src/choice/`, `src/services/eastmoney-market.ts` and `src/trading-calendar.ts`.
- AI/CAPTCHA: [CAMEL](docs/modules/camel.md) and [shared AI](../docs/AI.md).
- Validation, publishing and VPC smoke: [DEVELOPMENT](docs/DEVELOPMENT.md).
- EDB and raw Quant input sync/backfill: [economic sync](docs/modules/economic-indicator-sync.md) and [Quant inputs](docs/modules/quant-inputs.md) and [prospective issuance observations](docs/modules/issuance-observations.md); storage ownership is in [shared DATABASE](../docs/DATABASE.md).
- CPU and subrequest evidence: [CPU_BUDGET](docs/CPU_BUDGET.md). Legacy FastAPI/VPC switching: [historical MIGRATION](docs/MIGRATION.md), not current runtime evidence.

## 权限测试

共享认证架构、各权限范围及测试账号配置见 [项目组 AUTH](../docs/AUTH.md)。权限登录与验收只使用程序化 HTTP、单元测试与 CLI，禁止 browser、Chrome、Playwright 和浏览器 MCP。新增测试仅使用匿名和 `test@18.cn` 两种身份。真实密码只读根目录 `.env`，不进入测试夹具或日志。

## 测试规范

测试新增、合并、覆盖率与视觉回归按 [TESTING](docs/TESTING.md) 执行。不要通过源码样式或控件数量锁定代替行为验证。
