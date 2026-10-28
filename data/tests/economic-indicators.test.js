import { test } from "vitest";
import assert from "node:assert/strict";
import { persistEconomicIndicators } from "../src/sync/economic-indicators-repository.ts";
import { fetchChoiceEconomicIndicatorRows, fetchDmFundingRateRows } from "../src/sync/economic-indicator-sync.ts";
test("增量同步在单事务和 advisory lock 内只做 upsert", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rowCount: sql.includes("INSERT INTO public.edb") ? 2 : null, rows: [] };
    },
  };
  const result = await persistEconomicIndicators(client, [
    {
      code: "EMM00000012",
      observationDate: "2026-06-01",
      date: "2026-07-15",
      value: 5.2,
    },
    {
      code: "EMM00121996",
      observationDate: "2026-07-01",
      date: "2026-07-31",
      value: 49.3,
    },
  ]);
  assert.deepEqual(result, { rowCount: 2, asOf: "2026-07-31" });
  assert.equal(calls[0].sql, "BEGIN");
  assert.match(calls[1].sql, /pg_advisory_xact_lock/);
  assert.doesNotMatch(calls.map((call) => call.sql).join("\n"), /DELETE FROM public\.edb/);
  assert.match(calls[2].sql, /ON CONFLICT \(indicator_code, observation_date\)/);
  assert.match(calls[2].sql, /published_date = EXCLUDED\.published_date/);
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("全量同步只替换目标指标并保留表内其他数据", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rowCount: sql.includes("INSERT INTO public.edb") ? 1 : null, rows: [] };
    },
  };
  await persistEconomicIndicators(
    client,
    [{
      code: "E1000172",
      observationDate: "2026-08-31",
      date: "2026-08-31",
      value: 1.2232,
    }],
    { replaceCodes: ["E1000172"] },
  );
  assert.match(calls[2].sql, /DELETE FROM public\.edb WHERE indicator_code = ANY/);
  assert.deepEqual(calls[2].values, [["E1000172"]]);
  assert.match(calls[3].sql, /INSERT INTO public\.edb/);
});

test("增量 Choice 同步按回看窗口和代码族拆批并排除 DM 资金利率", async () => {
  const requests = [];
  const result = await fetchChoiceEconomicIndicatorRows(
    async (path, searchParams) => {
      requests.push({ path, searchParams: new URLSearchParams(searchParams) });
      const codes = searchParams.get("edbIds").split(",");
      const rows = [];
      if (codes.includes("E1715081")) {
        rows.push({ code: "E1715081", date: "2026-08-31", RESULT: 1.4 });
      }
      if (codes.includes("EMM00121996")) {
        rows.push({
          code: "EMM00121996",
          date: "2026-08-01",
          PUBLISHDATE: "20260831",
          RESULT: 49.3,
        });
      }
      return { function: "EDB", fields: ["code", "date", "RESULT"], rows };
    },
    "incremental",
    new Date("2026-08-31T16:00:00.000Z"),
  );
  assert.ok(requests.length > 3);
  assert.ok(requests.every((request) => request.path === "/choice/edb"));
  assert.ok(requests.every((request) => request.searchParams.get("options") === "IsPublishDate=1,FixDate=0"));
  assert.ok(requests.every((request) => request.searchParams.get("edbIds").split(",").length <= 8));
  assert.ok(requests.every((request) => !request.searchParams.get("edbIds").includes("E1300003")));
  assert.ok(requests.every((request) => {
    const codes = request.searchParams.get("edbIds").split(",");
    return !(
      codes.some((code) => /^E\d/.test(code)) &&
      codes.some((code) => /^EM[A-Z]\d/.test(code))
    );
  }));
  const liabilityRateRequest = requests.find((request) => request.searchParams.get("edbIds").includes("E1707781"));
  const overseasMacroRequest = requests.find((request) => request.searchParams.get("edbIds").includes("EMG00152118"));
  assert.equal(liabilityRateRequest.searchParams.get("startDate"), "2025-07-28");
  assert.equal(overseasMacroRequest.searchParams.get("startDate"), "2025-07-28");
  assert.notEqual(liabilityRateRequest, overseasMacroRequest);
  assert.equal(result.range.endDate, "2026-09-01");
  assert.equal(result.rows.find((row) => row.code === "E1715081").date, "2026-08-31");
});

test("Choice 同步仅剔除已确认的国有行同业存单异常源值并允许同日修正值入库", async () => {
  const result = await fetchChoiceEconomicIndicatorRows(
    async (_path, searchParams) => {
      if (!searchParams.get("edbIds").split(",").includes("E1704281")) {
        return { function: "EDB", fields: ["code", "date", "RESULT"], rows: [] };
      }
      return {
        function: "EDB",
        fields: ["code", "date", "RESULT"],
        rows: [
          { code: "E1704281", date: "2026-03-05", RESULT: 1.5 },
          { code: "E1704281", date: "2026-03-06", RESULT: 2.575 },
          { code: "E1704281", date: "2026-04-03", RESULT: 3.75 },
          { code: "E1704281", date: "2026-04-15", RESULT: 2.575 },
          { code: "E1704281", date: "2026-04-15", RESULT: 1.415 },
        ],
      };
    },
    "incremental",
    new Date("2026-09-03T00:00:00.000Z"),
  );

  assert.deepEqual(
    result.rows.filter((row) => row.code === "E1704281"),
    [
      { code: "E1704281", observationDate: "2026-03-05", date: "2026-03-05", value: 1.5 },
      { code: "E1704281", observationDate: "2026-04-15", date: "2026-04-15", value: 1.415 },
    ],
  );
});

test("DM 历史资金利率映射为 EDB 指标代码并以北京时间落日", async () => {
  const result = await fetchDmFundingRateRows(
    async (_path, searchParams) => ({
      hasNextPage: false,
      rows: [{
        bondCode: searchParams.get("bondCode"),
        capitalTime: Date.parse("2026-08-31T08:00:00.000Z"),
        weightedYield: 1.42,
      }],
    }),
    "incremental",
    new Date("2026-08-31T16:00:00.000Z"),
  );
  assert.equal(result.pageCount, 6);
  assert.deepEqual(
    result.rows.map((row) => row.code),
    ["E1300003", "E1300004", "E1704420"],
  );
  assert.ok(result.rows.every((row) => row.date === "2026-08-31"));
});

test('2019 macro releases use verified PBC dates and never observation dates', async () => {
  const { HISTORICAL_RELEASE_EVIDENCE } = await import('../src/sync/economic-release-evidence.ts');
  const { normalizeChoiceEconomicIndicatorRows } = await import('../src/sync/economic-indicator-sync.ts');
  assert.equal(HISTORICAL_RELEASE_EVIDENCE.length, 24);
  const raw = HISTORICAL_RELEASE_EVIDENCE.map(row => ({code: row.indicator_code, date: row.observation_date, RESULT: 1, PUBLISHDATE: null}));
  const normalized = normalizeChoiceEconomicIndicatorRows(raw, '2020-01-16');
  assert.equal(normalized.length, 24);
  for (const row of normalized) {
    const evidence = HISTORICAL_RELEASE_EVIDENCE.find(x => x.indicator_code === row.code && x.observation_date === row.observationDate);
    assert.equal(row.date, evidence.published_date);
    assert.ok(row.date > row.observationDate);
    assert.equal(new URL(evidence.source_url).hostname, 'www.pbc.gov.cn');
  }
  assert.equal(normalizeChoiceEconomicIndicatorRows(raw, '2019-02-14').length, 0);
  assert.equal(normalizeChoiceEconomicIndicatorRows([{code: 'EMM00087086',date:'2018-12-01',RESULT:1}], '2020-01-16').length, 0);
});
