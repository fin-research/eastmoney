import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createClientSession } from '../src/lib/client-session.ts';
import { createClientNavigationGuard, requireClientLogin } from '../src/lib/auth-client.ts';
import { publicSession } from '../src/lib/identity.ts';
import { pagePermission, ROUTE_PERMISSIONS } from '../src/lib/route-permissions.ts';
import { PERMISSION_CODES } from '../src/lib/permissions.ts';

const origin = 'https://eastmoney.hasbai.xyz';
const anonymous = { user: null, account: null, _roles: [], role: '', picture: '', permissions: [], expiresAt: null };
const authenticated = {
  user: { id: 'access-test', auth0Id: 'auth0|test', email: 'test@18.cn' },
  account: { name: '测试账号', department: '测试' },
  _roles: ['测试角色'], role: '测试角色', picture: '',
  permissions: [...PERMISSION_CODES], expiresAt: 2000,
};
const navigation = (path, id = '/trading-research/[view]') => ({
  to: { url: new URL(path, origin), route: { id } },
  cancel() { this.cancelled = true; },
});
function setupGuard(state) {
  const calls = { resumed: [], errors: [], logins: [] };
  const guard = createClientNavigationGuard(state, {
    origin: () => origin,
    navigate: async url => calls.resumed.push(url.href),
    error: message => calls.errors.push(message), login: path => { calls.logins.push(path); },
  });
  function visit(path, id) {
    const event = navigation(path, id);
    event.cancel = () => { event.cancelled = true; };
    guard(event);
    return event;
  }
  return { calls, visit };
}

test('SSR bootstrap allows repeated tab switches and upload preflight without requests, cancelling navigation or restarting preloads', async () => {
  let requests = 0;
  const state = createClientSession(authenticated, async () => { requests++; throw Error('unnecessary request'); }, () => 1000000);
  const { calls, visit } = setupGuard(state);
  for (const path of ['/trading-research/research', '/trading-research/market-hotspots', '/trading-research/policy-tracking', '/trading-research/research']) {
    assert.equal(visit(path).cancelled, undefined);
  }
  assert.equal(visit('/financing/projects', '/financing/projects').cancelled, undefined);
  assert.equal(await requireClientLogin('/fund-report?upload=1', state), true);
  assert.deepEqual(await state.load(), authenticated, 'root mount also reuses SSR');
  assert.equal(requests, 0);
  assert.deepEqual(calls, { resumed: [], errors: [], logins: [] });
});

test('public bootstrap, navigation and menu subscribers share one request; the last clicked tab wins', async () => {
  let complete; let requests = 0;
  const response = new Promise(resolve => { complete = resolve; });
  const state = createClientSession(null, async (force) => {
    requests++; assert.equal(force, false); return response;
  }, () => 1000000);
  const values = [];
  const unsubscribe = state.subscribe(value => values.push(value));
  const mount = state.load();
  const { calls, visit } = setupGuard(state);
  assert.equal(visit('/trading-research/research').cancelled, true);
  assert.equal(visit('/trading-research/market-hotspots').cancelled, true);
  assert.equal(state.load(), mount);
  complete(authenticated);
  await mount; await setImmediate();
  assert.equal(requests, 1);
  assert.deepEqual(calls.resumed, [origin + '/trading-research/market-hotspots']);
  assert.equal(visit('/trading-research/policy-tracking').cancelled, undefined);
  assert.deepEqual(values.at(-1), authenticated);
  unsubscribe();
});

test('public or external navigation supersedes a pending protected navigation', async () => {
  for (const [path, id] of [['/', '/'], ['https://other.test/', null]]) {
    let complete;
    const state = createClientSession(null, () => new Promise(resolve => { complete = resolve; }), () => 1000000);
    const { calls, visit } = setupGuard(state);
    visit('/trading-research/research');
    assert.equal(visit(path, id).cancelled, undefined);
    complete(authenticated); await state.load(); await setImmediate();
    assert.deepEqual(calls, { resumed: [], errors: [], logins: [] });
  }
});

test('anonymous state is cached and opens login without a session request; denied roles and unknown routes stay closed', () => {
  let requests = 0;
  const fetcher = async () => { requests++; throw Error('unexpected'); };
  const anon = setupGuard(createClientSession(anonymous, fetcher));
  assert.equal(anon.visit('/profile?tab=security#details', '/profile').cancelled, true);
  assert.deepEqual(anon.calls.logins, ['/profile?tab=security#details']);
  const restricted = setupGuard(createClientSession({ ...authenticated, permissions: ['research.workspace:read'] }, fetcher, () => 1000000));
  assert.equal(restricted.visit('/trading-research/research').cancelled, undefined);
  assert.equal(restricted.visit('/trading-research/market-hotspots').cancelled, true);
  assert.equal(restricted.visit('/unknown', '/unknown').cancelled, true);
  assert.equal(restricted.calls.errors.length, 2);
  assert.deepEqual(restricted.calls.logins, []);
  assert.equal(requests, 0);
});

test('expired snapshots refresh once, handle logout and never authorize with stale permissions on upstream failure', async () => {
  for (const status of [200, 503]) {
    let requests = 0;
    const state = createClientSession(authenticated, async () => {
      requests++; if (status !== 200) throw new Error('unavailable'); return anonymous;
    }, () => 2000000);
    const { calls, visit } = setupGuard(state);
    assert.equal(visit('/trading-research/research').cancelled, true);
    assert.equal(visit('/trading-research/policy-tracking').cancelled, true);
    await setImmediate();
    assert.equal(requests, 1);
    assert.deepEqual(calls.resumed, []);
    assert.equal(calls.logins.length, status === 200 ? 1 : 0);
    assert.equal(calls.errors.length, status === 503 ? 1 : 0);
    if (status === 503) assert.equal(state.current(), null);
  }
});

test('permission changes can refresh the shared snapshot explicitly without refreshing unrelated page data', async () => {
  let requests = 0;
  const updated = { ...authenticated, permissions: ['account.profile:read'] };
  const state = createClientSession(authenticated, async () => { requests++; return updated; }, () => 1000000);
  await Promise.all([state.load(true), state.load(true)]);
  assert.equal(requests, 1);
  assert.deepEqual(state.current(), updated);
  assert.equal(setupGuard(state).visit('/trading-research/research').cancelled, true);
});

test('an already-expired bootstrap response redirects once instead of entering a refresh/navigation loop', async () => {
  let requests = 0;
  const state = createClientSession(null, async () => { requests++; return authenticated; }, () => 2000000);
  const { calls, visit } = setupGuard(state);
  visit('/trading-research/research');
  await state.load(); await setImmediate();
  assert.deepEqual(state.current(), anonymous);
  assert.deepEqual(calls.resumed, []);
  assert.deepEqual(calls.logins, ['/trading-research/research']);
  assert.equal(requests, 1);
});

test('a late bootstrap cannot overwrite a newer profile snapshot and separate SSR instances never share state', async () => {
  let complete;
  const state = createClientSession(null, () => new Promise(resolve => { complete = resolve; }), () => 1000000);
  const request = state.load();
  state.seed(authenticated);
  complete(anonymous);
  assert.deepEqual(await request, authenticated);
  const other = createClientSession();
  assert.equal(other.current(), null);
});

test('session DTO includes only presentation claims, roles and resolved permissions, never JWTs or metadata', () => {
  const identity = { ...authenticated.user, issuedAt: 1000, expiresAt: 2000,
    token: 'must-not-leak', metadata: { secret: 'must-not-leak' },
    authorization: { ...authenticated.account, roles: authenticated._roles.map(name => ({id: 'test', name})), permissions: authenticated.permissions, mode: 'beta-open', picture: '' } };
  assert.deepEqual(publicSession(identity), { ...authenticated, role: '' });
  assert.deepEqual(publicSession(null), anonymous);
});

test('client GET catalogue preserves static permissions and dynamic aliases', () => {
  for (const [id, methods] of Object.entries(ROUTE_PERMISSIONS)) {
    if (!methods.GET || id === '/trading-research/[view]' || id === '/credit-workbench/[[view]]') continue;
    assert.equal(pagePermission(id, id), methods.GET);
  }
  for (const [path, permission] of [['/trading-research/secondary-bond-pool', 'bond.ledger:read'], ['/trading%2dresearch/credit', 'credit.institution:read'], ['/trading-research/credit-assistant/__data.json', 'login']]) {
    assert.equal(pagePermission(path, '/trading-research/[view]'), permission);
  }
});

test('popup login resumes the requested SPA route once and rechecks newly acquired permissions', async () => {
  for (const permissions of [authenticated.permissions, []]) {
    const state = createClientSession(anonymous, async () => assert.fail('snapshot already seeded'), () => 1000000);
    const resumed = [], errors = [];
    const guard = createClientNavigationGuard(state, {
      origin: () => origin, navigate: async url => resumed.push(url.pathname), error: value => errors.push(value),
      login: async () => { state.seed({ ...authenticated, permissions }); return true; },
    });
    let cancelled = 0;
    guard({ to: { url: new URL('/trading-research/research', origin), route: { id: '/trading-research/[view]' } }, cancel: () => cancelled++ });
    await setImmediate();
    assert.equal(cancelled, 1); assert.equal(resumed.length, permissions.length ? 1 : 0); assert.equal(errors.length, permissions.length ? 0 : 1);
  }
});

test('ordinary SSR refresh preserves login permissions, while a new token replaces the snapshot', () => {
  const state=createClientSession(authenticated,async()=>{throw Error('no session fetch expected')},()=>1000000);
  state.seedFromServer({...authenticated,permissions:[]});
  assert.deepEqual(state.current().permissions,authenticated.permissions);
  state.seedFromServer({...authenticated,expiresAt:authenticated.expiresAt+60,permissions:['account.profile:read']});
  assert.deepEqual(state.current().permissions,['account.profile:read']);
  state.seedFromServer(anonymous);assert.equal(state.current().user,null);
});
