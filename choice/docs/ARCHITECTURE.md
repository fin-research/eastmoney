# Choice service architecture

The cross-project VPC path and service ownership are in [shared architecture](../../docs/ARCHITECTURE.md). This document covers the internal boundaries of the office service.

- [main.cpp](../src/main.cpp) handles loopback HTTP requests and passes allowed methods to the RPC contract.
- [rpc_contract.cpp](../src/rpc_contract.cpp) owns allowed functions, request validation, result normalization and safe error shapes. See [API](API.md).
- [choice_backend.cpp](../src/choice_backend.cpp) alone loads the native SDK. It manages login, recovery and release of native data, under the single-session rule in [AGENTS](../AGENTS.md#rules).
- CSD may return unpadded dates such as `2026/8/28`. The backend normalizes them to ISO dates, and [test_rpc.cpp](../tests/test_rpc.cpp) covers this.
- Data owns the Worker-side VPC client and the public DTO validation.
