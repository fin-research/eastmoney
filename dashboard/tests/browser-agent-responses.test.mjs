import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'tsx/esm/api';
register();
const { proxyAgentResponses } = await import('../src/lib/server/agent-responses.ts');
const { AI_GATEWAY_MODEL } = await import('../src/lib/agent-model.ts');
const user = { auth0Id: 'auth0|test' };
const env = { CLOUDFLARE_ACCOUNT_ID: 'account', AI_GATEWAY_ID: 'default', CF_AIG_TOKEN: 'server-secret' };
function request(body, headers = {}) {
  return new Request('https://eastmoney.hasbai.xyz/api/ai/responses', {
    method: 'POST', headers: { origin: 'https://eastmoney.hasbai.xyz', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
const valid = { model: AI_GATEWAY_MODEL, input: [{ role: 'user', content: 'hello' }], stream: true };

test('authenticated same-origin browser request streams via the fixed Gateway model', async () => {
  let outgoing;
  const response = await proxyAgentResponses(request(valid), env, user, async (url, init) => {
    outgoing = { url, init };
    return new Response('data: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /response.completed/);
  assert.match(outgoing.url, /custom-codex\/responses$/);
  assert.equal(outgoing.init.headers['cf-aig-authorization'], 'Bearer server-secret');
  assert.equal(JSON.parse(outgoing.init.body).model, 'gpt-6-luna');
  assert.equal(JSON.parse(outgoing.init.headers['cf-aig-metadata']).ai_model, 'gpt-6-luna');
  assert.equal(JSON.parse(outgoing.init.body).store, false);
  assert.equal(response.headers.get('cache-control'), 'private, no-store, no-transform');
  assert.equal(response.headers.has('cf-aig-authorization'), false);
});

test('anonymous, cross-origin, model override and remote state are rejected before upstream', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({}); };
  assert.equal((await proxyAgentResponses(request(valid), env, null, fetcher)).status, 401);
  assert.equal((await proxyAgentResponses(request(valid, { origin: 'https://elsewhere.example' }), env, user, fetcher)).status, 403);
  assert.equal((await proxyAgentResponses(request({ ...valid, model: 'other' }), env, user, fetcher)).status, 400);
  assert.equal((await proxyAgentResponses(request({ ...valid, model: 'gpt-5.6-luna' }), env, user, fetcher)).status, 400);
  assert.equal((await proxyAgentResponses(request({ ...valid, previous_response_id: 'response-id' }), env, user, fetcher)).status, 400);
  assert.equal((await proxyAgentResponses(request({ ...valid, tools: [{ type: 'web_search' }] }), env, user, fetcher)).status, 400);
  assert.equal(calls, 0);
});
