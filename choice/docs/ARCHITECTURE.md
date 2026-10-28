# Choice service architecture

The cross-project VPC path and service ownership are in [shared architecture](../../docs/ARCHITECTURE.md). This document owns the office service's internal boundaries.

- [main.cpp](../src/main.cpp) handles loopback HTTP requests and passes allowed methods to the RPC contract.
- [rpc_contract.cpp](../src/rpc_contract.cpp) owns allowed functions, request validation, result normalization and safe error shapes. See [API](API.md).
- [choice_backend.cpp](../src/choice_backend.cpp) alone loads the native SDK and manages login, recovery and native data release. Keep one process, one SDK session and serialized requests. Do not add per-request login/logout or parallel SDK sessions.
- Native SDK and server list upgrades remain paired. Runtime credentials, activation files, generated userInfo and logs stay outside source and images. See [development](DEVELOPMENT.md).
- CSD may return unpadded dates such as `2026/8/28`. Normalize them to ISO and retain [CTest coverage](../tests/test_rpc.cpp).
- Data owns the Worker-side VPC client and public DTO validation. This service does not gain public `/data` routes, business calculations, a database or UI.
