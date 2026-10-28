import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchReport, saveMarketReport } from '../src/api.ts';
import { snapshot } from './fixtures/market-resources.mjs';

for (const [date, now] of [['2026-08-25', '2026-08-25'], ['2026-08-25', '2026-09-16'], ['', '2026-09-16']]) {
  test(`报告只GET归档：date=${date || 'auto'} now=${now}`, async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ ...snapshot(), focus_text: '归档判断', finalized_at: '2026-08-25T09:00:00Z' }));
    const { report } = await fetchReport(date, true, undefined, now);
    assert.equal(report.focus_text, '归档判断');
    assert.equal(globalThis.fetch.mock.calls.length, 1);
    assert.equal(globalThis.fetch.mock.calls[0].arguments[0], `/api/market-report${date ? '?date='+date : ''}`);
    assert.equal(globalThis.fetch.mock.calls[0].arguments[1].method, 'GET');
  });
}
for (const status of [404, 503]) {
  test(`缺失或损坏报告${status}明确失败，不回退Data`, async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: '尚无市场点评定稿', error: {code:'REPORT_NOT_FINALIZED'} }, { status }));
    await assert.rejects(fetchReport('2026-08-25', false), /尚无市场点评定稿/);
    assert.equal(globalThis.fetch.mock.calls.length, 1);
  });
}
test('错误日期、未定稿和损坏快照不能显示为成功报告', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(snapshot()));
  await assert.rejects(fetchReport('2026-08-25', false), /尚未生成/);
  await assert.rejects(fetchReport('2026-08-24', false), /日期/);
  globalThis.fetch.mock.mockImplementation(async () => Response.json({}));
  await assert.rejects(fetchReport('2026-08-25', false), /Schema/);
});
test('兼容保存接口只提交规范数据和聚焦', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...snapshot(), focus_text:'定稿', finalized_at:'2026-08-25T09:00:00Z' }));
  await saveMarketReport(snapshot(), '定稿');
  const [url, init] = globalThis.fetch.mock.calls[0].arguments;
  const payload = JSON.parse(init.body);
  assert.equal(url, '/api/market-report?date=2026-08-25');
  assert.equal(init.method, 'PUT');
  assert.equal(payload.focusText, '定稿');
  assert.equal('focus_text' in payload.report, false);
});
