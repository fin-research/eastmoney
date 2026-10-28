import assert from "node:assert/strict";
import test from "node:test";

import {
  readCachedReport,
  reportHasDataForDate,
  resolveReportData,
  writeCachedReport,
} from "../src/report-cache.ts";

class MemoryStorage {
  #values = new Map();

  get length() {
    return this.#values.size;
  }

  getItem(key) {
    return this.#values.get(key) ?? null;
  }

  key(index) {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key) {
    this.#values.delete(key);
  }

  setItem(key, value) {
    this.#values.set(key, value);
  }
}

function report(reportDate, dataDate = reportDate) {
  return {
    report_date: reportDate,
    generated_at: `${reportDate}T15:00:00+08:00`,
    omo: [],
    rates: { dr: [], dibo: [], bonds: [], futures: [] },
    stock_paragraphs: [],
    margin: [],
    equities: [],
    equity_data_time: null,
    turnover_yi: null,
    turnover_change_yi: null,
    industries: [],
    industry_data_date: dataDate,
    primary_summary: { current_amount: 0, change_amount: null },
    primary: [],
    secondary: [],
    inventory: [],
  };
}

test("报告按日期写入前端缓存并可直接读取", () => {
  const storage = new MemoryStorage();
  const cached = report("2026-08-20");

  writeCachedReport(storage, cached);

  assert.deepEqual(readCachedReport(storage, "2026-08-20"), cached);
  assert.equal(readCachedReport(storage, "2026-08-19"), null);
});

test("报告缓存只保留最近两个日期", () => {
  const storage = new MemoryStorage();
  writeCachedReport(storage, report("2026-08-18"));
  writeCachedReport(storage, report("2026-08-19"));
  writeCachedReport(storage, report("2026-08-20"));

  assert.equal(readCachedReport(storage, "2026-08-18"), null);
  assert.deepEqual(
    readCachedReport(storage, "2026-08-19"),
    report("2026-08-19"),
  );
  assert.deepEqual(
    readCachedReport(storage, "2026-08-20"),
    report("2026-08-20"),
  );
});

test("损坏的报告缓存被清除并按未命中处理", () => {
  const storage = new MemoryStorage();
  storage.setItem("dm-market-report:data:v1:2026-08-20", "{bad-json");

  assert.equal(readCachedReport(storage, "2026-08-20"), null);
  assert.equal(storage.length, 0);
});

test("报告日期与实际行情日期一致时才视为当天数据", () => {
  assert.equal(
    reportHasDataForDate(report("2026-08-26"), "2026-08-26"),
    true,
  );
  assert.equal(
    reportHasDataForDate(
      report("2026-08-26", "2026-08-25"),
      "2026-08-26",
    ),
    false,
  );
});

test("当天缓存的实际行情也是当天时直接读取缓存", async () => {
  const storage = new MemoryStorage();
  const cached = report("2026-08-26");
  const calls = [];
  writeCachedReport(storage, cached);

  const resolved = await resolveReportData(
    storage,
    "2026-08-26",
    "2026-08-26",
    false,
    async (reportDate, refresh) => {
      calls.push({ reportDate, refresh });
      return report(reportDate);
    },
  );

  assert.deepEqual(resolved, cached);
  assert.deepEqual(calls, []);
});

test("当天缓存仍是旧行情时自动强制刷新并覆盖缓存", async () => {
  const storage = new MemoryStorage();
  const refreshed = report("2026-08-26");
  const calls = [];
  writeCachedReport(storage, report("2026-08-26", "2026-08-25"));

  const resolved = await resolveReportData(
    storage,
    "2026-08-26",
    "2026-08-26",
    false,
    async (reportDate, refresh) => {
      calls.push({ reportDate, refresh });
      return refreshed;
    },
  );

  assert.deepEqual(resolved, refreshed);
  assert.deepEqual(calls, [{ reportDate: "2026-08-26", refresh: true }]);
  assert.deepEqual(readCachedReport(storage, "2026-08-26"), refreshed);
});

test("当天无前端缓存但后端已返回当天行情时不重复刷新", async () => {
  const storage = new MemoryStorage();
  const current = report("2026-08-26");
  const calls = [];

  const resolved = await resolveReportData(
    storage,
    "2026-08-26",
    "2026-08-26",
    false,
    async (reportDate, refresh) => {
      calls.push({ reportDate, refresh });
      return current;
    },
  );

  assert.deepEqual(resolved, current);
  assert.deepEqual(calls, [{ reportDate: "2026-08-26", refresh: false }]);
  assert.deepEqual(readCachedReport(storage, "2026-08-26"), current);
});

test("后端普通缓存仍是旧行情时自动追加一次强制刷新", async () => {
  const storage = new MemoryStorage();
  const calls = [];

  const resolved = await resolveReportData(
    storage,
    "2026-08-26",
    "2026-08-26",
    false,
    async (reportDate, refresh) => {
      calls.push({ reportDate, refresh });
      return refresh
        ? report(reportDate)
        : report(reportDate, "2026-08-25");
    },
  );

  assert.deepEqual(resolved, report("2026-08-26"));
  assert.deepEqual(calls, [
    { reportDate: "2026-08-26", refresh: false },
    { reportDate: "2026-08-26", refresh: true },
  ]);
});

test("历史日期继续直接读取对应日期缓存", async () => {
  const storage = new MemoryStorage();
  const cached = report("2026-08-23", "2026-08-21");
  let calls = 0;
  writeCachedReport(storage, cached);

  const resolved = await resolveReportData(
    storage,
    "2026-08-23",
    "2026-08-26",
    false,
    async (reportDate) => {
      calls += 1;
      return report(reportDate);
    },
  );

  assert.deepEqual(resolved, cached);
  assert.equal(calls, 0);
});
