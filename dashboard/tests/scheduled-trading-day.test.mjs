import { test } from "node:test";
import assert from "node:assert/strict";
import { startMarketBriefing } from "../worker/market-briefing-runner.ts";

function harness(payload, status = 200, alert = async () => new Response(null, { status: 202 })) {
  const requests = [], creations = [], alerts = [];
  return { requests, creations, alerts, env: {
    DATA: { fetch: async request => { requests.push(request); return Response.json(payload, { status }); } },
    MARKET_BRIEFING: { create: async options => { creations.push(options); return { id: options.id }; } },
    MESSENGER: { fetch: async request => { alerts.push({ url: request.url, body: await request.json() }); return alert(); } },
  } };
}
test("national-day closures are checked before creating any instance", async () => {
  const h = harness({ date: "2026-10-01", isTradingDay: false, previousTradingDate: "2026-09-30" });
  await startMarketBriefing(h.env, Date.parse("2026-10-01T09:00:00Z"));
  assert.equal(h.creations.length, 0); assert.equal(h.requests.length, 1);
});
test("future years use Choice rather than an outdated hardcoded calendar", async () => {
  const h = harness({ date: "2027-01-04", isTradingDay: true, previousTradingDate: "2026-12-31" });
  await startMarketBriefing(h.env, Date.parse("2027-01-04T09:00:00Z"));
  assert.deepEqual(h.creations, [{ id: "market-briefing-2027-01-04", params: { reportDate: "2027-01-04" } }]);
});
// 2026-10-12 is a Monday after the national-day closure, so the local table says it is open.
const OPEN_DAY = "2026-10-12", OPEN_DAY_TIME = Date.parse(`${OPEN_DAY}T09:00:00Z`);
for (const [payload, status] of [
  [{ date: "2026-10-11", isTradingDay: true, previousTradingDate: "2026-10-09" }, 200],
  [{ date: OPEN_DAY, isTradingDay: "false", previousTradingDate: "2026-10-09" }, 200],
  [{ date: OPEN_DAY, isTradingDay: true, previousTradingDate: OPEN_DAY }, 200],
  [{ date: OPEN_DAY, isTradingDay: true, previousTradingDate: "" }, 200],
  [{ date: OPEN_DAY, isTradingDay: true, previousTradingDate: "2026-02-30" }, 200],
  [{}, 503],
]) test(`calendar failure on a known trading day starts the workflow and alerts: ${JSON.stringify(payload)}/${status}`, async () => {
  const h = harness(payload, status);
  await startMarketBriefing(h.env, OPEN_DAY_TIME);
  assert.deepEqual(h.creations, [{ id: `market-briefing-${OPEN_DAY}`, params: { reportDate: OPEN_DAY } }]);
  assert.equal(h.alerts.length, 1);
  assert.equal(h.alerts[0].url, "https://messenger.internal/messages");
  assert.deepEqual({ ...h.alerts[0].body, text: undefined }, { source: "market-briefing", idempotencyKey: `calendar-unavailable/${OPEN_DAY}`, channel: "telegram", text: undefined });
  assert.match(h.alerts[0].body.text, /将启动工作流/);
});
test("calendar failure on a known closure skips quietly except for the alert", async () => {
  const h = harness({}, 503);
  await startMarketBriefing(h.env, Date.parse("2026-10-01T09:00:00Z"));
  assert.equal(h.creations.length, 0);
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0].body.text, /休市，未启动/);
});
test("calendar failure in a year the local table does not cover fails and asks for a manual run", async () => {
  const h = harness({}, 503);
  await assert.rejects(startMarketBriefing(h.env, Date.parse("2027-01-04T09:00:00Z")));
  assert.equal(h.creations.length, 0);
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0].body.text, /人工触发/);
});
test("an unknown year still rethrows the original calendar error when the alert also fails", async () => {
  const h = harness({}, 503, async () => { throw new Error("alert down"); });
  await assert.rejects(startMarketBriefing(h.env, Date.parse("2027-01-04T09:00:00Z")), /Trading calendar HTTP 503/);
  assert.equal(h.creations.length, 0);
});
test("a hanging alert is aborted and the scheduled decision still runs", async () => {
  const h = harness({}, 503);
  h.env.MESSENGER = { fetch: request => new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted")))) };
  const { scheduledTradingDay } = await import("../src/lib/server/scheduled-trading-day.ts");
  assert.equal(await scheduledTradingDay(h.env, OPEN_DAY, 20), true);
});
test("a missing messenger binding does not change the decision", async () => {
  const h = harness({}, 503);
  delete h.env.MESSENGER;
  await startMarketBriefing(h.env, OPEN_DAY_TIME);
  assert.equal(h.creations.length, 1);
});
for (const alert of [async () => new Response(null, { status: 500 }), async () => { throw new Error("down"); }]) {
  test("a failing alert never changes the scheduled decision", async () => {
    const h = harness({}, 503, alert);
    await startMarketBriefing(h.env, OPEN_DAY_TIME);
    assert.equal(h.creations.length, 1);
  });
}
test("a healthy calendar sends no alert", async () => {
  const h = harness({ date: OPEN_DAY, isTradingDay: true, previousTradingDate: "2026-10-09" });
  await startMarketBriefing(h.env, OPEN_DAY_TIME);
  assert.equal(h.creations.length, 1); assert.equal(h.alerts.length, 0);
});
test("makeup Saturday remains closed without querying Choice", async () => {
  const h = harness({});
  await startMarketBriefing(h.env, Date.parse("2026-10-10T09:00:00Z"));
  assert.equal(h.requests.length, 0); assert.equal(h.creations.length, 0);
});
