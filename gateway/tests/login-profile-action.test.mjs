import assert from 'node:assert/strict';
import test from 'node:test';
import action from '../auth0/actions/login-claims.cjs';

function fixture() {
  const calls = { denied: [], rendered: [], claims: {} };
  return {
    event: {
      client: { client_id: '16vMxoYpr5AdPRiW1PkwIiHuRWszii6m' },
      organization: { id: 'org_6yvoRRCkzk3eGkBS' }, connection: { name: 'eastmoney-email' },
      authorization: { roles: ['authenticated'] },
      secrets: { PROFILE_FORM_ID: 'profile-form', PROFILE_CLIENT_ID: 'fixture', PROFILE_CLIENT_SECRET: 'fixture-secret' },
      user: { user_id: 'auth0|profile', email: 'test@18.cn', email_verified: true, name: '旧姓名', user_metadata: {} },
      prompt: { id: 'profile-form', fields: { name: ' 新姓名 ', department: ' 资金部 ' } },
    },
    api: { access: { deny: message => calls.denied.push(message) },
      redirect: { canRedirect: () => true }, prompt: { render: (...args) => calls.rendered.push(args) },
      accessToken: { setCustomClaim: (key, value) => { calls.claims[key] = value; } } }, calls,
  };
}

test('missing organization profile suspends website and MCP login without signing claims', async () => {
  for (const client of ['16vMxoYpr5AdPRiW1PkwIiHuRWszii6m', 'tpc_a7WD9gnnwfLwzjTcG3aN8m']) {
    const f = fixture(); f.event.client.client_id = client; f.event.user.email_verified = false;
    await action.onExecutePostLogin(f.event, f.api);
    assert.deepEqual(f.calls, { denied: [], claims: {}, rendered: [['profile-form', { fields: { name: '', department: '' } }]] });
  }
  const f = fixture(); f.api.redirect.canRedirect = () => false;
  await action.onExecutePostLogin(f.event, f.api);
  assert.equal(f.calls.denied.length, 1); assert.deepEqual(f.calls.claims, {});
});

test('complete profiles, other organizations and other connections skip the profile step', async () => {
  for (const change of [f => { f.event.user.user_metadata.department = '研究部'; },
    f => { f.event.organization.id = 'other'; }, f => { f.event.connection.name = 'google-oauth2'; }]) {
    const f = fixture(); change(f);
    await action.onExecutePostLogin(f.event, f.api);
    assert.deepEqual(f.calls.rendered, []); assert.deepEqual(f.calls.denied, []);
    assert.equal(f.calls.claims.username, '旧姓名');
  }
});

test('profile continuation validates its origin, fields and blocked state before any management request', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected management call'); });
  for (const change of [f => { f.event.prompt.id = 'wrong'; }, f => { f.event.organization.id = 'other'; },
    f => { f.event.connection.name = 'google-oauth2'; }, f => { f.event.user.blocked = true; },
    ...['name', 'department'].flatMap(field => [undefined, [], ' ', '<bad>', 'x'.repeat(101)].map(value =>
      f => { f.event.prompt.fields[field] = value; }))]) {
    const f = fixture(); change(f);
    await action.onContinuePostLogin(f.event, f.api);
    assert.equal(f.calls.denied.length, 1); assert.deepEqual(f.calls.claims, {});
  }
});

test('successful profile save signs current website and MCP claims using returned profile data', async t => {
  for (const client of ['16vMxoYpr5AdPRiW1PkwIiHuRWszii6m', 'tpc_2WkMuCZoYq49waTvQZjJHK']) {
    const requests = [];
    const mock = t.mock.method(globalThis, 'fetch', async (url, init) => {
      requests.push({ url, ...init }); assert.equal(init.redirect, 'manual');
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'fixture-token' });
      assert.equal(url, 'https://hasbai.eu.auth0.com/api/v2/users/auth0%7Cprofile');
      assert.deepEqual(JSON.parse(init.body), { name: '新姓名', user_metadata: { department: '资金部' } });
      return Response.json({ name: '新姓名', user_metadata: { department: '资金部' } });
    });
    const f = fixture(); f.event.client.client_id = client;
    f.event.prompt.fields.role = 'admin'; f.event.prompt.fields.user_id = 'auth0|other';
    await action.onContinuePostLogin(f.event, f.api);
    assert.equal(requests.length, 2); assert.deepEqual(f.calls.denied, []);
    assert.equal(f.calls.claims.username, '新姓名'); assert.equal(f.calls.claims.department, '资金部');
    assert.deepEqual(f.calls.claims._roles, ['authenticated']);
    if (client.startsWith('tpc_')) assert.equal(f.calls.claims['https://eastmoney.hasbai.xyz/identity'].username, '新姓名');
    mock.mock.restore();
  }
});

test('save errors stop continuation without claims and keep credentials out of denial', async t => {
  for (const response of [() => new Response('fixture-secret', { status: 403 }),
    () => Response.json({ access_token: 'fixture-token' }),
    () => Response.json({ name: 'wrong', user_metadata: {} })]) {
    let calls = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => ++calls === 1
      ? Response.json({ access_token: 'fixture-token' }) : response());
    const f = fixture(); await action.onContinuePostLogin(f.event, f.api);
    assert.deepEqual(f.calls.claims, {});
    assert.deepEqual(f.calls.denied, ['暂时无法保存注册资料，请稍后重新登录']);
    mock.mock.restore();
  }
});

test('saving a profile still rejects unverified email and invalid MCP email domains', async t => {
  t.mock.method(globalThis, 'fetch', async url => url.endsWith('/oauth/token')
    ? Response.json({ access_token: 'fixture-token' })
    : Response.json({ name: '新姓名', user_metadata: { department: '资金部' } }));
  for (const change of [f => { f.event.user.email_verified = false; },
    f => { f.event.client.client_id = 'tpc_2WkMuCZoYq49waTvQZjJHK'; f.event.user.email = 'test@example.com'; }]) {
    const f = fixture(); change(f); await action.onContinuePostLogin(f.event, f.api);
    assert.equal(f.calls.denied.length, 1);
    assert.equal(f.calls.claims['https://eastmoney.hasbai.xyz/identity'], undefined);
  }
  const f = fixture(); f.event.user.blocked = true;
  await action.onExecutePostLogin(f.event, f.api);
  assert.deepEqual(f.calls.rendered, []); assert.deepEqual(f.calls.claims, {});
});
