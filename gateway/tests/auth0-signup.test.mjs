import test from 'node:test';
import assert from 'node:assert/strict';
import registration from '../auth0/actions/eastmoney-registration.cjs';
import synchronization from '../auth0/actions/eastmoney-signup-profile.cjs';

function signup() {
  const calls = { denied: [], app: {} };
  return { event: { connection: { name: 'eastmoney-email' }, user: { email: 'new@18.cn' }, request: { body: { app_metadata: { role: 'admin', eastmoney_signup_profile_pending: false } } } },
    api: { access: { deny: (...args) => calls.denied.push(args) }, user: { setAppMetadata: (key, value) => calls.app[key] = value } }, calls };
}

test('signup requires the profile step using server-controlled metadata without granting business permissions', async () => {
  const { event, api, calls } = signup();
  await registration.onExecutePreUserRegistration(event, api);
  assert.deepEqual(calls, { denied: [], app: { eastmoney_signup_profile_pending: true } });
});

test('signup preserves email-domain restrictions and ignores other connections', async () => {
  const denied = signup(); denied.event.user.email = 'person@example.com';
  await registration.onExecutePreUserRegistration(denied.event, denied.api);
  assert.equal(denied.calls.denied.length, 1); assert.deepEqual(denied.calls.app, {});
  const other = signup(); other.event.connection.name = 'other';
  await registration.onExecutePreUserRegistration(other.event, other.api);
  assert.deepEqual(other.calls, { denied: [], app: {} });
});

function login() {
  const calls = { denied: [], app: [], rendered: [] };
  return { event: { client: { client_id: 'eastmoney' }, connection: { name: 'eastmoney-email' },
    secrets: { EASTMONEY_CLIENT_ID: 'eastmoney', PROFILE_CLIENT_ID: 'profile', PROFILE_CLIENT_SECRET: 'test-secret', PROFILE_FORM_ID: 'form-profile' },
    prompt: { id: 'form-profile', fields: { name: '  张三  ', department: '  资金管理部  ' } },
    user: { user_id: 'auth0|new', user_metadata: {}, app_metadata: { eastmoney_signup_profile_pending: true } } },
    api: { access: { deny: (message) => calls.denied.push(message) }, user: { setAppMetadata: (...args) => calls.app.push(args) },
      redirect: { canRedirect: () => true }, prompt: { render: (...args) => calls.rendered.push(args) } }, calls };
}

test('incomplete signup renders a required profile Form, including unverified new accounts', async () => {
  const { event, api, calls } = login(); event.user.email_verified = false;
  await synchronization.onExecutePostLogin(event, api);
  assert.deepEqual(calls, { denied: [], app: [], rendered: [['form-profile', { fields: { name: '', department: '' } }]] });
  const nonBrowser = login(); nonBrowser.api.redirect.canRedirect = () => false;
  await synchronization.onExecutePostLogin(nonBrowser.event, nonBrowser.api);
  assert.equal(nonBrowser.calls.denied.length, 1); assert.equal(nonBrowser.calls.rendered.length, 0);
});

test('profile completion rejects wrong form IDs and absent, blank, malformed or oversized fields before API access', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected request'); });
  for (const field of ['name', 'department']) for (const value of [undefined, null, '  ', [], {}, 'x'.repeat(101), '<script>', 'a\nb']) {
    const { event, api, calls } = login(); event.prompt.fields[field] = value;
    await synchronization.onContinuePostLogin(event, api);
    assert.equal(calls.denied.length, 1); assert.deepEqual(calls.app, []);
  }
  const wrong = login(); wrong.event.prompt.id = 'other-form';
  await synchronization.onContinuePostLogin(wrong.event, wrong.api);
  assert.equal(wrong.calls.denied.length, 1);
  assert.equal(fetch.mock.callCount(), 0);
});

test('Form completion saves trimmed name and department in Auth0 without username or role writes', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, ...init, body: JSON.parse(init.body) });
    assert.equal(init.redirect, 'manual');
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'test-token' });
    assert.equal(url, 'https://hasbai.eu.auth0.com/api/v2/users/auth0%7Cnew');
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    return Response.json({ name: '张三', nickname: '张三', user_metadata: { name: '张三', department: '资金管理部' } });
  });
  const { event, api, calls } = login();
  event.prompt.fields.role = 'admin'; event.prompt.fields.user_id = 'auth0|someone-else';
  await synchronization.onContinuePostLogin(event, api);
  assert.deepEqual(requests[1].body, { name: '张三', nickname: '张三', user_metadata: { name: '张三', department: '资金管理部' } });
  assert.deepEqual(calls, { denied: [], app: [['eastmoney_signup_profile_pending', false]], rendered: [] });
});

test('existing accounts, unrelated applications and completed profiles perform no management requests or renders', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected request'); });
  for (const mutate of [e => e.user.app_metadata = {}, e => e.user.app_metadata.eastmoney_signup_profile_pending = false,
    e => e.client.client_id = 'other', e => e.connection.name = 'other']) {
    const { event, api, calls } = login(); mutate(event);
    await synchronization.onExecutePostLogin(event, api);
    await synchronization.onContinuePostLogin(event, api);
    assert.deepEqual(calls, { denied: [], app: [], rendered: [] });
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('management failure preserves the pending marker for a later login retry without leaking credentials', async (t) => {
  for (const status of [302, 400, 401, 403, 429, 500]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response('test-secret', { status }));
    const { event, api, calls } = login();
    await synchronization.onContinuePostLogin(event, api);
    assert.deepEqual(calls, { denied: ['暂时无法保存注册资料，请稍后重新登录'], app: [], rendered: [] });
    mock.mock.restore();
  }
});
