import test from 'node:test';
import assert from 'node:assert/strict';
import { serveResearchReport } from '../report.mjs';

test('named report entry serves the canonical README for GET/HEAD only', async () => {
  const requests = [];
  const assets = { fetch: async request => {
    requests.push(request);
    assert.equal(new URL(request.url).pathname, '/README.md');
    return new Response('# Research', { headers: { 'Content-Type': 'text/markdown' } });
  } };
  const get = await serveResearchReport(new Request('https://quant/REPORT.html'), assets);
  assert.equal(get.status, 200);
  assert.match(get.headers.get('Content-Type'), /^text\/markdown/);
  assert.equal(get.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(get.headers.get('Cache-Control'), 'no-store, private');
  assert.match(await get.text(), /Research/);
  const head = await serveResearchReport(new Request('https://quant/REPORT.html', { method: 'HEAD' }), assets);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const path of ['/manifest.json', '/REPORT.html?x=1', '/', '/public/REPORT.html']) {
    assert.equal((await serveResearchReport(new Request('https://quant'+path), assets)).status, 404);
  }
  assert.equal((await serveResearchReport(new Request('https://quant/REPORT.html', { method: 'POST' }), assets)).status, 405);
  assert.equal(requests.length, 2);
});

test('missing or redirected asset fails closed', async () => {
  for (const status of [301, 404, 500]) {
    assert.equal((await serveResearchReport(new Request('https://quant/REPORT.html'), { fetch: async () => new Response(null, { status }) })).status, 503);
  }
});
