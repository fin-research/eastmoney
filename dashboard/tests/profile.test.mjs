import assert from 'node:assert/strict';
import test from 'node:test';
import { identityJson, identityRequest } from '../src/lib/server/gateway-client.ts';
import { readProfileJson } from '../src/lib/server/profile.ts';

test('profile and role configuration use the private Gateway binding with the already verified identity', async () => {
  const user = { id: 'auth0|test', auth0Id: 'auth0|test', email: 'test@18.cn' };
  const calls = [];
  const env = { IDENTITY: { async fetch(request) { calls.push(request); return Response.json({ success: true }); } } };
  assert.deepEqual(await identityJson(env, '/roles/configurations', user, { roleId: 'rol_Test', version: 'v', permissions: [] }), { success: true });
  const request = calls[0];
  assert.equal(new URL(request.url).hostname, 'identity.internal');
  assert.equal(request.headers.has('Authorization'), false); assert.equal(request.headers.has('Cookie'), false);
  assert.equal(JSON.parse(Buffer.from(request.headers.get('X-Eastmoney-Gateway-Context'), 'base64url').toString()).user.auth0Id, 'auth0|test');
  assert.deepEqual(await request.json(), { roleId: 'rol_Test', version: 'v', permissions: [] });
});

test('Gateway errors retain their status and profile responses retain logout cookies', async () => {
  const env = { IDENTITY: { fetch: async () => Response.json({ detail: '版本冲突' }, { status: 409 }) } };
  await assert.rejects(identityJson(env, '/roles/configurations'), { status: 409, message: '版本冲突' });
  env.IDENTITY.fetch = async () => Response.json({ logout: true }, { headers: { 'Set-Cookie': '__Host-eastmoney_session=; Path=/; Max-Age=0' } });
  const response = await identityRequest(env, '/api/profile');
  assert.ok(response.headers.get('Set-Cookie').includes('Max-Age=0'));
});

test('profile request parsing retains its size limit before private forwarding', async () => {
  assert.deepEqual(await readProfileJson(new Request('https://site.test', { method: 'POST', body: '{"action":"name","name":"测试"}' }), 4096), { action: 'name', name: '测试' });
  await assert.rejects(readProfileJson(new Request('https://site.test', { method: 'POST', body: 'x'.repeat(4097) }), 4096), { status: 413 });
});
