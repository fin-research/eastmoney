import assert from "node:assert/strict";
import { installDom, loadComponent } from "./svelte-dom.mjs";

const window = installDom();
const { mount, unmount, flushSync } = await import("svelte");
const Assistant = await loadComponent("tests/helpers/CreditChatBasicHost.svelte", `<script>
  import CreditAssistantView from "../../src/lib/credit-assistant/CreditAssistantView.svelte";
  import { createAiClient, provideAiClient } from "../../src/lib/ai-client.svelte";
  provideAiClient(createAiClient());
</script><CreditAssistantView />`);
const empty = { turns: [], running: false, progress: "", error: null, startedAt: 0 };
const requests = [];
globalThis.fetch = (url, options) => new Promise(resolve => requests.push({ url: String(url), options, resolve }));
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); flushSync(); };
const sseResult = value => new Response(`event: result\ndata: ${JSON.stringify(value)}\n\n`, { headers: { "content-type": "text/event-stream" } });

const app = mount(Assistant, { target: document.body });
flushSync();
assert.equal(requests.length, 1);
assert.match(requests[0].url, /\/api\/credit-assistant\/session$/);
assert.equal(document.querySelector("#credit-customer"), null);
const input = document.querySelector("#credit-question");
flushSync(() => { input.value = "保留我的草稿"; input.dispatchEvent(new Event("input", { bubbles: true })); });
assert.equal(document.querySelector(".chat-button--send").disabled, false, "history loading must not block sending");
flushSync(() => document.querySelector(".chat-composer").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
assert.equal(requests.length, 2);
assert.deepEqual(JSON.parse(requests[1].options.body), { question: "保留我的草稿" });
assert.equal(requests[0].options.signal.aborted, true);
requests[1].resolve(sseResult({ ...empty, error: "测试任务结束" }));
requests[0].resolve(Response.json({ ...empty, error: "迟到历史不得覆盖答复" }));
await settle();
assert.match(document.querySelector(".answer-error").textContent, /测试任务结束/);
assert.equal(document.body.textContent.includes("迟到历史不得覆盖答复"), false);
await unmount(app);
await window.happyDOM.abort();
console.log("Ordinary credit chat accepts a question during history loading and ignores stale responses");
