# AGENTS.md

## Project Overview

Office-only C++ JSON-RPC service for the stateful Choice Linux SDK. It listens on `127.0.0.1:8767` through Docker host networking. The `data` Worker reaches it through the private `choice` VPC Service. GitHub Actions publishes the Linux amd64 image to `ghcr.io/fin-research/choice`.

## Rules

- Expose only the six read-only methods in [API](docs/API.md).
- Keep one process, one SDK session and serialized requests. A second login, a background login or per-request login/logout breaks the stateful session.
- `CHOICE_AUTH` and `CHOICE_RPC_TOKEN` are runtime secrets. Keep them out of source, CI, image layers, logs, fixtures and docs.
- Bind to loopback only. A public firewall or Cloudflare Tunnel must not expose port 8767.
- Upgrade `libEMQuantAPIx64.so` and `ServerList.json.e` together. Do not commit generated `userInfo`, logs or activation files.
- The Docker build compiles with warnings as errors and runs CTest before the runtime stage.

## Validation and Delivery

- Local: `cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release`, `cmake --build build`, `ctest --test-dir build --output-on-failure`.
- Public image check: `docker build --target build -t choice:local .`. The runtime image needs the private SDK source; see [DEVELOPMENT](docs/DEVELOPMENT.md).
- Before committing, run `git diff --check` and keep credentials and generated runtime files out of staging.

## Context Routing

Read only the affected topic:

- HTTP listener, dispatch, serialization, SDK session and recovery: [ARCHITECTURE](docs/ARCHITECTURE.md).
- Methods, dates, errors and protocol: [API](docs/API.md).
- CMake, Docker, GHCR and the office connector: [DEVELOPMENT](docs/DEVELOPMENT.md).
- Tests and coverage: [TESTING](docs/TESTING.md).
- Worker consumer changes: [Data AGENTS](../data/AGENTS.md#context-routing). Cross-service changes: [shared architecture](../docs/ARCHITECTURE.md).

Before any live Choice data call, follow the [quota plan](../docs/CHOICE.md).
