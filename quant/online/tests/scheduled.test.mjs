import assert from "node:assert/strict";
import { test } from "node:test";
import { startScheduledInference } from "../scheduled.ts";

function harness(payload = { date: "2026-09-30", isTradingDay: true, previousTradingDate: "2026-09-29" }, status = 200) {
  const requests = [], created = [];
  return { requests, created, env: {
    DATA: { fetch: async request => { requests.push(request); return Response.json(payload, { status }); } },
    INFERENCE: { create: async options => { created.push(options); return { id: options.id }; } },
  } };
}
test("delayed Cron uses its scheduled Shanghai date and stable ID", async () => {
  const h = harness();
  await startScheduledInference(h.env, Date.parse("2026-09-30T00:30:00Z"));
  assert.deepEqual(h.created, [{ id: "bond-2026-09-30", params: { as_of_date: "2026-09-30" } }]);
  assert.equal(new URL(h.requests[0].url).searchParams.get("date"), "2026-09-30");
});
test("holidays and makeup weekends do not create instances", async () => {
  const h = harness({ date: "2026-10-01", isTradingDay: false, previousTradingDate: "2026-09-30" });
  await startScheduledInference(h.env, Date.parse("2026-10-01T00:30:00Z"));
  await startScheduledInference(h.env, Date.parse("2026-10-10T00:30:00Z"));
  assert.equal(h.requests.length, 1); assert.equal(h.created.length, 0);
});
for (const [payload, status] of [
  [{ date: "2026-09-29", isTradingDay: true, previousTradingDate: "2026-09-28" }, 200],
  [{ date: "2026-09-30", isTradingDay: "true", previousTradingDate: "2026-09-29" }, 200],
  [{ date: "2026-09-30", isTradingDay: true, previousTradingDate: "2026-09-30" }, 200],
  [{}, 503],
]) test(`calendar errors stop dispatch: ${JSON.stringify(payload)}/${status}`, async () => {
  const h = harness(payload, status);
  await assert.rejects(startScheduledInference(h.env, Date.parse("2026-09-30T00:30:00Z")));
  assert.equal(h.created.length, 0);
});
test("duplicate deliveries confirm an existing instance; missing instances still fail", async () => {
  const h = harness(); const instance = { status: async () => ({ status: "running" }) };
  h.env.INFERENCE.create = async () => { throw new Error("create failed"); };
  h.env.INFERENCE.get = async id => { assert.equal(id, "bond-2026-09-30"); return instance; };
  assert.equal(await startScheduledInference(h.env, Date.parse("2026-09-30T00:30:00Z")), instance);
  instance.status = async () => { throw new Error("not found"); };
  await assert.rejects(startScheduledInference(h.env, Date.parse("2026-09-30T00:30:00Z")), /create failed/);
});
