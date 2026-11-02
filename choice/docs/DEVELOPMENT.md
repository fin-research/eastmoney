# Choice build and office operations

Local commands and delivery checks are in [AGENTS](../AGENTS.md#validation-and-delivery).

## Build and publish

The public monorepo holds the C++ source, tests and Dockerfile. It does not hold the licensed Choice SDK binaries. Public CI builds the Docker `build` stage and runs CTest.

The private `fin-research/choice` repository holds the SDK and the packaging workflow. The workflow takes a validated full SHA from `fin-research/eastmoney` `main`, reads both SDK files from a fixed private revision, builds the public source and publishes the image. The build needs no Choice login credential.

```sh
gh workflow run publish.yml --repo fin-research/choice -f source_revision=<validated-monorepo-sha>
```

The image is `ghcr.io/fin-research/choice:latest`, with immutable tags `sha-<monorepo-commit>`. Office pulls it with read-only GHCR credentials and tracks the `latest` digest through WUD. Build the production image only through this workflow, never on office.

[Dockerfile](../Dockerfile), [CMakeLists](../CMakeLists.txt) and the [packaging workflow](https://github.com/fin-research/choice/blob/main/.github/workflows/publish.yml) define the image.

## Office deployment

The office host must be Linux x86-64. The image carries the Linux x64 native library and server list.

1. Keep `CHOICE_AUTH` and `CHOICE_RPC_TOKEN` in `/home/shi/.config/eastmoney/choice-rpc.env`, outside Git, with mode `0600`.
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

3. Run `curl http://127.0.0.1:8767/health` on the office host.
4. Put the same RPC token in the Data Worker secret `CHOICE_RPC_TOKEN`.

The VPC connector must share the host network namespace with the loopback listener. A host service or a host-network container does this. A Docker bridge does not. Check the actual connector and container state during operations.

When you upgrade the official SDK, replace both SDK files in the private source together. Inject credentials only at runtime.

## Verification

CTest and the Docker build verify the protocol and the image. After deployment, check separately the real Choice session, the office loopback and the Data VPC path. Public login and permission checks belong to [AUTH](../../docs/AUTH.md#程序化权限测试) and to Gateway and Data. Coverage commands are in [TESTING](TESTING.md).
