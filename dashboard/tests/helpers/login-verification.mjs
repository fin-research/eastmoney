import assert from 'node:assert/strict';
import { GenericError } from '@auth0/auth0-spa-js';
import { installDom, loadComponent } from './svelte-dom.mjs';
const host = installDom();
host.history.replaceState({}, '', '/market-briefing?draft=keep');
const { mount, unmount, flushSync } = await import('svelte');
const { initializeBearer } = await import('../../src/lib/bearer-auth.ts');
const { createClientSession } = await import('../../src/lib/client-session.ts');
const { publicSession } = await import('../../src/lib/identity.ts');
let authenticated = false, attempts = 0;
const token = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: 'auth0|test', email: 'test@18.cn', role: 'authenticated', _roles: [], exp: Date.now()/1000 + 3600 })).toString('base64url')}.signature`;
await initializeBearer(async () => Response.json({ permissions: [] }), host, () => ({
  async getTokenSilently() { if (!authenticated) throw { error: 'login_required' }; return token; },
  async loginWithPopup() {
    attempts++;
    if (attempts === 1) throw new GenericError('access_denied', '请先验证注册邮箱，再返回登录');
    if (attempts === 3) throw new GenericError('custom_error', '<img src=x onerror=alert(1)>自定义登录错误');
    authenticated = true;
  },
}));
host.open = () => ({ close() {} });
const state = createClientSession(publicSession(null));
const target = document.createElement('div'); document.body.append(target);
const draft = document.createElement('textarea'); draft.value = '保留原输入'; target.append(draft);
const LoginDialog = await loadComponent('src/lib/LoginDialog.svelte');
const component = mount(LoginDialog, { target, props: { session: state } }); flushSync();
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(); };
const button = text => [...document.querySelectorAll('button')].find(button => button.textContent === text);
try {
  const pending = component.open(); let completed = false; void pending.then(() => { completed = true; });
  flushSync(); await settle();
  button('登录 / 注册').click(); await settle(); await settle();
  assert.equal(document.querySelector('h2').textContent, '请先验证注册邮箱，再返回登录');
  assert.equal(document.querySelector('.login-error-code').textContent, 'access_denied');
  assert.ok(button('重新登录'));
  assert.equal(completed, false); assert.equal(state.current().user, null);
  assert.equal(component.open(), pending); assert.equal(draft.value, '保留原输入');
  assert.equal(host.location.pathname + host.location.search, '/market-briefing?draft=keep');
  await settle(); assert.equal(document.querySelector('h2').textContent, '请先验证注册邮箱，再返回登录');
  button('重新登录').click();
  assert.equal(await pending, true); await settle();
  assert.equal(state.current().user.email, 'test@18.cn'); assert.equal(document.querySelector('[role=dialog]'), null);
  assert.equal(draft.value, '保留原输入');
  const cancelled = component.open(); flushSync(); await settle();
  button('登录 / 注册').click(); await settle(); await settle();
  assert.equal(document.querySelector('h2').textContent, '<img src=x onerror=alert(1)>自定义登录错误');
  assert.equal(document.querySelector('.login-error-code').textContent, 'custom_error');
  assert.equal(document.querySelector('[role=dialog] img'), null);
  document.querySelector('[role=dialog]').dispatchEvent(new host.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(await cancelled, false); await settle();
  assert.equal(document.querySelector('[role=dialog]'), null);
  console.log('Verification feedback persists and retry continues the original operation');
} finally { await unmount(component); }

let redirected = null;
host.history.replaceState({}, '', '/auth/callback?error=access_denied&state=opaque');
await initializeBearer(async () => assert.fail(), host, () => ({
  async handleRedirectCallback() {
    throw Object.assign(new GenericError('access_denied', '服务返回的实际错误'), { appState: { returnTo: '/financing/projects?q=keep' } });
  },
  async loginWithRedirect(options) { redirected = options.appState.returnTo; },
}));
const LoginPage = await loadComponent('src/routes/auth/login/+page.svelte');
const retryPage = mount(LoginPage, { target }); flushSync(); await settle();
try {
  assert.equal(document.querySelector('h1').textContent, '服务返回的实际错误');
  assert.equal(document.querySelector('.login-failure p').textContent, 'access_denied');
  assert.equal(redirected, null);
  button('重新登录').click(); await settle();
  assert.equal(redirected, '/financing/projects?q=keep');
  const { getLoginCallbackFailure } = await import('../../src/lib/bearer-auth.ts');
  assert.equal(getLoginCallbackFailure(), null);
} finally { await unmount(retryPage); }
