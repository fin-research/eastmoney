import test from "node:test";
import assert from "node:assert/strict";
import { EconomicIndicatorDatabaseError, loadEconomicIndicators } from "../src/lib/server/economic-indicators-repository.ts";

test("经济指标仓储按指标和Choice发布日期返回近18个月数据", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      return {
        rowCount: 2,
        rows: [
          {
            code: "EMM00000012",
            date: "2026-06-30",
            value: 5.2,
            synced_at: "2026-08-28T08:00:00.000Z",
          },
          {
            code: "EMM00121996",
            date: "2026-07-31",
            value: 49.3,
            synced_at: "2026-08-28T08:00:00.000Z",
          },
        ],
      };
    },
  };

  const result = await loadEconomicIndicators(client);
  assert.equal(result.asOf, "2026-07-31");
  assert.equal(result.syncedAt, "2026-08-28T08:00:00.000Z");
  assert.deepEqual(result.rows[0], {
    code: "EMM00000012",
    date: "2026-06-30",
    value: 5.2,
  });
  assert.match(calls[0].sql, /published_date/);
  assert.match(calls[0].sql, /FROM public\.edb/);
  assert.match(calls[0].sql, /indicator_code = ANY\(\$1::text\[\]\)/);
  assert.match(calls[0].sql, /interval '18 months'/);
  assert.equal(calls[0].values[0].length, 44);
});

test("经济指标仓储空表返回明确404", async () => {
  const client = {
    async query() {
      return { rowCount: 0, rows: [] };
    },
  };
  await assert.rejects(
    () => loadEconomicIndicators(client),
    (error) =>
      error instanceof EconomicIndicatorDatabaseError && error.status === 404,
  );
});
