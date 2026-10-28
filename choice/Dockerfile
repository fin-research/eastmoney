FROM debian:bookworm-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       cmake \
       g++ \
       ninja-build \
       nlohmann-json3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY CMakeLists.txt ./
COPY include ./include
COPY src ./src
COPY tests ./tests
RUN cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build \
    && ctest --test-dir build --output-on-failure

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 choice
WORKDIR /opt/choice
COPY --from=build /src/build/choice-rpc /usr/local/bin/choice-rpc
COPY vendor/linux-x64/libEMQuantAPIx64.so ./lib/libEMQuantAPIx64.so
COPY vendor/linux-x64/ServerList.json.e ./lib/ServerList.json.e
RUN chown -R choice:choice /opt/choice

USER choice
ENV PORT=8767
EXPOSE 8767
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8767; printf 'GET /health HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3; grep -q '200 OK' <&3"]
ENTRYPOINT ["/usr/local/bin/choice-rpc"]
