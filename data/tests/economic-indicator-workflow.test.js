import { test, vi, afterEach } from 'vitest';
afterEach(() => vi.restoreAllMocks());
import assert from 'node:assert/strict';
import { economicIndicatorRequests, runEconomicIndicatorSync } from '../src/sync/economic-indicator-run.ts';
import { requestEconomicIndicatorData } from '../src/sync/economic-indicator-request.ts';

const scheduledTime = Date.parse('2026-09-09T16:00:15Z');
function harness(t) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const attempts = new Map(), delays = [], history = [], saved = [], requests = [];
  const step = { async do(name, config, operation) {
    for (let attempt = 1; ; attempt++) {
      attempts.set(name, attempt);
      try {
        const result = await operation({ attempt });
        history.push({ name, result: structuredClone(result) });
        return result;
      } catch (error) {
        history.push({ name, attempt, error: error.message });
        if (attempt > config.retries.limit) throw error;
        assert.equal(config.retries.delay, '1 minute');
        assert.equal(config.retries.backoff, 'exponential');
        delays.push({ name, delay: 60_000 * 2 ** (attempt - 1) });
      }
    }
  }};
  const request = async (path, params) => {
    requests.push({ path, params: new URLSearchParams(params) });
    if (path === '/choice/edb') return {
      function: 'EDB', fields: ['code', 'date', 'RESULT', 'PUBLISHDATE'],
      rows: params.get('edbIds').split(',').map(code => ({
        code, date: '2026-09-08', RESULT: 1.5,
        ...(code === 'EMM00590832' ? {} : { PUBLISHDATE: '20260909' }),
      })),
    };
    return { hasNextPage: true, rows: [{ bondCode: params.get('bondCode'), capitalTime: Date.parse('2026-09-09T08:00:00Z'), weightedYield: 1.42, lastPrice: 1.43 }] };
  };
  const persist = async rows => { saved.push(...rows); return { rowCount: rows.length, asOf: '2026-09-09' }; };
  return { step, request, persist, attempts, delays, history, saved, requests };
}

test('DM retries as a group, retains successful sources after exhaustion and does not replay Choice', async t => {
  const h = harness(t);
  let failedCalls = 0;
  const result = await runEconomicIndicatorSync(h.step, 'isolation', scheduledTime, async (path, params) => {
    if (params.get('bondCode') === 'DR001') { failedCalls++; throw new Error('DM HTTP 503: maintenance code=E503'); }
    return h.request(path, params);
  }, h.persist);
  assert.equal(failedCalls, 3);
  assert.equal(result.status, 'partial');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].request.parameters.bondCode, 'DR001');
  assert.match(result.failures[0].error.message, /maintenance code=E503/);
  assert.deepEqual(h.delays.map(x => x.delay), [60_000, 120_000]);
  assert.equal(h.requests.filter(x => x.path === '/choice/edb').length, 9);
  assert.equal(h.requests.filter(x => x.path === '/cfets-histories').length, 15);
  assert.equal(result.storedRows, 59);
  assert.ok(h.saved.some(x => x.code === 'E1300004'));
  assert.ok(h.saved.some(x => x.code === 'E1704420'));
  assert.ok(!h.saved.some(x => x.code === 'E1300003'));
  assert.equal(h.saved.find(x => x.code === 'EMM00590832').date, '2026-09-09');
  assert.equal(h.history.find(x => x.name === '同步 DM 资金面' && x.result).result.failures.length, 1);
  assert.equal(h.history.filter(x => x.error).length, 2);
  assert.equal(h.history.filter(x => x.result).length, 2);
});

test('a stalled Choice request does not delay DM writes, and all requests launch in parallel', async t => {
  const h = harness(t);
  const hold = Promise.withResolvers();
  const dmSaved = Promise.withResolvers();
  let calls = 0;
  const run = runEconomicIndicatorSync(h.step, 'parallel', scheduledTime, async (path, params) => {
    calls++;
    if (path === '/choice/edb') await hold.promise;
    return h.request(path, params);
  }, async rows => {
    const value = await h.persist(rows);
    if (rows.some(x => x.code === 'E1300004')) dmSaved.resolve();
    return value;
  });
  await dmSaved.promise;
  assert.equal(calls, economicIndicatorRequests(scheduledTime).length);
  assert.ok(h.saved.every(x => ['E1300003', 'E1300004', 'E1704420', 'E1300079', 'DM_SHIBOR_1W', 'DM_SHIBOR_ON'].includes(x.code)));
  hold.resolve();
  assert.equal((await run).status, 'complete');
});

test('Choice retries its combined group and shares publication dates across all batches', async t => {
  const h = harness(t);
  const first = economicIndicatorRequests(scheduledTime)[0];
  let calls = 0;
  const result = await runEconomicIndicatorSync(h.step, 'recover', scheduledTime, async (path, params) => {
    if (params.get('edbIds') === first.parameters.edbIds && ++calls < 3) throw new Error('Choice RPC code=10000009 no data');
    return h.request(path, params);
  }, h.persist);
  assert.equal(result.status, 'complete');
  assert.equal(result.storedRows, 60);
  assert.equal(calls, 3);
  assert.equal(h.requests.filter(x => x.path === '/choice/edb').length, 25);
  assert.equal(h.requests.filter(x => x.path === '/cfets-histories').length, 6);
  assert.equal(h.history.filter(x => x.error?.includes('10000009')).length, 2);
});

test('a failed group write retries fetch and upload together while its sibling stays complete', async t => {
  const h = harness(t);
  let persistCalls = 0;
  const result = await runEconomicIndicatorSync(h.step, 'persist-failure', scheduledTime, h.request, async rows => {
    if (rows.some(x => x.code === 'E1300003')) { persistCalls++; throw new Error('Neon SQLSTATE 57014 statement timeout'); }
    return h.persist(rows);
  });
  assert.equal(persistCalls, 3);
  assert.equal(h.requests.filter(x => x.path === '/choice/edb').length, 9);
  assert.equal(h.requests.filter(x => x.path === '/cfets-histories').length, 18);
  assert.equal(result.status, 'partial');
  assert.equal(result.storedRows, 54);
  assert.equal(result.failures[0].step, '同步 DM 资金面');
  assert.match(result.failures[0].error.message, /57014/);
});

test('all failed interfaces retain durable group diagnostics and never write', async t => {
  const h = harness(t);
  const result = await runEconomicIndicatorSync(h.step, 'all-failed', scheduledTime, async () => { throw new Error('network failure'); }, h.persist);
  assert.equal(result.status, 'failed');
  assert.equal(result.storedRows, 0);
  assert.equal(result.failures.length, economicIndicatorRequests(scheduledTime).length);
  assert.equal(h.saved.length, 0);
  assert.equal(h.history.filter(x => x.result).length, 2);
  assert.ok(h.history.filter(x => x.result).every(x => x.result.failures.length > 0));
});

test('empty incremental windows do not erase history or open an empty transaction', async () => {
  const h = harness();
  const result = await runEconomicIndicatorSync(h.step, 'empty', scheduledTime, async path => path === '/choice/edb'
    ? { function: 'EDB', fields: ['code', 'date', 'RESULT', 'PUBLISHDATE'], rows: [] }
    : { hasNextPage: false, rows: [] }, h.persist);
  assert.equal(result.status, 'complete');
  assert.equal(result.storedRows, 0);
  assert.equal(h.saved.length, 0);
  assert.deepEqual(h.history.map(item => item.name).sort(), ['同步 Choice 经济指标', '同步 DM 资金面'].sort());
  assert.ok(h.history.every(item => !('rawRows' in item.result)));
});

test('Data error response, safe parameters and nested upstream diagnostics survive Workflow serialization', async () => {
  const payload = { detail: 'DM failed', error: { upstreamStatus: 502, upstreamResponse: { body: '{"code":"MAINTENANCE","message":"try later"}' } } };
  const data = { fetch: async () => Response.json(payload, { status: 503, headers: { 'CF-Ray': 'ray-example' } }) };
  await assert.rejects(() => requestEconomicIndicatorData(data, '/cfets-histories', new URLSearchParams({ bondCode: 'DR001' })), error => {
    const details = JSON.parse(error.message);
    assert.equal(details.status, 503);
    assert.equal(details.parameters.bondCode, 'DR001');
    assert.equal(details.requestId, 'ray-example');
    assert.deepEqual(JSON.parse(details.responseBody), payload);
    return true;
  });
});

test('long Choice code lists do not hide the HTTP failure in truncated step output', async () => {
  const data = { fetch: async () => Response.json({ code: '10003008', message: 'invalid stock code' }, { status: 503 }) };
  const codes = Array.from({ length: 200 }, (_, index) => `${String(index).padStart(6, '0')}.SH`).join(',');
  await assert.rejects(() => requestEconomicIndicatorData(data, '/choice/css', new URLSearchParams({ codes })), error => {
    const head = error.message.slice(0, 1000);
    assert.match(head, /"stage":"http_response"/);
    assert.match(head, /"status":503/);
    assert.match(head, /10003008/);
    assert.equal(JSON.parse(error.message).parameters.codes, codes);
    return true;
  });
});

test('oversized and non-JSON Data failures are bounded, cancelled, and redacted', async () => {
  let cancelled = false;
  const data = { fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('password=private-value ' + 'x'.repeat(30_000))); },
    cancel() { cancelled = true; },
  }), { status: 503 }) };
  await assert.rejects(() => requestEconomicIndicatorData(data, '/choice/edb', new URLSearchParams({ edbIds: 'E1000172' })), error => {
    const details = JSON.parse(error.message);
    assert.equal(details.responseTruncated, true);
    assert.ok(details.responseBody.length <= 24_000);
    assert.ok(!details.responseBody.includes('private-value'));
    return true;
  });
  assert.equal(cancelled, true);
});

test.each(['live', 'failed', 'cached'])('Choice %s settles the dependency before the DM child completes', async mode => {
  const h = harness(), dm = Promise.withResolvers(), released = Promise.withResolvers();
  const choiceResult = { name: '同步 Choice 经济指标', status: 'complete', missing: [], failures: [],
    requests: [], rowCount: 1, asOf: '2026-09-09', returnedCodes: ['E1000180'], pageCount: 0 };
  const step = mode === 'cached' ? { do: async () => choiceResult } : h.step;
  const request = mode === 'failed' ? async () => { throw new Error('Choice unavailable'); } : h.request;
  let finished = false;
  const pending = runEconomicIndicatorSync(step, 'dependency', scheduledTime, request, h.persist,
    { choiceSettled: () => released.resolve(), dmGroup: () => dm.promise }).then(result => { finished = true; return result; });
  await released.promise;
  assert.equal(finished, false);
  if (mode === 'live') assert.ok(h.saved.some(row => row.code === 'E1000180'));
  dm.resolve({ ...choiceResult, name: '同步 DM 资金面', rowCount: 0, returnedCodes: [] });
  const result = await pending;
  assert.equal(result.groups[0].status, mode === 'failed' ? 'failed' : 'complete');
  if (mode === 'failed') assert.ok(result.failures.length > 0);
});
