# Choice office RPC

Office-only C++ service for six read-only Choice SDK methods. It keeps one SDK session and listens on loopback through Docker host networking. The Data Worker reaches it through Workers VPC.

GitHub Actions publishes the Linux amd64 image to GHCR. Office runs it with runtime credentials kept outside Git and image layers.

- [AGENTS](AGENTS.md): rules, validation and routing.
- [Architecture](docs/ARCHITECTURE.md): service internals.
- [RPC contract](docs/API.md): methods, table result, version and errors.
- [Build and office operations](docs/DEVELOPMENT.md): GHCR, deployment and SDK updates.
- [Tests](docs/TESTING.md): CTest and coverage.
- [Project rules](../AGENTS.md): shared service and storage boundaries.
