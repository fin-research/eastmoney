import assert from 'node:assert/strict';
import test from 'node:test';
import { runMarketBriefing, startMarketBriefing } from '../worker/market-briefing-runner.ts';
import { saveMarketReport } from '../src/lib/server/market-report.ts';
import { directResponse } from './fixtures/market-resources.mjs';

const date = '2026-08-25';
const moduleSteps = ['collect-focus-news', 'collect-open-market', 'collect-fixed-income', 'collect-equity', 'collect-primary', 'collect-secondary', 'collect-inventory'];
function clock(t) { t.mock.timers.enable({ apis: ['Date'], now: new Date(`${date}T17:00:00+08:00`) }); }
function deferred() { return Promise.withResolvers(); }
function newsItem(index) {
  return { sentimentId: `news-${index}`, title: `要闻${index}`, time: `${date}T15:00:00+08:00`, tags: ['债市'], content: '新闻正文' };
}
function harness(override) {
  const calls = [], steps = [], objects = new Map(), checkpoints = new Map();
  const completed = Object.fromEntries(moduleSteps.map(name => [name, deferred()]));
  const env = { DATA: { fetch: async req => {
    calls.push(req.url);
    const response = await override?.(req.url);
    if (response) return response;
    const url = new URL(req.url);
    if (url.pathname === '/data/news') return Response.json([newsItem(1)]);
    if (url.pathname.startsWith('/data/news/')) return Response.json(newsItem(1));
    return directResponse(req.url);
  } }, MARKET_BRIEFING_R2: { put: async (key, body) => { objects.set(key, JSON.parse(body)); return { etag: 'saved' }; } } };
  // Successful step values survive replay. The harness does not implement the platform's retry engine.
  const step = { do: async (name, config, fn) => {
    if (checkpoints.has(name)) return structuredClone(checkpoints.get(name));
    steps.push({ name, config });
    const value = await fn();
    checkpoints.set(name, structuredClone(value));
    completed[name]?.resolve();
    return value;
  } };
  const dependencies = {
    generateMarketBriefingFromNews: async () => ({ stock: '股市判断', bond: '债市判断' }),
    saveMarketReport,
  };
  const run = () => runMarketBriefing(env, step, { reportDate: date }, dependencies);
  return { env, step, calls, steps, objects, checkpoints, completed, dependencies, run };
}

test('七模块并发且互不等待，step内完成解析，之后仅AI和归档', async t => {
  clock(t);
  const equityGate = deferred();
  const h = harness(url => {
    const target = new URL(url);
    if (target.pathname === '/data/industry') {
      return equityGate.promise.then(() => directResponse(url));
    }
  });
  const events = [];
  h.dependencies.generateMarketBriefingFromNews = async (_env, _date, news, options) => {
    assert.ok(moduleSteps.every(name => h.checkpoints.has(name)));
    assert.equal(options.retry, false);
    assert.equal(options.report.report_date, date);
    assert.deepEqual(options.report.equities, h.checkpoints.get("collect-equity").equities);
    assert.deepEqual(options.report.funding_rates, h.checkpoints.get("collect-fixed-income").funding_rates);
    assert.match(news.news_text, /新闻正文/);
    assert.doesNotMatch(news.news_text, /A股主要指数收涨/);
    assert.equal(news.news_count, 1);
    events.push('ai');
    return { stock: '股市判断', bond: '债市判断' };
  };
  h.dependencies.saveMarketReport = async (...args) => { events.push('r2'); return saveMarketReport(...args); };
  const pending = h.run();
  await Promise.all(moduleSteps.filter(name => name !== 'collect-equity').map(name => h.completed[name].promise));
  assert.deepEqual(h.steps.map(row => row.name), moduleSteps);
  assert.equal(h.checkpoints.has('collect-equity'), false);
  assert.deepEqual(events, []);
  // Parsed checkpoint values already use report units and business classifications.
  assert.equal(h.checkpoints.get('collect-open-market').omo_operations[0].amount_yi, 1000);
  assert.equal(h.checkpoints.get('collect-fixed-income').futures[0].last_price, null);
  assert.equal(h.checkpoints.get('collect-primary').primary_summary.current_amount, 0);
  assert.equal(h.checkpoints.get('collect-secondary').secondary_bonds[0].issuer, '测试公司');
  assert.equal(h.checkpoints.get('collect-inventory').inventory_bonds[0].bid_yield, 2.01);
  equityGate.resolve();
  assert.equal((await pending).status, 'complete');
  assert.deepEqual(events, ['ai', 'r2']);
  assert.deepEqual(h.steps.map(row => row.name), [...moduleSteps, 'generate-focus', 'archive-report']);
  assert.equal(h.calls.filter(url => url.includes('/stock-summary?')).length, 1);
  assert.equal(h.calls.filter(url => url.includes('/industry?')).length, 1);
  assert.equal(h.calls.filter(url => url.includes('/trading-days?')).length, 2);
  assert.equal(h.calls.filter(url => url.includes('/bond-infos?')).length, 2);
  assert.ok(h.calls.every(url => url.includes('fields=')));
  assert.ok(h.steps.slice(0, 7).every(({ config }) => config.retries.limit === 3));
  assert.equal(h.steps.find(row => row.name === 'generate-focus').config.retries.limit, 2);
  const report = h.objects.get(`market-briefing/${date}.json`);
  assert.equal(report.focus_text, '1、股市判断\n2、债市判断');
  for (const name of moduleSteps.slice(1)) {
    for (const [field, value] of Object.entries(h.checkpoints.get(name))) assert.deepEqual(report[field], value);
  }
});

test('个别国债收益率缺失保留其他行情且不归零', async t => {
  clock(t);
  const h = harness(url => url.includes('/bond-top-case?') ? Response.json([
    { ordinateName: '国债', abscissaName: '10Y', bondCode: '260011.IB', tradeNum: 20, yield: 1.8, yieldSubYtdCloseBp: -1 },
    { ordinateName: '国债', abscissaName: '5Y', bondCode: '260010.IB', tradeNum: 1, yield: null, yieldSubYtdCloseBp: null },
  ]) : undefined);
  await h.run();
  assert.deepEqual(h.objects.get(`market-briefing/${date}.json`).government_bonds.map(row => row.yield_rate), [null, 1.8]);
});

for (const source of ['stock-summary', 'industry', 'bond-infos', 'news']) {
  test(`${source}的step失败直接传播，不写残缺R2`, async t => {
    clock(t);
    const h = harness(url => url.includes(`/data/${source}?`) ? Response.json({ detail: '源不可用' }, { status: 503 }) : undefined);
    await assert.rejects(h.run());
    assert.deepEqual(h.steps.filter(row => row.name.startsWith('notify-')).map(row => row.name), []);
    assert.equal(h.objects.size, 0);
    assert.equal(h.steps.at(-1).name, 'workflow-failure');
    assert.equal(h.steps.some(row => row.name === 'archive-report'), false);
  });
}

test('失败状态等待所有并发step结束', async t => {
  clock(t);
  const gate = deferred(), started = deferred();
  const h = harness(url => {
    if (url.includes('/omo?')) return Response.json({}, { status: 503 });
    if (url.includes('/futures-latest?')) { started.resolve(); return gate.promise.then(() => directResponse(url)); }
  });
  const pending = assert.rejects(h.run());
  await started.promise;
  assert.equal(h.objects.size, 0);
  gate.resolve();
  await pending;
  assert.equal(h.objects.size, 0);
});

test('AI失败重放复用原Workflow已完成新闻批次，不重新采集', async t => {
  clock(t);
  let attempts = 0;
  const h = harness(url => new URL(url).pathname === '/data/news' ? Response.json(Array.from({ length: 7 }, (_, i) => newsItem(i))) : undefined);
  h.dependencies.generateMarketBriefingFromNews = async () => {
    if (++attempts === 1) throw new Error('AI unavailable');
    return { stock: '股', bond: '债' };
  };
  await assert.rejects(h.run(), /AI unavailable/);
  assert.equal(h.steps.filter(row => row.name === 'collect-focus-news').length, 1);
  assert.equal(h.checkpoints.get('collect-focus-news').news_count, 7);
  const calls = h.calls.length;
  assert.equal((await h.run()).status, 'complete');
  assert.equal(h.calls.length, calls);
  assert.equal(attempts, 2);
});

for (const reportDate of ['2026-09-25', '2026-08-23']) {
  test(`${reportDate}非交易日直接跳过，不创建Workflow或step`, async () => {
    let created = 0;
    const env = { DATA: { fetch: async () => Response.json({ date: reportDate, isTradingDay: false, previousTradingDate: '2026-08-21' }) }, MARKET_BRIEFING: { create: async () => { created++; throw new Error('must not enter Workflow'); } } };
    assert.equal(await startMarketBriefing(env, Date.parse(`${reportDate}T09:00:00Z`)), undefined);
    assert.equal(created, 0);
  });
}

test('成功结果携带归档时间与聚焦正文供事件消费者通知，重放不重复归档', async t => {
  clock(t);
  const h = harness();
  const result = await h.run();
  assert.equal(result.status, 'complete');
  assert.equal(result.focus, '1、股市判断\n2、债市判断');
  assert.ok(result.finalizedAt);
  const calls = h.calls.length, steps = h.steps.length;
  t.mock.timers.setTime(new Date('2026-08-26T09:00:00Z').valueOf());
  assert.deepEqual(await h.run(), result);
  assert.equal(h.calls.length, calls);
  assert.equal(h.steps.length, steps);
});

test('跨日的未完成实时采集失败，不保存错日行情', async t => {
  clock(t);
  const h = harness();
  t.mock.timers.setTime(new Date('2026-08-26T09:00:00Z').valueOf());
  await assert.rejects(h.run(), /采集已跨日/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.objects.size, 0);
});

test('重复Cron使用上海日确定性ID且只确认真实存在的实例', async () => {
  let id;
  const instance = { status: async () => ({ status: 'running' }) };
  const env = { DATA: { fetch: async () => Response.json({ date: '2026-08-25', isTradingDay: true, previousTradingDate: '2026-08-24' }) }, MARKET_BRIEFING: { create: async options => { id = options.id; throw new Error('exists'); }, get: async () => instance } };
  assert.equal(await startMarketBriefing(env, Date.parse('2026-08-25T09:00:00Z')), instance);
  assert.equal(id, 'market-briefing-2026-08-25');
  instance.status = async () => { throw new Error('not found'); };
  await assert.rejects(startMarketBriefing(env, Date.parse('2026-08-25T09:00:00Z')), /exists/);
});

test('工作日行情滞后不能被误判休市跳过', async t => {
  clock(t);
  const h = harness(async url => url.includes('/industry?')
    ? Response.json({ ...await directResponse(url).json(), dataDate: '2026-08-24' }) : undefined);
  await assert.rejects(h.run(), /行情尚未更新/);
  assert.equal(h.objects.size, 0);
});

test('一级发行只读取独立交易日接口，不依赖股票行情', async t => {
  clock(t);
  const h = harness(url => url.includes('/industry?') ? Response.json({ detail: '股票源不可用' }, { status: 503 }) : undefined);
  await assert.rejects(h.run());
  assert.equal(h.checkpoints.get('collect-primary').primary_summary.current_amount, 0);
  assert.equal(h.calls.filter(url => url.includes('/trading-days?')).length, 2);
});


for (const stage of ['generateMarketBriefingFromNews', 'saveMarketReport']) {
  test(`${stage}失败直接传播原错误且没有通知步骤`, async t => {
    clock(t);
    const h = harness();
    h.dependencies[stage] = async () => { throw new Error(`${stage} failed`); };
    await assert.rejects(h.run(), new RegExp(`${stage} failed`));
    assert.equal(h.objects.size, 0);
    assert.deepEqual(h.steps.filter(row => row.name.startsWith('notify-')).map(row => row.name), []);
  });
}


test('AI和归档有明确await边界，后续step不能提前启动', async t => {
  clock(t);
  const h = harness();
  const aiStarted = deferred(), aiDone = deferred(), saveStarted = deferred(), saveDone = deferred();
  h.dependencies.generateMarketBriefingFromNews = async () => {
    aiStarted.resolve();
    await aiDone.promise;
    return { stock: '股', bond: '债' };
  };
  h.dependencies.saveMarketReport = async (...args) => {
    saveStarted.resolve();
    await saveDone.promise;
    return saveMarketReport(...args);
  };
  const pending = h.run();
  await aiStarted.promise;
  assert.equal(h.steps.some(row => row.name === 'archive-report'), false);
  assert.equal(h.steps.some(row => row.name === 'notify-result'), false);
  aiDone.resolve();
  await saveStarted.promise;
  assert.equal(h.steps.some(row => row.name === 'notify-result'), false);
  saveDone.resolve();
  await pending;
  assert.deepEqual(h.steps.slice(-2).map(row => row.name), ['generate-focus', 'archive-report']);
});


test('模块失败不影响其它模块完成，恢复时只重新采集失败模块', async t => {
  clock(t);
  let fail = true;
  const h = harness(url => url.includes('/omo?') && fail ? Response.json({}, { status: 503 }) : undefined);
  await assert.rejects(h.run());
  assert.ok(moduleSteps.filter(name => name !== 'collect-open-market').every(name => h.checkpoints.has(name)));
  const previousCalls = h.calls.length;
  fail = false;
  await h.run();
  assert.equal(h.calls.length - previousCalls, 1);
  assert.ok(h.calls.at(-1).includes('/omo?'));
});

test('DM新闻为空时今日聚焦模块失败，其余六模块仍独立完成', async t => {
  clock(t);
  const h = harness(url => new URL(url).pathname === '/data/news' ? Response.json([]) : undefined);
  await assert.rejects(h.run(), /新闻数据为空/);
  assert.ok(moduleSteps.slice(1).every(name => h.checkpoints.has(name)));
  assert.equal(h.objects.size, 0);
  assert.equal(h.steps.some(row => row.name === 'generate-focus'), false);
});

test('40篇新闻通过原Workflow的四个Data批次获取，完整七模块归档', async t => {
  clock(t);
  const h = harness(url => {
    const target = new URL(url);
    if (target.pathname === '/data/news') {
      const offset = Number(target.searchParams.get('offset'));
      return Response.json(Array.from({ length: 10 }, (_, i) => newsItem(offset + i)));
    }
  });
  assert.equal((await h.run()).status, 'complete');
  assert.equal(h.calls.filter(url => new URL(url).pathname === '/data/news').length, 4);
  assert.equal(h.calls.some(url => new URL(url).pathname.startsWith('/data/news/')), false);
  assert.equal(h.calls.length, 20);
  assert.equal(h.checkpoints.get('collect-focus-news').news_count, 40);
  assert.equal(h.objects.size, 1);
});
