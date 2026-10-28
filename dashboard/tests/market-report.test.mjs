import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

import { fetchReport } from "../src/api.ts";
import {
  readMarketReport,
  saveMarketReport,
} from "../src/lib/server/market-report.ts";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('$lib/')) return next(new URL('../src/lib/' + specifier.slice(5) + '.ts', import.meta.url).href, context);
  return next(specifier, context);
} });
const { GET } = await import('../src/routes/api/market-report/+server.ts');

function reportData() {
  return {
    report_date: "2026-08-25",
    generated_at: "2026-08-25T15:00:00+08:00",
    omo_operations: [],
    funding_rates: [],
    government_bonds: [],
    futures: [],
    stock_paragraphs: ["第一段", "第二段"],
    margin: {
      data_date: "2026-08-22",
      total: 20000,
      total_change: 10,
      financing: 19900,
      financing_change: 9,
      securities_lending: 100,
      securities_lending_change: 1,
    },
    equities: [],
    equity_data_time: null,
    turnover_yi: null,
    turnover_change_yi: null,
    industries: [],
    industry_data_date: "2026-08-25",
    primary_summary: { current_amount: 0, change_amount: 0 },
    primary_issues: [],
    secondary_bonds: [],
    inventory_bonds: [],
  };
}

function memoryBucket() {
  const objects = new Map();
  return {
    objects,
    async get(key) {
      const text = objects.get(key);
      return text === undefined
        ? null
        : { async json() { return JSON.parse(text); } };
    },
    async put(key, value, options) {
      objects.set(key, String(value));
      return { key, etag: "etag", options };
    },
  };
}

test("浏览器从归档读取完整报告且不请求原始行情", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({
    ...reportData(), focus_text: "归档聚焦", cached_at: "2026-08-25T09:00:00Z", finalized_at: "2026-08-25T09:00:00Z",
  }));
  const { report } = await fetchReport("2026-08-25", false);
  assert.equal(report.focus_text, "归档聚焦");
  assert.equal(globalThis.fetch.mock.calls.length, 1);
  assert.equal(globalThis.fetch.mock.calls[0].arguments[0], "/api/market-report?date=2026-08-25");
});

test("定稿写入裁剪后的 R2 快照", async () => {
  const bucket = memoryBucket();
  const saved = await saveMarketReport(
    bucket,
    "2026-08-25",
    reportData(),
    "定稿判断",
  );
  assert.equal(saved.focus_text, "定稿判断");
  assert.ok(saved.finalized_at);

  const raw = JSON.parse(bucket.objects.get("market-briefing/2026-08-25.json"));
  assert.equal(raw.focus_text, "定稿判断");
  assert.equal("text_report" in raw, false);
  assert.equal("todayTrades" in raw, false);
  assert.equal("favoriteQuotes" in raw, false);
  assert.equal("bondInfos" in raw, false);

  const stored = await readMarketReport(bucket, "2026-08-25");
  assert.deepEqual(stored, saved);
});

test("读取不存在或损坏的历史定稿时返回明确错误", async () => {
  const bucket = memoryBucket();
  await assert.rejects(
    readMarketReport(bucket, "2026-08-25"),
    (error) => error.status === 404 && error.code === "REPORT_NOT_FINALIZED",
  );

  bucket.objects.set("market-briefing/2026-08-25.json", "{bad-json");
  await assert.rejects(
    readMarketReport(bucket, "2026-08-25"),
    (error) => error.status === 503 && error.code === "FINALIZED_SNAPSHOT_INVALID",
  );
});

test("过大的定稿快照在写入 R2 前被拒绝", async () => {
  const bucket = memoryBucket();
  await assert.rejects(
    saveMarketReport(
      bucket,
      "2026-08-25",
      reportData(),
      "超长内容".repeat(150_000),
    ),
    (error) => error.status === 400 && /数据过大/.test(error.message),
  );
  assert.equal(bucket.objects.size, 0);
});

test("合并导出保存仍只上传原 JSON 定稿数据与今日聚焦", async () => {
  const { saveMarketReport: saveFromBrowser } = await import('../src/api.ts');
  const original = globalThis.fetch;
  const report = reportData();
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/market-report?date=2026-08-25');
    assert.equal(init.method, 'PUT');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), { report, focusText: '股债正文' });
    return Response.json({ ...report, focus_text: '股债正文', cached_at: '2026-08-25T15:00:00Z', finalized_at: '2026-08-25T15:00:00Z' });
  };
  try { await saveFromBrowser(report, '股债正文'); }
  finally { globalThis.fetch = original; }
});

test('R2未定稿对象返回404而非成功快照',async()=>{
  const bucket=memoryBucket();
  bucket.objects.set('market-briefing/2026-08-25.json',JSON.stringify({...reportData(),focus_text:'',cached_at:'2026-08-25T09:00:00Z',finalized_at:null}));
  await assert.rejects(readMarketReport(bucket,'2026-08-25'),error=>error.status===404&&error.code==='REPORT_NOT_FINALIZED');
});

test('默认 GET 在 Choice 不可达、返回503或日历异常时仍读取准确上一交易日的 R2 定稿', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-17T14:00:00+08:00') });
  const bucket = memoryBucket();
  await saveMarketReport(bucket, '2026-09-16', { ...reportData(), report_date: '2026-09-16' }, '已归档');
  const fetches = [
    async () => { throw new Error('destination_unavailable'); },
    async () => Response.json({ error: { code: 'UPSTREAM_NETWORK_ERROR' } }, { status: 503 }),
    async () => Response.json({ dataDate: '2026-09-11', tradingDates: [] }),
  ];
  for (const fetch of fetches) {
    const dataFetch = context.mock.fn(fetch);
    const response = await GET({ url: new URL('https://example.test/api/market-report'), platform: { env: { EASTMONEY: bucket, DATA: { fetch: dataFetch } } } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const snapshot = await response.json();
    assert.equal(snapshot.report_date, '2026-09-16');
    assert.equal(snapshot.focus_text, '已归档');
    assert.equal(dataFetch.mock.calls.length, 1);
  }
});

test('默认 GET 只读所选日期：上一交易日报告缺失及17点后当日报告缺失均返回404', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-17T16:59:59+08:00') });
  const bucket = memoryBucket();
  await saveMarketReport(bucket, '2026-09-15', { ...reportData(), report_date: '2026-09-15' }, '更早定稿');
  const reads = context.mock.method(bucket, 'get');
  const event = { url: new URL('https://example.test/api/market-report'), platform: { env: { EASTMONEY: bucket } } };
  let response = await GET(event);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'REPORT_NOT_FINALIZED');
  assert.deepEqual(reads.mock.calls.map(call => call.arguments[0]), ['market-briefing/2026-09-16.json']);

  await saveMarketReport(bucket, '2026-09-16', { ...reportData(), report_date: '2026-09-16' }, '昨日定稿');
  context.mock.timers.setTime(new Date('2026-09-17T17:00:00+08:00').valueOf());
  response = await GET(event);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'REPORT_NOT_FINALIZED');
  assert.equal(reads.mock.calls.at(-1).arguments[0], 'market-briefing/2026-09-17.json');

  event.url.searchParams.set('date', '2026-09-16');
  response = await GET(event);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).report_date, '2026-09-16');
});

test('未来年度默认 GET 在交易日接口不可达时仍读取上一工作日', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2027-01-05T09:00:00+08:00') });
  const bucket = memoryBucket();
  await saveMarketReport(bucket, '2027-01-04', { ...reportData(), report_date: '2027-01-04' }, '已归档');
  const dataFetch = context.mock.fn(async () => new Response('destination_unavailable', { status: 503 }));
  const response = await GET({
    url: new URL('https://example.test/api/market-report'),
    platform: { env: { EASTMONEY: bucket, DATA: { fetch: dataFetch } } },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).report_date, '2027-01-04');
  assert.equal(dataFetch.mock.calls.length, 1);
  assert.match(dataFetch.mock.calls[0].arguments[0].url, /\/data\/trading-days\?date=2027-01-04/);
});

test('节假日默认 GET 使用独立交易日接口选择上一交易日报告', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-08T09:00:00+08:00') });
  const bucket = memoryBucket();
  await saveMarketReport(bucket, '2026-09-30', { ...reportData(), report_date: '2026-09-30' }, '更早定稿');
  const reads = context.mock.method(bucket, 'get');
  const dataFetch = context.mock.fn(async () => Response.json({ date: '2026-10-07', isTradingDay: false, previousTradingDate: '2026-09-30' }));
  const response = await GET({ url: new URL('https://example.test/api/market-report'), platform: { env: { EASTMONEY: bucket, DATA: { fetch: dataFetch } } } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).report_date, '2026-09-30');
  assert.deepEqual(reads.mock.calls.map(call => call.arguments[0]), ['market-briefing/2026-09-30.json']);
  assert.equal(dataFetch.mock.calls.length, 1);
});
