# AGENTS.md

## Project Overview

Office-only C++ JSON-RPC service for the stateful Choice Linux SDK. GitHub Actions builds the Linux amd64 image and publishes it to `ghcr.io/fin-research/choice`. The service listens only on `127.0.0.1:8767` through Docker host networking.
The Cloudflare `data` Worker reaches it through the private `choice` VPC Service.

## Mandatory Rules

- Keep the RPC surface limited to the six documented read-only Choice methods.
- Preserve single-process, single-session request serialization. Do not add a
  second SDK login, background login, or per-request login/logout.
- `CHOICE_AUTH` and `CHOICE_RPC_TOKEN` are runtime secrets. Never place them in
  source, GitHub Actions, image layers, logs, fixtures, or documentation.
- Never publish port 8767 through a public firewall or Cloudflare Tunnel
  ingress. The process must bind to loopback and use Docker host networking.
- Update `libEMQuantAPIx64.so` and `ServerList.json.e` together when upgrading
  the Choice SDK. Never commit generated `userInfo`, logs, or activation files.
- The Docker build must compile with warnings as errors and run CTest before
  producing the runtime image.

## Validation and Delivery

- Local C++ validation: `cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release`,
  `cmake --build build`, `ctest --test-dir build --output-on-failure`.
- Public image validation: `docker build --target build -t choice:local .`.
- Full runtime image packaging uses the private SDK source; see docs/DEVELOPMENT.md.
- GitHub Actions builds pull requests without publishing. Public monorepo CI builds the SDK-free build stage. The private
  packaging workflow publishes validated monorepo commits with a fixed SDK source.
  Office tracks the existing private `latest` digest through WUD.
- Before committing, run `git diff --check` and exclude credentials and generated Choice runtime files from staging.

## Context Routing

Read [project AGENTS](../AGENTS.md) once for cross-project execution/worktree rules when absent from context. Read only the affected topic: HTTP listener, dispatch, serialization, SDK session and recovery use [ARCHITECTURE](docs/ARCHITECTURE.md); read-only methods, dates, errors and protocol use [API](docs/API.md); CMake, Docker, GHCR and office connector use [DEVELOPMENT](docs/DEVELOPMENT.md). Worker consumer changes use [Data AGENTS](../data/AGENTS.md#context-routing), and cross-service changes add [shared architecture](../docs/ARCHITECTURE.md).

Before any live Choice data call, follow [quota planning](../docs/CHOICE.md). This repository needs no local DATABASE or DESIGN. Do not load all documents or reread existing context.

## 权限测试

共享认证架构、各权限范围及测试账号配置见 [项目组 AUTH](../docs/AUTH.md)。权限登录与验收只使用程序化 HTTP、单元测试与 CLI，禁止 browser、Chrome、Playwright 和浏览器 MCP。新增测试仅使用匿名和 `test@18.cn` 两种身份。真实密码只读根目录 `.env`，不进入测试夹具或日志。

## 测试规范

测试新增、合并、覆盖率与视觉回归按 [TESTING](docs/TESTING.md) 执行。不要通过源码样式或控件数量锁定代替行为验证。
