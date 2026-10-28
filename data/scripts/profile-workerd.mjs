const inspectorPort = Number(process.env.WORKER_INSPECTOR_PORT ?? "9230");
const workerOrigin = process.env.WORKER_ORIGIN ?? "http://127.0.0.1:8791";
const samplingIntervalMicroseconds = 100;
const targets = [
  { name: "health", path: "/data/health" },
  { name: "openapi", path: "/data/openapi.json" },
  {
    name: "graphql metadata",
    path: "/data/graphql",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
    },
  },
  { name: "stock summary", path: "/data/stock-summary?date=2026-08-28" },
];

const pages = await fetch(`http://127.0.0.1:${inspectorPort}/json`).then((response) =>
  response.json()
);
const debuggerUrl = pages[0]?.webSocketDebuggerUrl;
if (typeof debuggerUrl !== "string") throw new Error("workerd inspector is unavailable");

const socket = new WebSocket(debuggerUrl, {
  origin: `http://127.0.0.1:${inspectorPort}`,
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  const callback = pending.get(message.id);
  if (!callback) return;
  pending.delete(message.id);
  if (message.error) callback.reject(new Error(message.error.message));
  else callback.resolve(message.result);
});

function command(method, params = {}) {
  const id = nextId;
  nextId += 1;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await command("Profiler.enable");
await command("Profiler.setSamplingInterval", { interval: samplingIntervalMicroseconds });

const results = [];
for (const target of targets) {
  for (let warmup = 0; warmup < 3; warmup += 1) {
    const response = await fetch(`${workerOrigin}${target.path}`, target.init);
    await response.arrayBuffer();
  }
  await command("Profiler.start");
  const started = performance.now();
  const response = await fetch(`${workerOrigin}${target.path}`, target.init);
  await response.arrayBuffer();
  const wallMs = performance.now() - started;
  const { profile } = await command("Profiler.stop");
  const names = new Map(profile.nodes.map((node) => [
    node.id,
    node.callFrame?.functionName ?? "",
  ]));
  let activeMicroseconds = 0;
  const frames = new Map();
  for (let index = 0; index < profile.samples.length; index += 1) {
    const name = names.get(profile.samples[index]) || "(anonymous)";
    // V8 does not sample an isolate while it waits for network I/O. The next
    // timeDelta can therefore include the whole idle gap; cap it to two sample
    // intervals instead of misreporting network wait as Worker CPU.
    const delta = Math.min(
      profile.timeDeltas[index] ?? 0,
      samplingIntervalMicroseconds * 2,
    );
    frames.set(name, (frames.get(name) ?? 0) + delta);
    if (name !== "(idle)") activeMicroseconds += delta;
  }
  results.push({
    route: target.name,
    status: response.status,
    wall_ms: Number(wallMs.toFixed(3)),
    sampled_active_cpu_ms_excluding_io_gaps: Number(
      (activeMicroseconds / 1000).toFixed(3),
    ),
    top_sampled_frames: [...frames.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([name, microseconds]) => ({
        name,
        milliseconds: Number((microseconds / 1000).toFixed(3)),
      })),
  });
}

socket.terminate();
console.log(JSON.stringify({
  warning: "Local workerd sampling is approximate and is not production Trace cpuTime.",
  sampling_interval_microseconds: samplingIntervalMicroseconds,
  results,
}, null, 2));
import WebSocket from "ws";
