import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionFromJwt, withBearer } from '../src/lib/bearer-auth.ts';
import { AuthenticationError } from '@auth0/auth0-spa-js';
const jwt = claims => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const claims = { sub: 'auth0|test', username: '测试', email: 'test@18.cn', role: 'database-role', _roles: ['admin', 'handler'], department: '业务', picture: 'https://example.com/avatar', exp: 2000 };
test('presentation uses the new claims without role IDs or legacy namespaced fallbacks', () => {
  const value = sessionFromJwt(jwt(claims), ['account.profile:read'], 1000000);
  assert.deepEqual(value._roles, ['admin', 'handler']); assert.equal(value.role, 'database-role'); assert.equal(value.account.name, '测试');
  for (const changed of [{ ...claims, _roles: undefined, roles: ['admin'] }, { ...claims, role: ['admin'] }, { ...claims, _roles: [123] }, { ...claims, email: undefined }, { ...claims, exp: 900 }]) {
    assert.throws(() => sessionFromJwt(jwt(changed), [], 1000000));
  }
});
test('Bearer transport handles Request headers, overrides auth, omits credentials and never leaks to external origins', async () => {
  const calls = []; let reads = 0;
  const fetcher = withBearer(async (input, init) => { calls.push({ input, init }); return new Response(null); }, () => 'https://eastmoney.hasbai.xyz', async () => { reads++; return 'verified-token'; });
  await fetcher(new Request('https://eastmoney.hasbai.xyz/api/profile', { headers: { 'x-test': 'retained', Authorization: 'old' } }));
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer verified-token'); assert.equal(calls[0].init.headers.get('x-test'), 'retained'); assert.equal(calls[0].init.credentials, 'omit');
  await fetcher('https://external.example/api'); assert.equal(reads, 1); assert.equal(calls[1].init, undefined);
  const anonymous = withBearer(async (_, init) => { assert.equal(init.headers.has('Authorization'), false); return new Response(null); }, () => 'https://eastmoney.hasbai.xyz', async () => null);
  await anonymous('/api/profile', { headers: { Authorization: 'legacy' } });
});

test('redirect callback completes and cleans the URL before silent restore and permission validation', async () => {
  const { initializeBearer } = await import('../src/lib/bearer-auth.ts');
  const validToken = jwt({ ...claims, exp: Date.now()/1000 + 3600 });
  const steps = []; let url = new URL('https://eastmoney.hasbai.xyz/auth/callback?code=secret-code&state=state');
  const host = { get location() { return url; }, history: { replaceState(_, __, path) { steps.push('clean'); url = new URL(path, url); } } };
  await initializeBearer(async (path, init) => {
    steps.push('permissions'); assert.equal(path, '/auth/permissions'); assert.equal(init.credentials, 'omit');
    assert.equal(init.headers.Authorization, `Bearer ${validToken}`);
    return Response.json({ permissions: [], updatedAt: 1 });
  }, host, options => {
    assert.equal(options.cacheLocation, 'memory'); assert.equal(options.useRefreshTokens, false);
    return { async handleRedirectCallback() { steps.push('callback'); return { appState: { returnTo: '/financing/projects' } }; },
      async getTokenSilently() { steps.push('silent'); return validToken; },
      loginWithRedirect: async () => assert.fail('must not redirect after successful callback') };
  });
  assert.deepEqual(steps, ['callback', 'clean', 'silent', 'permissions']); assert.equal(url.pathname, '/financing/projects'); assert.equal(url.search, '');
});

test('protected direct entry redirects without waiting for a mounted root dialog and suspends data startup', async () => {
  const { initializeBearer } = await import('../src/lib/bearer-auth.ts');
  let redirected; let finished = false;
  const host = { location: new URL('https://eastmoney.hasbai.xyz/financing/projects?q=keep'), history: {} };
  void initializeBearer(async () => assert.fail('no authenticated permissions request'), host, () => ({
    async getTokenSilently() { throw { error: 'login_required' }; },
    async loginWithRedirect(options) { redirected = options.appState.returnTo; },
  })).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(redirected, '/financing/projects?q=keep'); assert.equal(finished, false);
});

test('anonymous public startup caches silent restoration so public resources do not repeat Auth0 requests', async () => {
  const { initializeBearer } = await import('../src/lib/bearer-auth.ts');
  let restores = 0; let requests = 0;
  const host = { location: new URL('https://eastmoney.hasbai.xyz/market-briefing'), history: {} };
  await initializeBearer(async (_, init) => { requests++; assert.equal(init.headers.has('Authorization'), false); return new Response(null); }, host, () => ({
    async getTokenSilently() { restores++; throw { error: 'login_required' }; },
  }));
  await host.fetch('/data/omo'); await host.fetch('/data/cfets');
  assert.equal(restores, 1); assert.equal(requests, 2);
});

test('callback errors enter a finite login retry state without silent restore or automatic authorization', async () => {
  const { initializeBearer } = await import('../src/lib/bearer-auth.ts');
  let url = new URL('https://eastmoney.hasbai.xyz/auth/callback?error=denied&state=state');
  const host = { get location() { return url; }, history: { replaceState(_, __, path) { url = new URL(path, url); } } };
  await initializeBearer(async () => assert.fail(), host, () => ({
    async handleRedirectCallback() { throw Object.assign(Error('denied'), { appState: { returnTo: '/financing/projects?q=keep' } }); },
    async getTokenSilently() { assert.fail('callback failure must not restore'); },
    async loginWithRedirect() { assert.fail('callback failure must not redirect'); },
  }));
  assert.equal(url.pathname, '/auth/login'); assert.equal(url.searchParams.get('error'), 'callback'); assert.equal(url.searchParams.get('returnTo'), '/financing/projects?q=keep');
});

test('unverified email callback keeps verification feedback and a safe returnTo without leaking OAuth details', async () => {
  const { initializeBearer } = await import('../src/lib/bearer-auth.ts');
  for (const [destination, expected] of [['/financing/projects?q=keep', '/financing/projects?q=keep'], ['https://evil.test', '/']]) {
    let url = new URL('https://eastmoney.hasbai.xyz/auth/callback?error=access_denied&error_description=private&state=private-state');
    const host = { get location() { return url; }, history: { replaceState(_, __, path) { url = new URL(path, url); } } };
    await initializeBearer(async () => assert.fail('must not validate an unauthenticated token'), host, () => ({
      async handleRedirectCallback() { throw new AuthenticationError('access_denied', '请先验证注册邮箱，再返回登录', 'private-state', { returnTo: destination }); },
      async getTokenSilently() { assert.fail('denied callback must not restore'); },
      async loginWithRedirect() { assert.fail('denied callback must wait for explicit retry'); },
    }));
    assert.equal(url.pathname, '/auth/login'); assert.equal(url.searchParams.get('error'), 'callback');
    assert.equal(url.searchParams.get('returnTo'), expected);
    assert.equal(url.searchParams.has('state'), false); assert.equal(url.searchParams.has('error_description'), false);
    assert.ok(!url.href.includes('private'));
    const { getLoginCallbackFailure } = await import('../src/lib/bearer-auth.ts');
    assert.deepEqual(getLoginCallbackFailure(), {kind:'callback',code:'access_denied',message:'请先验证注册邮箱，再返回登录'});
  }
});
test('operational restore failure preserves protected returnTo and leaves public resources available', async () => {
  const { initializeBearer } = await import('../src/lib/bearer-auth.ts');
  let destination;
  const url = new URL('https://eastmoney.hasbai.xyz/financing/projects?q=keep');
  url.assign = path => { destination = new URL(path, url); };
  const host = { location: url, history: {} };
  void initializeBearer(async (_, init) => { assert.equal(init.headers.has('Authorization'), false); return new Response(null); }, host, () => ({
    async getTokenSilently() { throw Error('network outage'); },
    async loginWithRedirect() { assert.fail('operational errors must not auto authorize'); },
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(destination.pathname, '/auth/login'); assert.equal(destination.searchParams.get('returnTo'), '/financing/projects?q=keep');
  assert.equal((await host.fetch('/data/omo')).status, 200); assert.equal((await host.fetch('/api/market-report')).status, 200);
  await assert.rejects(host.fetch('/api/profile'), /登录状态暂时无法恢复/);
  await assert.rejects(host.fetch('/data/choice/css'), /登录状态暂时无法恢复/);
});

test('retired financing login alias stays public until its single client redirect to central login', async () => {
  const { initializeBearer } = await import('../src/lib/bearer-auth.ts');
  const host = { location: new URL('https://eastmoney.hasbai.xyz/financing/login?redirectTo=%2Ffinancing%2Fprojects'), history: {} };
  await initializeBearer(async () => assert.fail('anonymous bootstrap must not request permissions'), host, () => ({
    async getTokenSilently() { throw { error: 'login_required' }; },
    async loginWithRedirect() { assert.fail('alias must not initiate a first Auth0 transaction'); },
  }));
});

test('a direct callback URL without a transaction becomes an explicit retry instead of a blank loop', async () => {
  const { initializeBearer } = await import('../src/lib/bearer-auth.ts');
  let url = new URL('https://eastmoney.hasbai.xyz/auth/callback');
  const host = { get location() { return url; }, history: { replaceState(_, __, path) { url = new URL(path, url); } } };
  await initializeBearer(async () => assert.fail(), host, () => ({
    async handleRedirectCallback() { assert.fail('missing transaction must not call SDK'); },
    async getTokenSilently() { assert.fail('missing transaction must not silently restore'); },
  }));
  assert.equal(url.pathname, '/auth/login'); assert.equal(url.searchParams.get('error'), 'callback');
});
