import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { gatewayContext, readBindingContext, CONTEXT_HEADER } from '../src/lib/server/gateway-context.ts';

const user = { id: 'auth0|test', auth0Id: 'auth0|test', email: 'test@18.cn', issuedAt: 1, expiresAt: 9999999999,
  authorization: { name: '测试账号', department: '', roles: [], permissions: ['financing.project:read'], mode: 'enforce', picture: '' } };

test('application hooks consume only Gateway metadata and never reconstruct identity from HTTP headers', () => {
  for (const env of [{}, { ACCESS_MODE: 'legacy' }, { user }, { headers: { [CONTEXT_HEADER]: JSON.stringify({ version: 1, user }) } }]) assert.throws(() => gatewayContext(env), { status: 503 });
  assert.deepEqual(gatewayContext({ GATEWAY_CONTEXT: { version: 1, user: null } }), { user: null, permissions: [] });
  assert.deepEqual(gatewayContext({ GATEWAY_CONTEXT: { version: 1, user } }), { user, permissions: ['financing.project:read'] });
});

test('only the named private entrypoint parses a versioned context and rejects malformed input', async () => {
  const context = { version: 1, user, choice: { status: 401 } };
  const request = value => new Request('https://dashboard.internal/financing/projects', { headers: { [CONTEXT_HEADER]: Buffer.from(value).toString('base64url') } });
  assert.equal(readBindingContext(request(JSON.stringify(context))).user.email, 'test@18.cn');
  for (const value of ['null', '{}', 'invalid', JSON.stringify({ ...context, version: 2 }), JSON.stringify({ ...context, user: { email: 'test@18.cn' } })]) assert.throws(() => readBindingContext(request(value)), { status: 503 });
  const source = await readFile(new URL('../worker/entry.ts', import.meta.url), 'utf8');
  assert.match(source, /class GatewayDashboard extends WorkerEntrypoint/);
  assert.match(source, /fetch\(\) \{ return new Response\('Not Found', \{ status: 404 \}\); \}/);
  assert.doesNotMatch(source, /verifyAccess|jwtVerify|authorizeRequest/);
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(config.routes, []); assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(config.hyperdrive.some(item => item.binding === 'AUTHORIZATION_DB'), false);
});
