import test from 'node:test';
import assert from 'node:assert/strict';
import { withAuthInteraction, installAuthInteraction, requireClientLogin, requestLogin } from '../src/lib/auth-client.ts';
import { loginUrl, pageRequiresLogin } from '../src/lib/auth-navigation.ts';
import { dashboardAccessFailure, dashboardRequiresLogin } from '../src/lib/server/dashboard-access.ts';
import { AccessError } from '../src/lib/server/access.ts';
import { createClientSession } from '../src/lib/client-session.ts';

const current = 'https://eastmoney.hasbai.xyz/fund-report?upload=1#history';
const anonymous = { user: null, account: null, _roles: [], role: '', picture: '', permissions: [], expiresAt: null };
const authenticated = { ...anonymous, user: { email: 'test@18.cn' }, _roles:['admin'], permissions: ['credit.institution:read', 'fund.report:upload'], expiresAt: Date.now() / 1000 + 3600 };

test('anonymous writes wait for login, recheck permission and send exactly once', async () => {
  const state = createClientSession(anonymous);
  let requests = 0, logins = 0;
  const cleanup = installAuthInteraction({ session: state, login: async () => { logins++; state.seed(authenticated); return true; }, error: assert.fail });
  try {
    const fetcher = withAuthInteraction(async () => { requests++; return Response.json({ ok: true }); }, () => current);
    assert.equal((await fetcher('/api/fund-report', { method: 'POST', body: 'file' })).status, 200);
    assert.equal(requests, 1); assert.equal(logins, 1);
  } finally { cleanup(); }
});

test('cancelled login and denied permissions never send the protected operation', async () => {
  for (const session of [anonymous, { ...authenticated, _roles:[], permissions: [] }]) {
    const errors = [];
    const cleanup = installAuthInteraction({ session: createClientSession(session), login: async () => false, error: message => errors.push(message) });
    try {
      const fetcher = withAuthInteraction(async () => assert.fail('must not send'), () => current);
      assert.equal((await fetcher('/api/fund-report', { method: 'POST' })).status, 403);
      assert.equal(errors.length, session.user ? 1 : 0);
    } finally { cleanup(); }
  }
});

test('expired read and SvelteKit login redirect recover with one retry; writes are never replayed', async () => {
  for (const scenario of ['read', 'data', 'write']) {
    const state = createClientSession(authenticated);
    let requests = 0, logins = 0;
    const cleanup = installAuthInteraction({ session: state, login: async () => { logins++; state.seed(authenticated); return true; }, error: () => {} });
    try {
      const fetcher = withAuthInteraction(async () => {
        requests++;
        if (requests === 2) return Response.json({ ok: true });
        return scenario === 'data' ? Response.json({ type: 'redirect', location: '/auth/login?returnTo=%2Fprofile' }) : new Response(null, { status: 401 });
      }, () => current);
      const response = await fetcher(scenario === 'data' ? '/credit-workbench/__data.json' : '/api/fund-report', { method: scenario === 'write' ? 'POST' : 'GET' });
      assert.equal(response.status, scenario === 'write' ? 401 : 200);
      assert.equal(requests, scenario === 'write' ? 1 : 2); assert.equal(logins, 1);
    } finally { cleanup(); }
  }
});

test('public and external requests, session bootstrap and unrelated errors are not intercepted', async () => {
  const cleanup = installAuthInteraction({ session: createClientSession(anonymous), login: async () => assert.fail('must not login'), error: assert.fail });
  try {
    for (const [url, status] of [['/api/market-report', 200], ['/auth/permissions', 401], ['https://external.test/api', 401], ['/api/market-report', 503]]) {
      const response = Response.json({ status }, { status });
      assert.equal(await withAuthInteraction(async () => response, () => current)(url), response);
    }
  } finally { cleanup(); }
});

test('private page guard covers child routes and agrees with the server', () => {
  for (const path of ['/fund-report', '/market-briefing/unknown', '/profile-other', '/trading-research-other', '/profile', '/profile/__data.json', '/trading-research', '/trading-research/credit', '/credit-workbench', '/credit-workbench/calendar', '/credit-workbench/weekly', '/credit-workbench/assistant', '/credit%2dworkbench/__data.json', '/credit-assistant', '/trading%2dresearch/credit']) {
    assert.equal(pageRequiresLogin(path), true, path);
    assert.equal(dashboardRequiresLogin(new Request(`https://eastmoney.hasbai.xyz${path}`)), true, path);
  }
  for (const path of ['/', '/market-briefing', '/market-briefing/text', '/market-briefing/__data.json', '/market-briefing/text/', '/auth/login', '/auth/callback', '/auth/logout', '/financing/login', '/auth/verify-email']) assert.equal(pageRequiresLogin(path), false, path);
  assert.equal(dashboardRequiresLogin(new Request('https://eastmoney.hasbai.xyz/api/profile')), true);
});

test('page 401 redirects to login while API 401 keeps its status and login-required detail', async () => {
  const page = dashboardAccessFailure(new Request('https://eastmoney.hasbai.xyz/profile?tab=security', { headers: { Accept: 'text/html' } }), new AccessError(401, '请先登录'));
  assert.equal(page.status, 303);
  assert.equal(page.headers.get('location'), loginUrl('/profile?tab=security'));
  const api = dashboardAccessFailure(new Request('https://eastmoney.hasbai.xyz/api/fund-report', { method: 'POST' }), new AccessError(401, '请先登录'));
  assert.equal(api.status, 401);
  assert.equal((await api.json()).detail, '请先登录');
  const denied = dashboardAccessFailure(new Request('https://eastmoney.hasbai.xyz/profile', { headers: { Accept: 'text/html' } }), new AccessError(403, '无权限'));
  assert.equal(denied.status, 403);
});

test('login destinations preserve local queries and reject encoded loops or external URLs', () => {
  for (const path of ['//evil.test', '/%2F%2Fevil.test', '/%61uth/login', '/a/../auth/login', '/%63dn-cgi/access/logout', '/a%5cb', '/%ZZ']) assert.equal(loginUrl(path), '/auth/login?returnTo=%2F');
  assert.equal(loginUrl('/profile?tab=email'), '/auth/login?returnTo=%2Fprofile%3Ftab%3Demail');
});

test('preflight login checks fail closed and recover in-place through the installed dialog', async () => {
  let logins = 0;
  const state = createClientSession(anonymous);
  const cleanup = installAuthInteraction({ session: state, login: async () => { logins++; state.seed(authenticated); return true; }, error: assert.fail });
  try {
    assert.equal(await requireClientLogin('/fund-report?upload=1', state), true);
    assert.equal(await requestLogin('/profile'), true);
    assert.equal(logins, 2);
    await assert.rejects(requireClientLogin('/profile', createClientSession(null, async () => { throw Error('登录状态暂时无法读取'); })), /登录状态暂时无法读取/);
  } finally { cleanup(); }
});

test('cancelled data navigation stays on the original route and enhanced writes receive a failure result', async () => {
  const state = createClientSession(authenticated);
  const cleanup = installAuthInteraction({ session: state, login: async () => false, error() {} });
  try {
    const fetcher = withAuthInteraction(async () => new Response(null, { status: 401 }), () => current);
    const response = await fetcher('/credit-workbench/__data.json');
    assert.deepEqual(await response.json(), { type: 'redirect', location: '/fund-report?upload=1#history' });
    state.seed(authenticated);
    const action = await fetcher('/financing/projects?/createProject', { method: 'POST', headers: { 'x-sveltekit-action': 'true' } });
    assert.equal((await action.json()).type, 'failure');
  } finally { cleanup(); }
});
