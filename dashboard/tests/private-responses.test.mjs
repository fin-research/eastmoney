import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === '$app/server') return { shortCircuit: true, url: 'data:text/javascript,export function getRequestEvent(){throw new Error("No request context")}' };
  if (specifier.startsWith('$lib/')) return next(new URL('../src/lib/' + specifier.slice(5) + (/\.(ts|js)$/.test(specifier) ? '' : '.ts'), import.meta.url).href, context);
  return next(specifier, context);
} });
const { GET } = await import('../src/routes/financing/data/token/+server.ts');
const { handle } = await import('../src/hooks.server.ts');

const user = { id: 'a', auth0Id: 'auth0|a', email: 'a@18.cn', issuedAt: 1, expiresAt: 9999999999,
  authorization: { name: 'a', roles: [], permissions: ['financing.data:read'], mode: 'enforce', picture: '' } };

test('data administration endpoint is returned only as a private, uncached response', async () => {
  const response = await GET({ url: new URL('https://example.test/financing/data/token') });
  assert.equal(response.headers.get('cache-control'), 'no-store, private');
  assert.equal(response.headers.get('vary'), 'Cookie');
  assert.match((await response.json()).dataApiUrl, /^https:\/\/example\.test\/financing\/data\/api$/);
});

test('each request reads its own Gateway context, marks authenticated responses private and always closes the database', async () => {
  let closed = 0;
  const run = (context) => {
    const event = { locals: {}, platform: { env: { GATEWAY_CONTEXT: context } }, url: new URL('https://example.test/financing/projects'),
      request: new Request('https://example.test/financing/projects') };
    return handle({ event, resolve: async () => { event.locals.database = { close: async () => { closed += 1; } }; return new Response('ok'); } });
  };
  const signedIn = await run({ version: 1, user });
  assert.equal(signedIn.headers.get('cache-control'), 'no-store, private');
  const anonymous = await run({ version: 1, user: null });
  assert.equal(anonymous.headers.get('cache-control'), null);
  assert.equal(closed, 2);
  assert.equal((await run(undefined)).status, 503);
});
