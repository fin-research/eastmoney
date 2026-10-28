import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { parseBondLedgerMatrices } from "../src/lib/bond-ledger/parser.ts";
import { buildBondLedgerAnalytics, summarizePositionAvailability } from "../src/lib/bond-ledger/analytics.ts";
import { loadBondLedgerReport, persistParsedBondLedger } from "../src/lib/server/bond-ledger-repository.ts";

const headers = ["报表日期", "债券代码", "交易市场", "债券名称", "债券分类", "收益率变动(BP)", "剩余期限（年）", "到期日", "今日持仓量", "昨日持仓量", "当日买量", "当日卖量", "当日到期量", "今日质押量", "今日可用量", "票面利率", "今日估值收益率", "含免税报表收益率", "估值全价", "DV01", "全价市值", "当日损益", "全年损益", "全价成本", "账户"];

function matrices(date = "2026-09-09", includeAvailability = true) {
  const performanceHeaders = Array(47).fill(null);
  for (const [index, name] of [[0, "日期"], [2, "业务本金"], [9, "持仓规模"], [12, "杠杆率"], [19, "修正久期"]]) performanceHeaders[index] = name;
  const performance = Array(47).fill(0);
  for (const [index, value] of [[0, date], [2, 4000], [5, 4000], [9, 4200], [12, 1.05]]) performance[index] = value;
  const columns = includeAvailability ? headers : headers.filter(name => !["今日质押量", "今日可用量"].includes(name));
  const row = (account, quantity, pledged) => columns.map(name => ({
    报表日期: date, 债券代码: account === "财务资金-交易户" ? "260001.IB" : "220021.IB", 交易市场: "银行间", 债券名称: "测试债", 债券分类: "国债",
    今日持仓量: quantity, 今日质押量: pledged, 今日可用量: quantity - pledged,
    估值全价: 105, 全价市值: quantity * 105, 账户: account,
  })[name] ?? 0);
  return [[performanceHeaders, [], [], performance], [columns, row("财务资金-交易户", 30, 20)], [[columns, row("财务资金-可供户", 10, 5)]]];
}

test("新增列按表头解析两户，质押和可用按单券全价市值拆分", () => {
  const parsed = parseBondLedgerMatrices(...matrices());
  assert.equal(parsed.positions[0].fullPrice, 105);
  assert.equal(parsed.positions[0].pledgedQuantity, 20);
  assert.equal(parsed.positions[1].availableQuantity, 5);
  assert.deepEqual(summarizePositionAvailability(parsed.positions), {
    pledgedQuantity: 25, availableQuantity: 15, pledgedFaceAmount: 2500, availableFaceAmount: 1500,
    pledgedMarketValue: 2625, availableMarketValue: 1575,
  });
});

test("不同价格的债券和 ETF 使用各自市值，拆分后与全池市值守恒", () => {
  const { positions } = parseBondLedgerMatrices(...matrices());
  const holdings = [
    { ...positions[0], currentQuantity: 100, pledgedQuantity: 40, availableQuantity: 60, fullPrice: 108, marketValue: 10850 },
    { ...positions[1], currentQuantity: 100, pledgedQuantity: 80, availableQuantity: 20, fullPrice: 97, marketValue: 9750 },
    { ...positions[0], code: "511160.SH", category: "债券ETF", currentQuantity: 200, pledgedQuantity: 0, availableQuantity: 200, fullPrice: 0, marketValue: 20418 },
    { ...positions[0], currentQuantity: 0, pledgedQuantity: null, availableQuantity: null, marketValue: 0 },
  ];
  const result = summarizePositionAvailability(holdings);
  assert.equal(result.pledgedMarketValue, 12140);
  assert.equal(result.availableMarketValue, 28878);
  assert.equal(result.pledgedMarketValue + result.availableMarketValue, 41018);
});

test("有市值但持仓数量为零时不可拆分，全池市值汇总保持缺失", () => {
  const { positions } = parseBondLedgerMatrices(...matrices());
  const result = summarizePositionAvailability([
    positions[0],
    { ...positions[1], currentQuantity: 0, pledgedQuantity: 0, availableQuantity: 0 },
  ]);
  assert.equal(result.pledgedMarketValue, null);
  assert.equal(result.availableMarketValue, null);
});

test("旧台账、部分账户缺列与历史区间保持缺失，明确填零仍为零", () => {
  const old = parseBondLedgerMatrices(...matrices("2026-09-08", false));
  const current = parseBondLedgerMatrices(...matrices());
  assert.equal(old.positions[0].pledgedQuantity, null);
  assert.equal(summarizePositionAvailability(old.positions).pledgedFaceAmount, null);
  assert.equal(summarizePositionAvailability([old.positions[0], current.positions[1]]).pledgedFaceAmount, null);
  assert.equal(buildBondLedgerAnalytics([old, current], "2026-09-08", "2026-09-08").availability.pledgedFaceAmount, null);
  assert.equal(buildBondLedgerAnalytics([old, current], "2026-09-08", "2026-09-09").availability.pledgedFaceAmount, 2500);
  assert.equal(summarizePositionAvailability(current.positions.map(row => ({ ...row, pledgedQuantity: 0, availableQuantity: row.currentQuantity }))).pledgedFaceAmount, 0);
  assert.equal(summarizePositionAvailability(old.positions).pledgedMarketValue, null);
  assert.equal(summarizePositionAvailability([old.positions[0], current.positions[1]]).availableMarketValue, null);
  assert.equal(buildBondLedgerAnalytics([old, current], "2026-09-08", "2026-09-08").availability.pledgedMarketValue, null);
  assert.equal(buildBondLedgerAnalytics([old, current], "2026-09-08", "2026-09-09").availability.pledgedMarketValue, 2625);
  const unpledged = summarizePositionAvailability(current.positions.map(row => ({ ...row, pledgedQuantity: 0, availableQuantity: row.currentQuantity })));
  assert.equal(unpledged.pledgedMarketValue, 0);
  assert.equal(unpledged.availableMarketValue, 4200);
});

test("拒绝缺少配对列、非数值、负数与数量不守恒的新增字段", () => {
  for (const [value, pattern] of [[null, /有效数值/], ["未填", /有效数值/], [-1, /不能为负数/], [21, /须等于今日持仓量/]]) {
    const input = matrices();
    input[1][1][headers.indexOf("今日质押量")] = value;
    assert.throws(() => parseBondLedgerMatrices(...input), pattern);
  }
  const input = matrices();
  input[1][0] = [...headers];
  input[1][0][headers.indexOf("今日可用量")] = "错误列";
  assert.throws(() => parseBondLedgerMatrices(...input), /须同时提供/);
});

test("迁移与同日重导保存新字段，重复工作流幂等，约束失败回滚且历史不变", async (t) => {
  const database = new PGlite();
  t.after(() => database.close());
  const client = {
    async query(sql, values) {
      // PGlite lacks cross-session advisory locks; lock ordering has a separate test.
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      const result = await database.query(sql, values);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  for (const name of ["0001_create_bond_schema.sql", "0002_describe_combined_position_accounts.sql", "0003_position_pledged_available_quantities.sql"]) {
    await database.exec(await readFile(new URL(`../postgres-migrations/${name}`, import.meta.url), "utf8"));
  }
  const upload = (parsed) => {
    const id = randomUUID();
    return { uploadId: id, workflowInstanceId: id, r2Key: `bond-ledger/.pending/${id}.xlsx`, r2Etag: null, originalName: "test.xlsx", fileSize: 100,
      expectedDate: parsed.date, uploadedAt: "2026-09-10T08:00:00Z", parsed };
  };
  await persistParsedBondLedger(client, upload(parseBondLedgerMatrices(...matrices("2026-09-08", false))));
  await persistParsedBondLedger(client, upload(parseBondLedgerMatrices(...matrices("2026-09-09", false))));
  const current = upload(parseBondLedgerMatrices(...matrices()));
  await persistParsedBondLedger(client, current);
  await persistParsedBondLedger(client, current);
  const report = await loadBondLedgerReport(client, "2026-01-01", "2026-09-09");
  assert.deepEqual(report.availability, { pledgedQuantity: 25, availableQuantity: 15, pledgedFaceAmount: 2500, availableFaceAmount: 1500, pledgedMarketValue: 2625, availableMarketValue: 1575 });
  assert.equal(report.availability.pledgedMarketValue + report.availability.availableMarketValue, report.detailMarketValue);
  assert.equal(report.auditPassed, true);
  assert.equal((await loadBondLedgerReport(client, "2026-09-08", "2026-09-08")).availability.pledgedFaceAmount, null);
  const counts = await database.query("SELECT status, count(*)::integer AS count FROM bond.ledger_upload WHERE report_date='2026-09-09' GROUP BY status ORDER BY status");
  assert.deepEqual(counts.rows, [{ status: "succeeded", count: 1 }, { status: "superseded", count: 1 }]);
  const invalid = upload(structuredClone(current.parsed));
  invalid.parsed.positions[0].availableQuantity = 999;
  await assert.rejects(persistParsedBondLedger(client, invalid), /daily_position_availability_check/);
  const after = await loadBondLedgerReport(client, "2026-01-01", "2026-09-09");
  assert.deepEqual(after.availability, report.availability);
});
