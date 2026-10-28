import assert from "node:assert/strict";
import { installDom, loadComponent } from "./svelte-dom.mjs";

const window = installDom();
const { mount, unmount, flushSync, tick } = await import("svelte");
const session = { turns: [], running: false, progress: "", error: null, startedAt: 0 };
const pending = [];
globalThis.fetch = async () => new Promise(resolve => pending.push(() => resolve(Response.json(session))));

const Host = await loadComponent("tests/helpers/ChatHost.svelte", `<script>
  import CreditAssistantView from "../../src/lib/credit-assistant/CreditAssistantView.svelte";
  import { createAiClient, provideAiClient } from "../../src/lib/ai-client.svelte";
  const aiClient = provideAiClient(createAiClient());
  let view = $state("assistant");
  export function changeView(next) { view = next; }
  export function aiProgress() { return aiClient.activeTask?.progress.at(-1); }
</script>
<div class="tr-workbench">
  <header><div id="tr-topbar-actions"></div></header>
  <section class="tr-workspace"><main>
    {#if view === "assistant"}<CreditAssistantView />{:else}<section data-view={view}>其他标签页</section>{/if}
  </main></section>
</div>`);
const app = mount(Host, { target: document.body });
flushSync();
for (const next of ["calendar", "weekly", "overview"]) {
  assert.equal(document.querySelectorAll(".credit-chat").length, 1);
  assert.equal(document.querySelectorAll("#tr-topbar-actions .chat-toolbar").length, 1);
  flushSync(() => app.changeView(next));
  assert.equal(document.querySelectorAll(".credit-chat, #credit-question").length, 0, "previous chat must be removed");
  assert.equal(document.querySelectorAll("#tr-topbar-actions .chat-toolbar").length, 0);
  assert.equal(document.querySelector(`[data-view="${next}"]`)?.textContent, "其他标签页");
  pending.splice(0).forEach(resolve => resolve());
  await tick();
  assert.equal(document.querySelectorAll(".credit-chat").length, 0, "late network completion must not restore chat");
  flushSync(() => app.changeView("assistant"));
}
await unmount(app);
pending.splice(0).forEach(resolve => resolve());
await tick();
assert.equal(document.querySelectorAll(".credit-chat, .chat-toolbar, .tr-workbench").length, 0);

// Exercise the real component with the unified AI client and a controllable SSE
// transport. No browser or authentication flow is involved in this regression.
const streams = [];
const running = { ...session, running: true, questionId: "q-1", pendingQuestion: "公司资产是多少", progress: "正在检索资料" };
const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({ url: String(url), options });
  if (!String(url).includes("/session/events")) return Response.json(running);
  const stream = { url: String(url), closed: false };
  const body = new ReadableStream({
    start(controller) { stream.controller = controller; },
    cancel() { stream.closed = true; },
  });
  stream.emit = (event, value) => stream.controller.enqueue(new TextEncoder().encode(
    `event: ${event}\ndata: ${event === "result" ? JSON.stringify(value) : value}\n\n`,
  ));
  streams.push(stream);
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
};
const streamingApp = mount(Host, { target: document.body });
flushSync();
await new Promise(resolve => setImmediate(resolve));
flushSync();
assert.equal(streams.length, 1);
assert.match(streams[0].url, /session\/events$/);
assert.equal(document.querySelector(".credit-stages"), null);
assert.match(document.querySelector(".credit-activity").textContent, /检索资料/);
assert.equal(document.querySelector("#credit-question").hasAttribute("maxlength"), false);
streams[0].emit("progress", "正在分析授信材料");
await new Promise(resolve => setImmediate(resolve));
flushSync();
assert.equal(streamingApp.aiProgress(), "正在分析授信材料");
assert.match(document.querySelector(".credit-activity").textContent, /检索资料/);
assert.equal(requests.length, 2, "one history request and one SSE request are sufficient");
flushSync(() => streamingApp.changeView("weekly"));
await new Promise(resolve => setImmediate(resolve));
assert.equal(streams[0].closed, true);
flushSync(() => streamingApp.changeView("assistant"));
await new Promise(resolve => setImmediate(resolve));
flushSync();
assert.equal(streams.length, 2, "remount resumes the same user session");
streams[1].emit("result", { ...running, running: false, pendingQuestion: "", error: "模型暂不可用" });
await new Promise(resolve => setImmediate(resolve));
flushSync();
assert.equal(streams[1].closed, true);
assert.match(document.querySelector(".answer-error").textContent, /模型暂不可用/);
await unmount(streamingApp);
await window.happyDOM.abort();
console.log("Credit chat lifecycle, unified SSE progress, reconnect and cancellation passed");
