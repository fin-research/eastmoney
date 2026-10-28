# Choice office RPC

Office-only C++ service for six read-only Choice SDK methods. It uses one SDK session and listens on loopback through Docker host networking. The Data Worker reaches it through Workers VPC.

GitHub Actions builds and publishes the Linux amd64 image to GHCR. Office runs the published image with runtime credentials kept outside Git and image layers.

- [AGENTS](AGENTS.md): constraints and required validation.
- [Agent routing](AGENTS.md#context-routing): HTTP/RPC, native SDK and office operations.
- [RPC contract](docs/API.md): methods, table result, version and errors.
- [Build and office operations](docs/DEVELOPMENT.md): GHCR, deployment and SDK updates.
- [Project rules](../AGENTS.md): shared service and storage boundaries.
