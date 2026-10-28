import assert from "node:assert/strict";
import { installDom, loadComponent } from "./svelte-dom.mjs";

const window = installDom();
const { mount, unmount, flushSync, tick } = await import("svelte");
const pending = [];
globalThis.fetch = async (_url, init) => {
  assert.ok(!init?.method || init.method === "GET", "opening a research page must not generate AI output");
  return new Promise(resolve => pending.push(() => resolve(Response.json({ error: "测试请求结束" }, { status: 503 }))));
};
const Host = await loadComponent("tests/helpers/ResearchHost.svelte", `<script>
  import MarketHotspotsPage from "../../src/lib/pages/MarketHotspotsPage.svelte";
  import PolicyTrackingPage from "../../src/lib/pages/PolicyTrackingPage.svelte";
  import { createAiClient, provideAiClient } from "../../src/lib/ai-client.svelte";
  provideAiClient(createAiClient());
  let view = $state("hotspots");
  export function navigate(next) { view = next; }
</script>
<svelte:head><title>交易研究工作台</title></svelte:head>
<div class="tr-workbench"><header><h1>交易研究工作台</h1></header><main>
  {#if view === "hotspots"}<MarketHotspotsPage embedded />
  {:else if view === "policies"}<PolicyTrackingPage embedded />
  {:else}<section data-view="trading">交易管理</section>{/if}
</main></div>`);
const app = mount(Host, { target: document.body });
flushSync();
assert.equal(document.querySelectorAll("main").length, 1);
assert.equal(document.querySelectorAll("h1").length, 1);
assert.ok(document.querySelector(".hotspot-page--embedded"));
assert.equal(document.querySelector(".brand-block"), null);
assert.equal(document.title, "交易研究工作台");
flushSync(() => app.navigate("policies"));
assert.equal(document.querySelector(".hotspot-page"), null);
assert.ok(document.querySelector(".policy-page--embedded"));
assert.equal(document.querySelectorAll("main").length, 1);
assert.equal(document.querySelectorAll("h1").length, 1);
assert.equal(document.querySelector(".header-title"), null);
assert.equal(document.title, "交易研究工作台");
flushSync(() => app.navigate("trading"));
pending.splice(0).forEach(resolve => resolve());
await tick();
assert.equal(document.querySelectorAll(".policy-page, .hotspot-page, .modal-layer, .detail-panel").length, 0);
assert.ok(document.querySelector('[data-view="trading"]'));
await unmount(app);
await window.happyDOM.abort();
console.log("Embedded research pages preserve shell ownership and clean up on navigation");
