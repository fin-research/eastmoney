# Choice build and office operations

Local required commands and delivery checks remain in [AGENTS](../AGENTS.md#validation-and-delivery). Cross-project worktree rules are in [project AGENTS](../../AGENTS.md#parallel-development).

## Build and publish

The public monorepo contains the C++ source, tests and Dockerfile.
It does not distribute the licensed Choice SDK binaries.
Public CI builds the Docker `build` stage and runs CTest.

The private `fin-research/choice` repository retains the SDK and packaging workflow.
That workflow accepts a validated full SHA from `fin-research/eastmoney` main.
It reads both SDK files from the fixed private revision recorded in the workflow.
It builds the public source and publishes the existing private image.
No Choice login credential is needed during the build.

```sh
gh workflow run publish.yml --repo fin-research/choice -f source_revision=<validated-monorepo-sha>
```

The image remains `ghcr.io/fin-research/choice:latest`.
Immutable tags use `sha-<monorepo-commit>`.
Office continues to use read-only GHCR credentials.

## Office deployment

1. Keep `CHOICE_AUTH` and `CHOICE_RPC_TOKEN` in
   `/home/shi/.config/eastmoney/choice-rpc.env`, outside Git, with mode `0600`.
2. Pull and start the image as a standalone host-network container:

   ```bash
   docker pull ghcr.io/fin-research/choice:latest
   docker run -d --name data --restart unless-stopped --network host \
     --env-file /home/shi/.config/eastmoney/choice-rpc.env \
     --label wud.watch=true \
     --label wud.watch.digest=true \
     --label wud.tag.include=latest \
     --label wud.trigger.include=docker.data \
     ghcr.io/fin-research/choice:latest
   ```

3. Confirm `curl http://127.0.0.1:8767/health` on the office host.
4. Put the same RPC token in the Data Worker secret `CHOICE_RPC_TOKEN`.

The office host must be Linux x86-64. The deployed image is
`ghcr.io/fin-research/choice:latest`. It contains the Linux x64 native library
and server list already used by the former API runtime. Replace both files
in the private SDK source together when upgrading the official Choice C++ SDK.
Inject credentials only at runtime. Never write them into the image.

The connector must share the host network namespace with the loopback listener; a host service or host-network container can satisfy this. Do not use a Docker bridge for this VPC target. Verify the actual connector and container state during operations; historical Data migration notes are not a live inventory.

[Dockerfile](../Dockerfile), [CMakeLists](../CMakeLists.txt), and [private packaging workflow](https://github.com/fin-research/choice/blob/main/.github/workflows/publish.yml) define image behavior. Office consumes the published image; do not build the production image on office.

## 验证边界

本仓库 CTest 与 Docker build 验证协议和镜像。真实 Choice 会话、office loopback 与 Data VPC 由部署后的独立检查确认。公网 Auth0 登录和业务权限验收由 [共享 AUTH](../../docs/AUTH.md#程序化权限测试) 与 Gateway/Data 所有方执行，不以 RPC 本地测试代替。

覆盖率口径见 [TESTING](TESTING.md)。
