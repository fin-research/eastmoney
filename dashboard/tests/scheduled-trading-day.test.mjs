import { test } from "node:test";
import assert from "node:assert/strict";
import { startMarketBriefing } from "../worker/market-briefing-runner.ts";

function harness(payload, status = 200) {
  const requests = [], creations = [];
  return { requests, creations, env: {
    DATA: { fetch: async request => { requests.push(request); return Response.json(payload, { status }); } },
    MARKET_BRIEFING: { create: async options => { creations.push(options); return { id: options.id }; } },
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
for (const [payload, status] of [
  [{ date: "2026-09-30", isTradingDay: true, previousTradingDate: "2026-09-29" }, 200],
  [{ date: "2026-10-01", isTradingDay: "false", previousTradingDate: "2026-09-30" }, 200],
  [{ date: "2026-10-01", isTradingDay: true, previousTradingDate: "2026-10-01" }, 200],
  [{ date: "2026-10-01", isTradingDay: true, previousTradingDate: "" }, 200],
  [{ date: "2026-10-01", isTradingDay: true, previousTradingDate: "2026-02-30" }, 200],
  [{}, 503],
]) test(`calendar failure does not create a workflow: ${JSON.stringify(payload)}/${status}`, async () => {
  const h = harness(payload, status);
  await assert.rejects(startMarketBriefing(h.env, Date.parse("2026-10-01T09:00:00Z")));
  assert.equal(h.creations.length, 0);
});
test("makeup Saturday remains closed without querying Choice", async () => {
  const h = harness({});
  await startMarketBriefing(h.env, Date.parse("2026-10-10T09:00:00Z"));
  assert.equal(h.requests.length, 0); assert.equal(h.creations.length, 0);
});
