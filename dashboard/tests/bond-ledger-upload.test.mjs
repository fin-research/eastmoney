import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'tsx/esm/api';
register();
const { archiveBondLedgerFile } = await import('../src/lib/bond-ledger/upload.ts');

test('client parses in a disposable Worker then submits one direct import request', async t => {
  const calls = [];
  const parsed = { date: '2026-09-21', performance: [], positions: [] };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push('request');
    assert.equal(url, '/api/bond-ledger');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body.get('parsed')), parsed);
    assert.equal(init.body.get('file').name, '台账.xlsx');
    assert.equal(init.body.get('expectedDate'), parsed.date);
    return Response.json({ reportDate: parsed.date, statisticsCount: 1, positionCount: 0, transactionCount: 0 });
  });
  const previousWorker = globalThis.Worker;
  globalThis.Worker = class {
    constructor(url, options) { assert.ok(url.pathname.endsWith('/parse.worker.ts')); assert.equal(options.type, 'module'); }
    postMessage(file) { calls.push('parse'); assert.equal(file.name, '台账.xlsx'); queueMicrotask(() => this.onmessage({ data: { parsed } })); }
    terminate() { calls.push('terminate'); }
  };
  try {
    assert.equal((await archiveBondLedgerFile(new File(['xlsx'], '台账.xlsx'), parsed.date)).reportDate, parsed.date);
    assert.deepEqual(calls, ['parse', 'terminate', 'request']);
    await assert.rejects(archiveBondLedgerFile(new File(['xlsx'], '台账.xlsx'), '2026-09-20'), /报表日必须为/);
    assert.equal(calls.filter(value => value === 'request').length, 1);
  } finally { globalThis.Worker = previousWorker; }
});

test('local parse failure is surfaced and never sends a request', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('must not upload'));
  const previousWorker = globalThis.Worker;
  let terminated = false;
  globalThis.Worker = class {
    postMessage() { queueMicrotask(() => this.onmessage({ data: { error: '缺少标准列' } })); }
    terminate() { terminated = true; }
  };
  try {
    await assert.rejects(archiveBondLedgerFile(new File(['xlsx'], '台账.xlsx')), /缺少标准列/);
    assert.equal(terminated, true);
  } finally { globalThis.Worker = previousWorker; }
});
