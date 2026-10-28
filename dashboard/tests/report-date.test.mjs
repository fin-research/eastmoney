import assert from "node:assert/strict";
import test from "node:test";

import {
  currentReportDate,
  shouldWarnUnfinalizedReport,
} from "../src/report-date.ts";

test("报告默认日期按上海时区取页面打开时的当天", () => {
  assert.equal(
    currentReportDate(new Date("2026-08-17T16:30:00.000Z")),
    "2026-08-18",
  );
});

test("只有历史日期无定稿时提示 warning", () => {
  assert.equal(
    shouldWarnUnfinalizedReport("2026-08-17", null, "2026-08-18"),
    true,
  );
  assert.equal(
    shouldWarnUnfinalizedReport("2026-08-18", null, "2026-08-18"),
    false,
  );
  assert.equal(
    shouldWarnUnfinalizedReport(
      "2026-08-17",
      "2026-08-17T16:00:00+08:00",
      "2026-08-18",
    ),
    false,
  );
});

test('默认选日按已核实的休市日回退，覆盖17点、周末及跨年', async () => {
  const { defaultReportDate } = await import('../src/lib/server/market-report-date.ts');
  for (const [now, expected] of [
    ['2026-09-17T16:59:59+08:00', '2026-09-16'],
    ['2026-09-17T17:00:00+08:00', '2026-09-17'],
    ['2026-09-14T08:00:00+08:00', '2026-09-11'],
    ['2026-09-19T09:00:00+08:00', '2026-09-18'],
    ['2026-09-19T18:00:00+08:00', '2026-09-18'],
    ['2026-09-20T09:00:00+08:00', '2026-09-18'],
    ['2026-09-20T18:00:00+08:00', '2026-09-18'],
    ['2026-05-06T09:00:00+08:00', '2026-04-30'],
    ['2026-09-28T09:00:00+08:00', '2026-09-24'],
    ['2026-10-08T09:00:00+08:00', '2026-09-30'],
    ['2026-10-12T09:00:00+08:00', '2026-10-09'],
    ['2026-01-01T09:00:00+08:00', '2025-12-31'],
    ['2027-01-04T09:00:00+08:00', '2027-01-01'],
    ['2027-01-05T09:00:00+08:00', '2027-01-04'],
    ['2028-03-01T09:00:00+08:00', '2028-02-29'],
  ]) {
    assert.equal(defaultReportDate(new Date(now)), expected, now);
  }
});
