import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchBriefingNewsDetails } from '../src/lib/server/market-briefing.ts';
const date = '2026-10-23';
const items = Array.from({ length: 40 }, (_, i) => ({ sentimentId: `news-${i}`, title: `新闻${i}`, time: `${date}T15:00:00+08:00`, tags: ['债市'], content: '正文' }));
function harness(rows = items, override) {
  const calls = [];
  const env = { DATA: { fetch: async request => {
    const url = new URL(request.url); calls.push(url);
    assert.equal(url.pathname, '/data/news');
    assert.equal(url.searchParams.get('detail'), 'true');
    assert.equal(url.searchParams.get('pageSize'), '10');
    return override?.(url) ?? Response.json(rows.slice(Number(url.searchParams.get('offset')), Number(url.searchParams.get('offset')) + 10));
  } } };
  return { env, calls };
}
test('40条正文以四批顺序读取，固定截止时间且不创建子Workflow', async () => {
  const h = harness();
  assert.deepEqual(await fetchBriefingNewsDetails(h.env, date), items);
  assert.deepEqual(h.calls.map(url => url.searchParams.get('offset')), ['0', '10', '20', '30']);
  assert.equal(new Set(h.calls.map(url => url.searchParams.get('endTime'))).size, 1);
});
test('不足一批即停止，空列表和空正文保持原始语义', async () => {
  const h = harness(items.slice(0, 13));
  assert.equal((await fetchBriefingNewsDetails(h.env, date)).length, 13);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(await fetchBriefingNewsDetails(harness([]).env, date), []);
  assert.equal((await fetchBriefingNewsDetails(harness([{ ...items[0], content: '' }]).env, date))[0].content, '');
});
test('失败不返回部分结果，不在adapter重试，重复记录和缺正文报错', async () => {
  const h = harness(items, url => Number(url.searchParams.get('offset')) === 10 ? new Response('failed', { status: 503 }) : undefined);
  await assert.rejects(fetchBriefingNewsDetails(h.env, date), /HTTP 503/);
  assert.equal(h.calls.length, 2);
  await assert.rejects(fetchBriefingNewsDetails(harness([...items.slice(0, 10), items[0]]).env, date), /重复记录/);
  const { content, ...missing } = items[0];
  await assert.rejects(fetchBriefingNewsDetails(harness([missing]).env, date));
});
test('已取消请求不发起批次', async () => {
  const h = harness(); const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(fetchBriefingNewsDetails(h.env, date, controller.signal), /cancelled/);
  assert.equal(h.calls.length, 0);
});
