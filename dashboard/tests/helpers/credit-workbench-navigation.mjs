import assert from "node:assert/strict";
import { installDom, loadComponent } from "./svelte-dom.mjs";

const window = installDom();
const { mount, unmount, flushSync, tick } = await import("svelte");
const {PERMISSION_CODES}=await import('../../src/lib/permissions.ts');
const {createClientSession}=await import('../../src/lib/client-session.ts');
const session=createClientSession({user:{id:'auth0|test',email:'test@18.cn'},account:{name:'测试人员',department:'资金管理部'},_roles:['admin'],role:'admin',picture:'',permissions:[...PERMISSION_CODES],expiresAt:Date.now()/1000+3600});
const context=new Map([['site-session',session]]);
let reportRequests = 0;
globalThis.domAfterNavigations = [];
globalThis.fetch = async url => {
  if (String(url) === "/auth/session") return Response.json({ user: null, account: null });
  if (String(url).startsWith("/api/credit-assistant/")) return Response.json({ turns: [], running: false, progress: "", error: null, startedAt: 0 });
  reportRequests++;
  return Response.json({ error: "尚未装载报表" }, { status: 503 });
};
const Host = await loadComponent("tests/helpers/CreditWorkspaceHost.svelte", `<script>
  import CreditWorkbenchPage from "../../src/lib/credit-workbench/CreditWorkbenchPage.svelte";
  import WorkbenchShell from "../../src/lib/workbench/WorkbenchShell.svelte";
  import { createAiClient, provideAiClient } from "../../src/lib/ai-client.svelte";
  provideAiClient(createAiClient());
  let view = $state("overview");
  let workspace = $state("credit");
  export function navigate(next) { view = next; }
  export function openWorkspace(next) { workspace = next; }
</script>
{#if workspace === "credit"}<CreditWorkbenchPage viewId={view} />
{:else}<WorkbenchShell title="交易研究工作台" homeHref="/trading-research" activeViewId="overview"
  views={[{id:"overview",label:"总览",icon:"overview",href:"/trading-research"}]}><p>交易研究内容</p></WorkbenchShell>{/if}`);
const app = mount(Host, { context, target: document.body });
flushSync();
const overviewNavigation = globalThis.domAfterNavigations[0];
const afterNavigation = globalThis.domAfterNavigations[1];
assert.equal(typeof afterNavigation, 'function');
const workspace = document.querySelector('.tr-workspace');
let scrollResets = 0;
workspace.scrollTo = () => { scrollResets++; };
assert.doesNotThrow(() => afterNavigation({ from: { url: null }, to: { url: null }, type: 'enter' }));
afterNavigation({ from: { url: null }, to: { url: new URL('http://localhost/credit-workbench/calendar') }, type: 'goto' });
assert.equal(scrollResets, 1, 'a resolved navigation resets the business scroller even when its source URL is unavailable');
afterNavigation({ from: { url: null }, to: { url: new URL('http://localhost/credit-workbench') }, type: 'popstate' });
assert.equal(scrollResets, 1, 'history navigation preserves scroll position');
assert.equal(document.querySelector(".tr-breadcrumb a").textContent, "授信工作台");
assert.deepEqual([...document.querySelectorAll(".tr-drawer__nav a")].map(a => [a.textContent.trim(), a.getAttribute("href")]), [
  ["授信总览", "/credit-workbench"], ["授信一览表", "/credit-workbench/ledger"], ["授信日历", "/credit-workbench/calendar"],
  ["授信周报", "/credit-workbench/weekly"],
]);
assert.equal(document.querySelector("h1").textContent, "授信总览");
assert.deepEqual([...document.querySelectorAll('.page-header__tabs a')].map(a => a.textContent.trim()), ['仪表盘', '银行授信情况']);
flushSync(() => overviewNavigation({ to: { url: new URL('http://localhost/credit-workbench?tab=bank-credit') } }));
assert.ok(document.querySelector('a[href="/credit-workbench?tab=bank-credit"]').getAttribute('aria-current'));
flushSync(() => overviewNavigation({ to: { url: new URL('http://localhost/credit-workbench') } }));
assert.equal(document.querySelector("main").classList.contains("tr-chat-page"), false);
flushSync(() => app.navigate("calendar"));
const reportView = document.querySelector(".tr-credit-view");
assert.ok(reportView);
assert.equal(document.querySelector(".credit-chat"), null);
assert.equal(document.querySelector(".chat-toolbar"), null);
assert.equal(document.querySelector("h1").textContent, "授信日历");
assert.equal(document.querySelector("main").classList.contains("tr-chat-page"), false);
assert.equal(document.querySelectorAll("#tr-topbar-actions .tr-credit-toolbar").length, 1);
for (const [view, label] of [["weekly", "授信周报"], ["ledger", "授信一览表"], ["overview", "授信总览"]]) {
  flushSync(() => app.navigate(view));
  assert.equal(document.querySelector(".tr-credit-view"), reportView, "report tabs must preserve their loaded data and editor instance");
  assert.equal(document.querySelector("h1").textContent, label);
  assert.equal(document.querySelector('.tr-shell').classList.contains('tr-shell--workspace'), view !== 'weekly', 'approved reports opt out of workspace refinements');
  assert.equal(document.querySelectorAll("#tr-topbar-actions .tr-credit-toolbar").length, 1);
}
await tick();
assert.equal(reportRequests, 1);
flushSync(() => app.openWorkspace("trading"));
assert.equal(document.querySelectorAll(".tr-workbench").length, 1);
assert.equal(document.querySelectorAll(".credit-chat, .chat-toolbar").length, 0);
flushSync(() => app.openWorkspace("credit"));
assert.equal(document.querySelectorAll("#tr-topbar-actions").length, 1);
assert.equal(document.querySelectorAll("#tr-topbar-actions .tr-credit-toolbar").length, 1);
assert.equal(document.querySelectorAll(".credit-chat").length, 0);
await unmount(app);
await tick();
assert.equal(document.querySelectorAll(".tr-workbench, .chat-toolbar, .tr-credit-toolbar").length, 0);

// Exercise same-instance tab/date navigation with the actual report builder.
const { creditFull } = await import('../visual/audit-fixtures.mjs');
const { creditDataFixture } = await import('./credit-data-fixture.mjs');
globalThis.domAfterNavigations = [];
window.location.href = 'http://localhost/credit-workbench?tab=bank-credit&date=2026-06-30';
reportRequests = 0;
globalThis.fetch = async url => {
  reportRequests++;
  const date = new URL(url, window.location.href).searchParams.get('date') || '2026-06-30';
  const report = structuredClone(creditFull);
  report.summary.reportDate = date;
  report.previousDate = null;
  report.weeklyNews = report.recentApprovals = [];
  report.availableDates = ['2026-06-30', '2026-09-30'];
  report.institutions.forEach(row => { row.expiryDate = '2027-12-31'; });
  return Response.json(creditDataFixture(report));
};
const loadedApp = mount(Host, { context, target: document.body });
flushSync();
function navigateOverview(url) {
  window.history.pushState({}, '', url);
  const event = { to: { url: new URL(url) } };
  flushSync(() => { for (const callback of globalThis.domAfterNavigations) callback(event); });
}
async function waitForReport(date) {
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    flushSync();
    if (document.querySelector(`[aria-label="报告日：${date}"]`)) return;
  }
  assert.fail(`report did not load ${date}`);
}
await waitForReport('2026-06-30');
navigateOverview(window.location.href);
const reportInstance = document.querySelector('.tr-credit-view');
assert.ok(document.querySelector('table[aria-label="银行性质汇总"]'));
assert.equal(reportRequests, 1);
navigateOverview('http://localhost/credit-workbench?date=2026-06-30');
assert.equal(document.querySelector('table[aria-label="银行性质汇总"]'), null);
assert.equal(reportRequests, 1, 'tab-only navigation reuses the report');
navigateOverview('http://localhost/credit-workbench?tab=bank-credit&date=2026-09-30');
await waitForReport('2026-09-30');
assert.ok(document.body.textContent.includes('数据时点：2026-09-30'));
assert.equal(reportRequests, 2);
navigateOverview('http://localhost/credit-workbench?tab=bank-credit&date=2026-06-30');
await waitForReport('2026-06-30');
assert.equal(document.querySelector('.tr-credit-view'), reportInstance);
assert.ok(document.body.textContent.includes('数据时点：2026-06-30'));
assert.equal(reportRequests, 3, 'history navigation to another date loads that date');
const normalFetch = globalThis.fetch;
let releaseLateResponse;
globalThis.fetch = async url => {
  if (String(url).includes('2026-09-30')) await new Promise(resolve => { releaseLateResponse = resolve; });
  return normalFetch(url);
};
navigateOverview('http://localhost/credit-workbench?tab=bank-credit&date=2026-09-30');
assert.equal(typeof releaseLateResponse, 'function');
navigateOverview('http://localhost/credit-workbench?tab=bank-credit&date=2026-06-30');
await waitForReport('2026-06-30');
releaseLateResponse();
await new Promise(resolve => setTimeout(resolve, 30));
flushSync();
assert.ok(document.body.textContent.includes('数据时点：2026-06-30'), 'late responses cannot undo history navigation');
assert.equal(new URL(window.location.href).searchParams.get('date'), '2026-06-30');
globalThis.fetch = async url => {
  if (String(url).includes('2026-09-30')) {
    await new Promise(resolve => { releaseLateResponse = resolve; });
    return Response.json({ error: '旧日期请求失败' }, { status: 503 });
  }
  return normalFetch(url);
};
navigateOverview('http://localhost/credit-workbench?tab=bank-credit&date=2026-09-30');
navigateOverview('http://localhost/credit-workbench?tab=bank-credit&date=2026-06-30');
await waitForReport('2026-06-30');
releaseLateResponse();
await new Promise(resolve => setTimeout(resolve, 30));
flushSync();
assert.ok(document.body.textContent.includes('数据时点：2026-06-30'), 'late failures cannot replace the current report');
assert.equal(document.querySelector('[role="alert"]'), null);
await unmount(loadedApp);

globalThis.domNavigations = [];
window.location.href = "http://localhost/policy-tracking?category=monetary#policy-existing";
const Redirect = await loadComponent("src/lib/pages/LegacyWorkbenchRedirect.svelte");
const redirect = mount(Redirect, { target: document.body, props: { to: "/trading-research/policy-tracking" } });
flushSync();
assert.deepEqual(globalThis.domNavigations, [{ url: "/trading-research/policy-tracking?category=monetary#policy-existing", options: { replaceState: true } }]);
await unmount(redirect);

const { load: loadCredit } = await import("../../src/routes/credit-workbench/[[view]]/+page.ts");
const { load: loadTrading } = await import("../../src/routes/trading-research/[view]/+page.ts");
const { workbenchViews } = await import("../../src/lib/trading-research/demo-data.ts");
const { load: loadOldAssistant } = await import("../../src/routes/credit-assistant/+page.ts");
const url = new URL("http://localhost/trading-research/credit?date=2026-09-04");
for (const view of [undefined, "ledger", "calendar", "weekly"]) {
  assert.deepEqual(loadCredit({ params: { view }, url }), { view: view ?? "overview" });
}
assert.throws(() => loadCredit({ params: { view: "assistant" }, url }), error => error.status === 307 && error.location === "/?ai=open");
for (const view of workbenchViews.filter(v => v.id !== "overview")) {
  assert.deepEqual(loadTrading({ params: { view: view.id }, url }), { view: view.id });
}
assert.throws(() => loadTrading({ params: { view: "credit" }, url }), error => error.status === 307 && error.location === "/credit-workbench?date=2026-09-04");
assert.throws(() => loadTrading({ params: { view: "credit-assistant" }, url }), error => error.status === 307 && error.location === "/?ai=open");
assert.throws(() => loadOldAssistant(), error => error.status === 307 && error.location === "/?ai=open");
assert.throws(() => loadCredit({ params: { view: "missing" }, url }), error => error.status === 404);
assert.throws(() => loadTrading({ params: { view: "missing" }, url }), error => error.status === 404);
await window.happyDOM.abort();
console.log("Shared shell, credit route transitions, state preservation and legacy anchors passed");
