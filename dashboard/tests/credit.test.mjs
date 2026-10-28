import {buildCreditReport} from '../src/lib/credit/build-report.ts';
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {creditDatabase,seedCredit} from "./helpers/credit-database.mjs";

import { utils, write } from "xlsx";

import {
  CreditWorkbookParseError,
  parseCreditWorkbook,
} from "../src/lib/credit/workbook.ts";
import { creditInstitutionUpdateSchema } from "../src/lib/credit/update.ts";
import { formatCreditWeeklyNews } from "../src/lib/credit/weekly-news.ts";
import {
  buildWeeklyCreditNews,
  compareCreditSnapshots,
  loadCreditReport,
  persistCreditWorkbook,
  saveCreditInstitution,
} from "../src/lib/server/credit-repository.ts";

test("授信 Excel 一览表与周报使用相同口径且不依赖旧周报名单", () => {
  const parsed = parseCreditWorkbook(workbookBuffer(), {
    reportDate: "2026-08-21",
    originalFileName: "授信周报.xlsx",
  });

  assert.equal(parsed.institutions.length, 2);
  assert.equal(parsed.approvedCount, 2);
  assert.equal(parsed.totalLimit, 12);
  assert.equal(parsed.totalUsed, 4);
  assert.equal(parsed.totalAvailable, 8);
  assert.equal(parsed.weeklyApprovedCount, 2);
  assert.equal(parsed.weeklyTotalLimit, 12);
  assert.equal(parsed.weeklyTotalUsed, 4);
  assert.equal(parsed.weeklyTotalAvailable, 8);
  assert.deepEqual(parsed.warnings, []);
});

test("授信 Excel 列结构变化时拒绝静默错位导入", () => {
  const workbook = syntheticWorkbook();
  workbook.Sheets["授信一览表"].C2.v = "交易对手";
  const buffer = write(workbook, { type: "buffer", bookType: "xlsx" });

  assert.throws(
    () => parseCreditWorkbook(buffer, {
      reportDate: "2026-08-21",
      originalFileName: "错误模板.xlsx",
    }),
    (error) =>
      error instanceof CreditWorkbookParseError &&
      /C2 应为“银行名称”/.test(error.message),
  );
});

test("授信 Excel 拒绝不存在的报告日期", () => {
  assert.throws(
    () => parseCreditWorkbook(workbookBuffer(), {
      reportDate: "2026-02-30",
      originalFileName: "错误日期.xlsx",
    }),
    /报表日必须是有效的 YYYY-MM-DD 日期/,
  );
});

test("授信 Excel 将空状态按已撤销导入", () => {
  const workbook = syntheticWorkbook();
  workbook.Sheets["授信一览表"].E5.v = null;
  const parsed = parseCreditWorkbook(
    write(workbook, { type: "buffer", bookType: "xlsx" }),
    { reportDate: "2026-08-21", originalFileName: "授信周报.xlsx" },
  );

  assert.equal(parsed.institutions[1].status, "revoked");
  assert.equal(parsed.approvedCount, 1);
  assert.equal(parsed.totalLimit, 10);
  assert.equal(parsed.totalUsed, 3);
  assert.equal(parsed.totalAvailable, 7);
});

test("周报快讯覆盖五类授信事件且扩额优先于同时发生的续作", () => {
  const previous = [
    institution("甲银行", 10, 3, 4, 1, { reportDate: "2026-08-14" }),
    institution("农业银行", 10, 3, 4, 1, { reportDate: "2026-08-14", status: "applying" }),
    institution("丙银行", 2, 1, 2, 1, { reportDate: "2026-08-14", expiryDate: "2026-09-30" }),
    institution("丁银行", 2, 1, 2, 1, { reportDate: "2026-08-14", status: "applying" }),
    institution("戊银行", 4, 1, 4, 1, { reportDate: "2026-08-14", expiryDate: "2026-10-31" }),
    institution("己银行", 6, 1, 6, 1, { reportDate: "2026-08-14", expiryDate: "2026-08-20" }),
    institution("庚银行", 8, 1, 8, 1, { reportDate: "2026-08-14" }),
    institution("辛银行", 4, 1, 4, 1, { reportDate: "2026-08-14", expiryDate: "2026-10-31" }),
  ];
  const current = [
    institution("甲银行", 10, 4, 6, 2),
    institution("农业银行", 12, 3, 4, 1),
    institution("乙银行", 5, 0, 5, 0),
    institution("丙银行", 2, 1, 2, 1, { expiryDate: "2027-09-30" }),
    institution("丁银行", 3, 1, 3, 1, { status: "applying" }),
    institution("戊银行", 4, 1, 4, 1, { status: "applying", expiryDate: "2027-10-31" }),
    institution("己银行", 6, 1, 6, 1, { status: "applying", expiryDate: "2026-08-20" }),
    institution("庚银行", 8, 1, 8, 1, { status: "revoked" }),
    institution("辛银行", 6, 1, 6, 1, { expiryDate: "2027-10-31" }),
  ];

  const weeklyNews = buildWeeklyCreditNews(current, previous, "2026-08-21", "2026-08-14");
  const limitChanges = compareCreditSnapshots(current, previous, "limit");

  assert.deepEqual(
    weeklyNews.map((news) => [
      news.institutionName,
      news.eventType,
      news.previousAmount,
      news.currentAmount,
      news.deltaAmount,
    ]),
    [
      ["农业银行", "increase", 10, 12, 2],
      ["乙银行", "new", 0, 5, 5],
      ["丙银行", "renewal", 2, 2, 0],
      ["戊银行", "renewal", 4, 4, 0],
      ["己银行", "expiry", 6, 6, 0],
      ["庚银行", "revocation", 8, 8, 0],
      ["辛银行", "increase", 4, 6, 2],
    ],
  );
  assert.deepEqual(
    limitChanges.map((change) => [change.institutionName, change.deltaAmount]),
    [["农业银行", 2], ["乙银行", 5], ["丙银行", 0], ["戊银行", 0], ["辛银行", 2]],
  );
  assert.equal(weeklyNews.some((news) => news.institutionName === "甲银行"), false);
  assert.equal(weeklyNews.some((news) => news.institutionName === "丁银行"), false);
  assert.equal(limitChanges.some((change) => /债券投资额度/.test(change.details.join("；"))), false);
  assert.deepEqual(weeklyNews.map(formatCreditWeeklyNews), [
    "农业银行授信扩额完成，总额12亿，较前额增加2亿，到期日2026年12月31日。",
    "乙银行新增授信批复，总额5亿，起始日2026年1月1日，到期日2026年12月31日。",
    "丙银行授信续作完成，总额2亿，较前额一致，到期日2027年9月30日。",
    "戊银行授信续作完成，总额4亿，较前额一致，到期日2027年10月31日。",
    "己银行授信到期，总额6亿，到期日2026年8月20日。",
    "庚银行授信撤销，原总额8亿，撤销日2026年8月21日。",
    "辛银行授信扩额完成，总额6亿，较前额增加2亿，到期日2027年10月31日。",
  ]);
});

test("初始截面不生成周度变化且单个数据库连接顺序执行", async t => {
  const db=await creditDatabase(t);await seedCredit(db);
  let active=false; const query=db.query.bind(db);
  db.query=async(...args)=>{assert.equal(active,false);active=true;try{return await query(...args)}finally{active=false}};
  const report=await loadCreditReport(db,'2026-08-21');
  assert.equal(report.previousDate,null);assert.equal(report.summary.totalLimit,10);assert.equal(report.summary.totalUsed,3);
  assert.equal(report.summary.totalAvailable,7);assert.deepEqual(report.weeklyNews,[]);
  assert.deepEqual(report.usageChanges,[]);assert.ok(report.calendarEvents.some(event=>event.type==='expiry'));
});

test('周报对比期包含真实的上一周新增和到期事件数', async t => {
  const db=await creditDatabase(t);
  await seedCredit(db,'2026-08-01','基准银行');
  await seedCredit(db,'2026-08-03','前周新增一',{expiry_date:'2027-08-30'},'new');
  await seedCredit(db,'2026-08-07','前周新增二',{expiry_date:'2027-08-30'},'new');
  await db.query("SELECT credit.append_entry('2026-08-07','基准银行','{\"status\":\"revoked\",\"expiry_date\":\"1970-01-01\"}'::jsonb,'auth0|test','revocation')");
  await seedCredit(db,'2026-08-15','本周新增',{expiry_date:'2027-08-30'},'new');
  const report=await loadCreditReport(db,'2026-08-15');
  assert.equal(report.previousDate,'2026-08-08');
  assert.equal(report.weeklySummary.addedInstitutionCount,1);
  assert.equal(report.previousWeeklySummary.addedInstitutionCount,2);
  assert.equal(report.weeklySummary.expiredInstitutionCount,0);
  assert.equal(report.previousWeeklySummary.expiredInstitutionCount,0);
});

test("周报读取申请事件并筛选近六个月批复", async t => {
  const db=await creditDatabase(t);
  await seedCredit(db,'2026-08-14','甲银行',{expiry_date:'2026-12-31'});
  await seedCredit(db,'2026-08-14','乙银行',{total:2,bond_investment_secondary_used:1,expiry_date:'2026-08-20'});
  await db.query("SELECT credit.append_entry('2026-08-21','甲银行','{\"total\":12,\"bond_investment_secondary_used\":4,\"expiry_date\":\"2027-12-31\"}', 'auth0|test','increase')");
  await db.query("SELECT credit.append_entry('2026-08-21','乙银行','{\"status\":\"revoked\",\"expiry_date\":\"1970-01-01\"}', 'auth0|test','revocation')");
  await seedCredit(db,'2026-08-21','丙银行',{total:5,bond_investment_secondary_used:0,effective_date:'2026-08-21'},'new');
  const report=await loadCreditReport(db,'2026-08-21');
  assert.equal(report.summary.totalLimit,17);assert.equal(report.summary.totalUsed,4);
  assert.equal(report.weeklySummary.addedInstitutionCount,1);assert.equal(report.weeklySummary.expiredInstitutionCount,0);
  assert.deepEqual(report.weeklyNews.map(x=>x.eventType).sort(),['increase','new']);
  assert.deepEqual(report.recentApprovals.map(x=>x.institutionName).sort(),['丙银行','甲银行'].sort());
  assert.ok(report.calendarEvents.some(e=>e.label==='授信扩额 · 12亿元'));
  assert.ok(report.calendarEvents.some(e=>e.label==='债券投资——二级买卖 · 增加1亿元'));
  assert.equal(report.calendarEvents.some(e=>e.kind==='renewal'),false);
});

test("同日报表重复导入无变更不增加entry，变化直接合并对应字段", async t => {
  const db=await creditDatabase(t);
  const parsed=parseCreditWorkbook(workbookBuffer(),{reportDate:'2026-08-21',originalFileName:'授信周报.xlsx'});
  for (const row of parsed.institutions) await db.query("INSERT INTO public.client(name,type) VALUES ($1,'银行')",[row.institutionName]);
  const first=await persistCreditWorkbook(db,{parsed,createdBy:'auth0|test'});
  const repeat=await persistCreditWorkbook(db,{parsed,createdBy:'auth0|test'});
  assert.equal(first.addedDiffCount,4);assert.equal(repeat.addedDiffCount,0);assert.equal(repeat.replaced,false);
  const before=(await db.query('SELECT count(*)::int n FROM credit.entry')).rows[0].n;
  parsed.institutions[0].totalLimit=11;
  assert.equal((await persistCreditWorkbook(db,{parsed,createdBy:'auth0|test'})).addedDiffCount,1);
  assert.equal((await db.query('SELECT count(*)::int n FROM credit.entry')).rows[0].n,before);
  const row=(await db.query("SELECT e.* FROM credit.entry e JOIN credit.institution i ON i.id=e.institution_id WHERE i.name=$1 AND e.field_id='total'",[parsed.institutions[0].institutionName])).rows[0];
  assert.equal(Number(row.v_num),11);assert.equal(row.event,'maintenance');assert.ok(row.updated_at);
  assert.equal((await db.query("SELECT to_regclass('credit.diff_merge_archive') AS name")).rows[0].name,null);
});

test("同日维护合并单个字段并保留创建信息", async t => {
  const db=await creditDatabase(t);await seedCredit(db,'2026-08-21','甲银行',{notes:'旧备注'});
  const before=(await db.query("SELECT * FROM credit.entry WHERE field_id='notes'")).rows[0];
  const result=await saveCreditInstitution(db,{reportDate:'2026-08-21',institutionName:'甲银行',changes:{institution:{notes:'已更新'}}},'auth0|test');
  assert.equal(buildCreditReport(result.data).institutions[0].notes,'已更新');assert.equal(buildCreditReport(result.data).institutions[0].totalLimit,10);
  const row=(await db.query("SELECT * FROM credit.entry WHERE field_id='notes'")).rows[0];
  assert.equal(row.v_text,'已更新');assert.equal(row.created_by,'auth0|test');assert.ok(row.updated_at);
  assert.equal(row.institution_id,before.institution_id);assert.equal(row.report_date.toISOString(),before.report_date.toISOString());
  assert.equal(new Date(row.created_at).toISOString(),new Date(before.created_at).toISOString());
});

test("分项维护只追加该字段并在同一事务返回重建后的截面", async t => {
  const db=await creditDatabase(t);await seedCredit(db);
  const result=await saveCreditInstitution(db,{reportDate:'2026-08-22',institutionName:'甲银行',changes:{items:[{type:'bond_investment',secondaryUsedAmount:2}]}},'auth0|test');
  assert.equal(buildCreditReport(result.data).institutions[0].totalUsed,2);assert.equal(buildCreditReport(result.data).institutions[0].totalLimit,10);
  assert.equal((await loadCreditReport(db,'2026-08-21')).institutions[0].totalUsed,3);
  const rows=(await db.query("SELECT * FROM credit.entry WHERE report_date='2026-08-22'")).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].field_id,'bond_investment_secondary_used');assert.equal(Number(rows[0].v_num),2);
});

test("授信增量 PATCH 须指明申请操作且拒绝空变更", () => {
  const base = {
    operation: "maintenance",
    reportDate: "2026-08-21",
    institutionName: "甲银行",
  };

  assert.equal(creditInstitutionUpdateSchema.safeParse({
    reportDate: base.reportDate,
    institutionName: base.institutionName,
    changes: { institution: { notes: "旧请求" } },
  }).success, false);
  assert.equal(creditInstitutionUpdateSchema.safeParse({
    ...base,
    changes: { institution: { status: "approved" } },
  }).success, true);
  assert.equal(creditInstitutionUpdateSchema.safeParse({
    ...base,
    changes: {},
  }).success, false);
});

test("授信 schema、API 与页面保留只读详情及申请入口", async () => {
  const [schemaMigration, eventMigration, repository, route, view, application, metricCard, demoData] = await Promise.all([
    readFile(new URL("../credit-migrations/0002_normalize_credit_tables.sql", import.meta.url), "utf8"),
    readFile(new URL("../credit-migrations/0003_create_credit_events.sql", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/server/credit-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/api/credit/+server.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/trading-research/CreditView.svelte", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/trading-research/CreditApplicationDialog.svelte", import.meta.url), "utf8"),
    readFile(new URL("../src/components/MetricCard.svelte", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/trading-research/demo-data.ts", import.meta.url), "utf8"),
  ]);

  assert.match(schemaMigration, /CREATE TYPE credit\.credit_status AS ENUM/);
  assert.match(schemaMigration, /RENAME TO institution/);
  assert.match(schemaMigration, /RENAME TO item/);
  assert.match(schemaMigration, /DROP TABLE credit\.daily_summary/);
  assert.match(eventMigration, /CREATE TABLE credit\.institution_event/);
  assert.match(eventMigration, /'new', 'renewal', 'increase', 'expiry', 'revocation'/);
  assert.match(eventMigration, /CREATE OR REPLACE FUNCTION credit\.refresh_institution_events/);
  assert.match(eventMigration, /SELECT credit\.refresh_institution_events\(\)/);
  assert.doesNotMatch(repository, /daily_summary|institution_daily|item_daily|import_run|_snapshot/);
  assert.doesNotMatch(repository, /expectedUpdatedAt|updated_at = \$3::timestamptz/);
  assert.match(repository, /loadCreditStates/);
  assert.doesNotMatch(repository, /SS\.MS/);
  assert.match(repository, /credit\.append_entry/);
  assert.match(
    repository,
    /await loadCreditData[\s\S]*?await client\.query\('COMMIT'\)/,
  );
  assert.match(route, /HYPERDRIVE/);
  assert.match(route, /export const PATCH/);
  assert.match(route, /creditInstitutionUpdateSchema/);
  assert.match(view, /授信一览表/);
  assert.match(view, /授信日历/);
  assert.match(view, /授信周报/);
  assert.match(view, /授信申请/);
  assert.doesNotMatch(view, /updateCreditInstitution|oninput=\{\(event\) => setEditor/);
  assert.match(application, /updateCreditInstitution/);
  assert.match(application, /renewal: '续期'.*increase: '扩额'.*revocation: '撤销'/);
  assert.match(view, /toggleSort/);
  assert.doesNotMatch(view, /structuredClone/);
  assert.doesNotMatch(view, /授信额度变动/);
  assert.match(view, /title="近期新增授信批复"/);
  assert.match(view, /title="授信明细"/);
  assert.match(view, /rowspan=\{group\.institutions\.length\}/);
  assert.match(view, /<ol class="tr-credit-news-list">/);
  assert.doesNotMatch(view, /使用额度变动/);
  assert.match(view, /导出图片/);
  assert.match(view, /label="30日内到期"/);
  assert.match(view, /label="额度使用率" value=\{report\.summary\.utilization\.toFixed\(1\)\} unit="%"/);
  assert.match(view, /title="授信额度使用率"/);
  assert.match(view, /title="授信预警"/);
  assert.doesNotMatch(view, /高使用率机构|tr-result-count|一览表全口径|数据截至/);
  assert.doesNotMatch(metricCard, /research-metric-card__balance/);
  assert.doesNotMatch(demoData, /demoCreditLines|creditSummary|creditAlerts|CREDIT-USAGE|CREDIT-EXPIRY/);
});

function workbookBuffer() {
  return write(syntheticWorkbook(), { type: "buffer", bookType: "xlsx" });
}

function syntheticWorkbook() {
  const overview = Array.from({ length: 5 }, () => Array(34).fill(null));
  overview[0][1] = "东方财富证券授信状况一览表";
  overview[1][1] = "银行性质";
  overview[1][2] = "银行名称";
  overview[1][3] = "是否签署保密协议/保密承诺函";
  overview[1][4] = "状态";
  overview[1][6] = "授信额度\n(亿元)";
  overview[1][9] = "债券投资额度(亿元)";
  overview[1][12] = "收益凭证额度(亿元)";
  overview[1][15] = "法透额度（亿元）";
  overview[1][18] = "两融收益权转让额度(亿元)";
  overview[1][21] = "同业拆借额度(亿元)";
  overview[1][24] = "其它(亿元)";
  overview[1][26] = "授信生效日";
  overview[1][27] = "授信到期日";
  overview[2][4] = "已获批";
  overview[2][5] = "申请中";
  overview[2][6] = "总额";
  overview[2][7] = "已用";
  overview[2][8] = "剩余";
  overview[3] = creditRow("国有银行", "甲银行", 10, 3, 7, 5, 1, 4, 5, 2, 3);
  overview[4] = creditRow(null, "乙银行", 2, 1, 1, 0, 0, 0, 0, 0, 0);
  overview[4][24] = 1;
  overview[4][25] = "其它占用";

  const weekly = Array.from({ length: 9 }, () => Array(6).fill(null));
  weekly[0][3] = "授信周报";
  weekly[2][1] = "授信总额（亿元）";
  weekly[2][3] = 10;
  weekly[3][1] = "可用余额（亿元）";
  weekly[3][3] = 7;
  weekly[5][1] = "银行性质";
  weekly[5][2] = "银行名称";
  weekly[6][3] = "总额度";
  weekly[7][1] = "国有银行";
  weekly[7][2] = "甲银行";

  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet(overview), "授信一览表");
  utils.book_append_sheet(workbook, utils.aoa_to_sheet(weekly), "授信周报");
  return workbook;
}

function creditRow(
  type,
  name,
  total,
  used,
  remaining,
  bondLimit,
  bondUsed,
  bondRemaining,
  lendingLimit,
  lendingUsed,
  lendingRemaining,
) {
  const row = Array(34).fill(null);
  row[1] = type;
  row[2] = name;
  row[3] = "是";
  row[4] = 1;
  row[6] = total;
  row[7] = used;
  row[8] = remaining;
  row[9] = bondLimit;
  row[10] = bondUsed;
  row[11] = bondRemaining;
  row[21] = lendingLimit;
  row[22] = lendingUsed;
  row[23] = lendingRemaining;
  row[26] = "2026/1/1";
  row[27] = "2026/12/31";
  return row;
}

function institution(name, total, used, bondLimit, bondUsed, overrides = {}) {
  return {
    reportDate: "2026-08-21",
    institutionType: "银行",
    institutionName: name,
    confidentialityStatus: true,
    status: "approved",
    totalLimit: total,
    totalUsed: used,
    totalRemaining: total - used,
    availableAmount: Math.max(total - used, 0),
    utilization: total ? (used / total) * 100 : null,
    effectiveDate: "2026-01-01",
    expiryDate: "2026-12-31",
    bankOffice: null,
    applyingDepartment: null,
    handler: null,
    notes: null,
    bondPreference: null,
    usageDetails: null,
    updatedAt: "2026-08-21T09:00:00.000Z",
    items: [
      { type: "bond_investment", limitAmount: bondLimit, usedAmount: bondUsed, remainingAmount: bondLimit - bondUsed, details: null },
      { type: "yield_certificate", limitAmount: null, usedAmount: null, remainingAmount: null, details: null },
      { type: "legal_overdraft", limitAmount: null, usedAmount: null, remainingAmount: null, details: null },
      { type: "interbank_lending", limitAmount: null, usedAmount: null, remainingAmount: null, details: null },
      { type: "other", limitAmount: null, usedAmount: null, remainingAmount: null, details: null },
    ],
    ...overrides,
  };
}

function institutionRow(overrides = {}) {
  return {
    report_date: "2026-08-21",
    institution_type: "银行",
    institution_name: "甲银行",
    confidentiality_status: true,
    status: "approved",
    total_limit: 10,
    total_used: 3,
    total_remaining: 7,
    effective_date: "2026-01-01",
    expiry_date: "2026-12-31",
    bank_office: null,
    applying_department: null,
    handler: null,
    notes: null,
    bond_preference: null,
    usage_details: null,
    updated_at: "2026-08-21T09:00:00.000Z",
    ...overrides,
  };
}

function institutionEventRow(overrides = {}) {
  return {
    report_date: "2026-08-21",
    previous_report_date: "2026-08-14",
    institution_name: "甲银行",
    institution_type: "银行",
    event_type: "new",
    previous_status: null,
    current_status: "approved",
    previous_total_limit: null,
    current_total_limit: 10,
    delta_amount: 10,
    previous_effective_date: null,
    current_effective_date: "2026-01-01",
    previous_expiry_date: null,
    current_expiry_date: "2026-12-31",
    credit_details: [],
    ...overrides,
  };
}

test('授信总已用按分项重算并警告原表差额，保密协议仅明确签署为 true', () => {
  const workbook = syntheticWorkbook();
  const sheet = workbook.Sheets['授信一览表'];
  sheet.H4.v = 3.0245;
  sheet.D4.v = 'not_signed';
  sheet.D5.v = 'unknown';
  delete workbook.Sheets['授信周报'];
  workbook.SheetNames = ['授信一览表'];
  const parsed = parseCreditWorkbook(write(workbook, { type: 'buffer', bookType: 'xlsx' }), {
    reportDate: '2026-08-21', originalFileName: '授信.xlsx',
  });
  assert.equal(parsed.institutions[0].totalUsed, 3);
  assert.equal(parsed.institutions[0].totalRemaining, 7);
  assert.equal(parsed.institutions[0].confidentialityStatus, false);
  assert.equal(parsed.institutions[1].confidentialityStatus, false);
  assert.match(parsed.warnings.join('\n'), /甲银行.*原表3.0245亿元，分项合计3亿元，差额0.0245亿元/);
  assert.equal('sourceRow' in parsed.institutions[0], false);
  assert.equal('includedInWeeklyReport' in parsed.institutions[0], false);
});

test('授信布尔协议契约拒绝字符串及已删除的周报标记', () => {
  const check = institution => creditInstitutionUpdateSchema.safeParse({ operation: 'maintenance', reportDate: '2026-08-21', institutionName: '甲', changes: { institution } }).success;
  assert.equal(check({ confidentialityStatus: true }), true);
  assert.equal(check({ confidentialityStatus: false }), true);
  for (const value of ['signed', 'not_signed', 'unknown', 'false']) assert.equal(check({ confidentialityStatus: value }), false);
  assert.equal(check({ includedInWeeklyReport: false }), false);
});

test('稀疏变更正确继承 false、零和清空，补录历史不覆盖后续显式变更',async t=>{
  const db=await creditDatabase(t);await seedCredit(db,'2026-08-21','甲银行',{confidentiality_status:true,notes:'旧备注'});
  await saveCreditInstitution(db,{operation:'increase',reportDate:'2026-08-23',institutionName:'甲银行',changes:{institution:{totalLimit:12,notes:'后续备注'}}},'auth0|test');
  await saveCreditInstitution(db,{reportDate:'2026-08-22',institutionName:'甲银行',changes:{institution:{confidentialityStatus:false,notes:''},items:[{type:'bond_investment',limitAmount:0,secondaryUsedAmount:0}]}},'auth0|test');
  const before=(await loadCreditReport(db,'2026-08-21')).institutions[0];
  const middle=(await loadCreditReport(db,'2026-08-22')).institutions[0];
  const after=(await loadCreditReport(db,'2026-08-25')).institutions[0];
  assert.equal(before.notes,'旧备注');assert.equal(middle.notes,'');assert.equal(middle.totalLimit,10);assert.equal(middle.items.find(item=>item.type==='bond_investment').limitAmount,0);assert.equal(middle.confidentialityStatus,false);
  assert.equal(after.totalLimit,12);assert.equal(after.notes,'后续备注');assert.equal(after.totalUsed,0);
  const sql=(await db.query("SELECT notes,total::float8,confidentiality_status FROM credit.entry_as_of('2026-08-25')")).rows[0];
  assert.deepEqual(sql,{notes:'后续备注',total:12,confidentiality_status:false});
  const rows=(await db.query("SELECT field_id,v_num,v_text FROM credit.entry WHERE report_date='2026-08-22'")).rows;
  assert.equal(rows.find(r=>r.field_id==='notes').v_text,'');assert.equal(Number(rows.find(r=>r.field_id==='bond_investment_limit').v_num),0);
  assert.equal(before.confidentialityStatus,false);
});

test('拆借和收益凭证按实际生效、到期和提前结清日期显示逐项变动',async t=>{
  const db=await creditDatabase(t);await seedCredit(db,'2026-08-01','甲银行',{expiry_date:'2027-12-31'});
  await db.exec(`INSERT INTO financing.debt(debt_type,name,client_id,amount,activated_at,maturity_date,settled_at) VALUES
    ('同业拆借','借入',(SELECT id FROM public.client WHERE name='甲银行'),100000000,'2026-08-21','2026-08-25',NULL),
    ('收益凭证','凭证',(SELECT id FROM public.client WHERE name='甲银行'),200000000,'2026-08-21','2026-08-30','2026-08-24')`);
  const report=await loadCreditReport(db,'2026-08-26');
  const events=report.calendarEvents.filter(e=>e.type==='usage');
  assert.deepEqual(events.map(e=>[e.date,e.label]),[
    ['2026-08-21','同业拆借 · 增加1亿元'],['2026-08-21','收益凭证 · 增加2亿元'],
    ['2026-08-24','收益凭证 · 减少2亿元'],['2026-08-25','同业拆借 · 减少1亿元'],
  ]);
  assert.equal(events.some(e=>/合计|总已用/.test(e.label)),false);
  const historical=await loadCreditReport(db,'2026-08-22');assert.equal(historical.summary.totalUsed,6);
});

test('维护不生成申请事件，续作替换旧到期提醒且跨月可查询',async t=>{
  const db=await creditDatabase(t);await seedCredit(db);
  await saveCreditInstitution(db,{reportDate:'2026-08-22',institutionName:'甲银行',changes:{items:[{type:'bond_investment',limitAmount:6}]}},'auth0|test');
  await saveCreditInstitution(db,{operation:'renewal',reportDate:'2026-08-23',institutionName:'甲银行',changes:{institution:{expiryDate:'2027-01-15'}}},'auth0|test');
  const august=await loadCreditReport(db,'2026-08-25');
  assert.equal(august.calendarEvents.some(e=>e.date==='2026-08-22'&&e.type!=='usage'),false);
  assert.ok(august.calendarEvents.some(e=>e.date==='2026-08-23'&&e.kind==='renewal'));
  assert.equal(august.calendarEvents.some(e=>e.date==='2026-08-30'&&e.kind==='expiry'),false);
  const january=await loadCreditReport(db,'2026-08-25','2027-01');
  assert.ok(january.calendarEvents.some(e=>e.date==='2027-01-15'&&e.label==='授信到期 · 10亿元'));
});

test('无效组合回滚完整变更，新增机构后可直接维护',async t=>{
  const db=await creditDatabase(t);
  const input={reportDate:'2026-08-21',institutionName:'甲银行',changes:{institution:{institutionType:'城商行',confidentialityStatus:false,status:'applying'}}};
  await saveCreditInstitution(db,input,'auth0|test',true);
  await assert.rejects(saveCreditInstitution(db,input,'auth0|test',true),/已存在/);
  const before=(await db.query('SELECT count(*) n FROM credit.entry')).rows[0].n;
  await assert.rejects(saveCreditInstitution(db,{...input,changes:{institution:{effectiveDate:'2026-09-01',expiryDate:'2026-08-01'},items:[{type:'other',usedAmount:5}]}},'auth0|test'),/到期日不能早于生效日/);
  assert.equal((await db.query('SELECT count(*) n FROM credit.entry')).rows[0].n,before);
});

// This exercises a nonempty conversion and the explicit removal of the three old tables.
test('旧快照转换可逐字段复原，并记录旧字段清空和机构撤销',async t=>{
  const db=await creditDatabase(t,true);
  await db.exec(`INSERT INTO credit.institution(report_date,institution_name,institution_type,status,confidentiality_status,total_limit,notes,usage_details) VALUES
    ('2026-08-21','甲','股份行','approved',true,10,'描述','备注'),
    ('2026-08-28','甲','股份行','approved',false,10,NULL,'后续备注'),
    ('2026-08-21','乙','城商行','approved',false,5,'乙描述',NULL);
    INSERT INTO credit.item(report_date,institution_name,item_type,limit_amount,used_amount,details) VALUES
    ('2026-08-21','甲','other',2,1,'其它说明'),('2026-08-28','甲','other',2,0,'其它说明');`);
  await db.exec(await readFile(new URL('../credit-migrations/0008_credit_diff.sql',import.meta.url),'utf8'));
  const original=(await db.query("SELECT detail,notes,confidentiality_status,other_used::float8 FROM credit.state_as_of('2026-08-21') WHERE institution_name='甲'")).rows[0];
  const later=(await db.query("SELECT detail,notes,confidentiality_status,other_used::float8 FROM credit.state_as_of('2026-08-30') WHERE institution_name='甲'")).rows[0];
  assert.deepEqual(original,{detail:'描述',notes:'备注',confidentiality_status:true,other_used:1});
  assert.deepEqual(later,{detail:null,notes:'后续备注',confidentiality_status:false,other_used:0});
  assert.equal((await db.query("SELECT status FROM credit.state_as_of('2026-08-30') WHERE institution_name='乙'")).rows[0].status,'revoked');
  assert.deepEqual((await db.query("SELECT to_regclass('credit.institution') institution,to_regclass('credit.item') item,to_regclass('credit.institution_event') event")).rows[0],{institution:null,item:null,event:null});
});

test('数据库精度归一后相同金额不产生重复 diff，历史补录不能破坏后续期限',async t=>{
  const db=await creditDatabase(t);await seedCredit(db);
  const patch={reportDate:'2026-08-21',institutionName:'甲银行',changes:{institution:{totalLimit:10.1234567}}};
  await saveCreditInstitution(db,{...patch,operation:'increase'},'auth0|test');
  const count=(await db.query('SELECT count(*) n FROM credit.entry')).rows[0].n;
  await saveCreditInstitution(db,patch,'auth0|test');
  assert.equal((await db.query('SELECT count(*) n FROM credit.entry')).rows[0].n,count);
  await saveCreditInstitution(db,{...patch,reportDate:'2026-08-25',changes:{institution:{expiryDate:'2026-08-26'}}},'auth0|test');
  await assert.rejects(saveCreditInstitution(db,{...patch,reportDate:'2026-08-22',changes:{institution:{effectiveDate:'2026-08-29'}}},'auth0|test'),/到期日不能早于生效日/);
});

test('描述和分项额度维护均不伪造申请事件',async t=>{
  const db=await creditDatabase(t);
  await seedCredit(db,'2026-08-21','甲银行',{detail:'债券投资额度4亿元'});
  await saveCreditInstitution(db,{reportDate:'2026-09-04',institutionName:'甲银行',changes:{institution:{detail:'债券投资授信额度为4亿元。',notes:'手工备注',handler:'新经办人'},items:[{type:'bond_investment',details:'仅说明文字变化'}]}},'auth0|test');
  const report=await loadCreditReport(db,'2026-09-09','2026-09');
  assert.equal(report.calendarEvents.filter(e=>e.date==='2026-09-04').length,0);
  assert.equal(report.institutions[0].detail,'债券投资授信额度为4亿元。');
  assert.equal((await db.query("SELECT count(*) n FROM credit.entry WHERE report_date='2026-09-04'")).rows[0].n,3);
  await saveCreditInstitution(db,{reportDate:'2026-09-05',institutionName:'甲银行',changes:{items:[{type:'bond_investment',limitAmount:6}]}},'auth0|test');
  const revised=await loadCreditReport(db,'2026-09-09','2026-09');
  assert.deepEqual(revised.calendarEvents.filter(e=>e.date==='2026-09-05'&&e.type!=='usage').map(e=>e.label),[]);
});

test('五个已用分项的日历事件均带稳定类型，金额使用增加减少文字',async t=>{
  const db=await creditDatabase(t);await seedCredit(db,'2026-08-21','甲银行',{other_used:0,legal_overdraft_used:0});
  await saveCreditInstitution(db,{reportDate:'2026-09-04',institutionName:'甲银行',changes:{items:[
    {type:'bond_investment',secondaryUsedAmount:2.5},{type:'other',usedAmount:0.0245},
    {type:'legal_overdraft',usedAmount:1},
  ]}},'auth0|test');
  await db.exec(`INSERT INTO financing.debt(debt_type,name,client_id,amount,activated_at,maturity_date) VALUES
    ('同业拆借','拆借',(SELECT id FROM public.client WHERE name='甲银行'),100000000,'2026-09-04','2026-10-01'),
    ('收益凭证','凭证',(SELECT id FROM public.client WHERE name='甲银行'),200000000,'2026-09-04','2026-10-01')`);
  const events=(await loadCreditReport(db,'2026-09-09','2026-09')).calendarEvents.filter(e=>e.date==='2026-09-04'&&e.type==='usage');
  assert.deepEqual(events.map(e=>e.itemType).sort(),['bond_investment','yield_certificate','legal_overdraft','interbank_lending','other'].sort());
  assert.ok(events.every(e=>/ · (增加|减少)[0-9.]+亿元$/.test(e.label)));
  assert.ok(events.some(e=>e.label==='其它 · 增加0.0245亿元'));
  assert.ok(events.some(e=>e.label==='债券投资——二级买卖 · 减少0.5亿元'));
});
