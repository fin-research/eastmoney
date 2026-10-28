import assert from "node:assert/strict";
import { get } from "svelte/store";
import { installDom, loadComponent } from "./svelte-dom.mjs";

const window = installDom();
// Observe expected animation cancellation during Svelte teardown in happy-dom;
// retain transitions and surface every other rejection as a test failure.
const nativeAnimate = window.HTMLElement.prototype.animate;
window.HTMLElement.prototype.animate = function (...args) {
  const animation = nativeAnimate.apply(this, args);
  animation.finished.catch(error => { if (error.name !== "AbortError") throw error; });
  return animation;
};
const { mount, unmount, flushSync } = await import("svelte");
const { globalMessages } = await import("../../src/lib/global-messages.ts");
const streams = [];
globalThis.fetch = async (_url, init) => {
  assert.equal(new Headers(init.headers).get("accept"), "text/event-stream");
  const stream = { cancelled: false };
  const body = new ReadableStream({
    start(controller) { stream.controller = controller; },
    cancel() { stream.cancelled = true; },
  });
  stream.emit = (event, value) => stream.controller.enqueue(new TextEncoder().encode(
    `event: ${event}\ndata: ${event === "result" ? JSON.stringify(value) : value}\n\n`,
  ));
  streams.push(stream);
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
};

const Host = await loadComponent("tests/helpers/AiPanelHost.svelte", `<script>
  import AiPanel from "../../src/lib/AiPanel.svelte";
  import { createAiClient, provideAiClient } from "../../src/lib/ai-client.svelte";
  const client = provideAiClient(createAiClient());
  export function run(title = "测试分析") { return client.run({ title, url: "/api/test-ai", parse: value => value, resultText: value => value.ok === true ? "材料核对完成。" : "比较结果已生成。" }); }
</script>
<AiPanel {client} identity={null} />`);

const settle = async () => {
  await new Promise(resolve => setTimeout(resolve, 260));
  flushSync();
};

const app = mount(Host, { target: document.body });
flushSync();
assert.equal(document.querySelector("[aria-label='打开 AI 面板']").textContent.trim(), "AI");

const pending = app.run();
await settle();
assert.ok(document.querySelector("#global-ai-panel"));
assert.match(document.querySelector(".ai-task-detail").textContent, /测试分析.*正在处理/s);
streams[0].emit("progress", "正在核对材料");
await settle();
assert.equal(document.querySelector(".ai-progress-copy p").textContent.trim(), "正在核对材料");
streams[0].emit("progress", "正在形成结论");
await settle();
assert.equal(document.querySelector(".ai-progress-copy p").textContent.trim(), "正在形成结论", "only the newest summary occupies the live progress slot");
const thinking = document.querySelector(".ai-thinking");
assert.equal(thinking.open, false);
assert.deepEqual([...thinking.querySelectorAll("li")].map(item => item.textContent), ["正在核对材料", "正在形成结论"]);

const secondPending = app.run("第二任务");
await settle();
assert.match(document.querySelector(".ai-task-detail").textContent, /第二任务.*正在处理/s, "a new task opens its own detail");
document.querySelector("[aria-label='返回任务列表']").click();
await settle();
assert.equal(document.querySelectorAll(".ai-task-list li").length, 2, "all concurrent tasks are listed one by one");
assert.doesNotMatch(document.querySelector("#global-ai-panel").textContent, /调用记录|清除/);
document.querySelector("[aria-label='查看第二任务']").click();
await settle();
streams[1].emit("progress", "正在比较结果");
await settle();
assert.equal(document.querySelector(".ai-progress-copy p").textContent.trim(), "正在比较结果");

streams[1].emit("result", { ok: "second" });
assert.deepEqual(await secondPending, { ok: "second" });
await settle();
assert.ok(document.querySelector("#global-ai-panel"), "the panel remains open after completion");
assert.match(document.querySelector(".ai-result").textContent, /比较结果已生成。/);
assert.doesNotMatch(document.querySelector(".ai-result").textContent, /"ok"/);
assert.match(document.querySelector(".ai-task-detail").textContent, /已完成/);
assert.equal(streams[1].cancelled, true);
assert.match(get(globalMessages).at(-1)?.message ?? "", /第二任务已生成/);

streams[0].emit("result", { ok: true });
assert.deepEqual(await pending, { ok: true });
await settle();
assert.equal(streams[0].cancelled, true);
document.querySelector("[aria-label='返回任务列表']").click();
await settle();
assert.match(document.querySelector(".ai-task-list").textContent, /测试分析.*已完成/s);
assert.match(document.querySelector(".ai-task-list").textContent, /第二任务.*已完成/s);
document.querySelector("[aria-label='查看测试分析']").click();
await settle();
assert.match(document.querySelector(".ai-result").textContent, /材料核对完成。/);

document.querySelector(".ai-panel-close").click();
await settle();
const trigger = document.querySelector("[aria-label='打开 AI 面板']");
assert.equal(document.activeElement, trigger);
trigger.click();
await settle();
assert.equal(document.querySelectorAll(".ai-task-list li").length, 2, "opening the label returns to the task list");

globalMessages.clear();
await unmount(app);
await window.happyDOM.abort();
console.log("Unified AI panel detail, progress history, result and completion notification passed");
