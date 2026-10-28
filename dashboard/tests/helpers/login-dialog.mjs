import assert from 'node:assert/strict';
import { installDom, loadComponent } from './svelte-dom.mjs';
const host = installDom();
const { mount, unmount, flushSync } = await import('svelte');
const { createClientSession } = await import('../../src/lib/client-session.ts');
const anonymous = { user: null, account: null, roles: [], permissions: [], expiresAt: null };
const state = createClientSession(anonymous, async () => Response.json({ ...anonymous, user: { email: 'test@18.cn' }, expiresAt: Date.now() / 1000 + 86400 }));
const target = document.createElement('div'); document.body.append(target);
const LoginDialog = await loadComponent('src/lib/LoginDialog.svelte');
const component = mount(LoginDialog, { target, props: { session: state } }); flushSync();
try {
  const first = component.open(); assert.equal(first, component.open()); flushSync();
  await new Promise(resolve=>setTimeout(resolve,0)); flushSync();
  assert.equal(Boolean(document.querySelector('[role=dialog]')), true);
  document.querySelector('[role=dialog]').dispatchEvent(new host.KeyboardEvent('keydown', {key:'Escape',bubbles:true})); flushSync();
  assert.equal(await first, false); await new Promise(resolve=>setTimeout(resolve,0)); flushSync(); assert.equal(Boolean(document.querySelector('[role=dialog]')), false);
  const next = component.open(); flushSync(); await new Promise(resolve=>setTimeout(resolve,0)); flushSync(); assert.equal(Boolean(document.querySelector('[role=dialog]')), true);
  const child = { focus() {}, close() {} }; let loginUrl;
  host.open = (url) => { loginUrl = url; return child; };
  [...document.querySelectorAll('button')].find(button => button.textContent.includes('登录 / 注册')).click(); flushSync();
  const id = new URL(loginUrl, host.location.origin).searchParams.get('popup');
  host.dispatchEvent(new host.MessageEvent('message', { origin: host.location.origin, source: child, data: { type: 'eastmoney:login', id, ok: true } }));
  assert.equal(await next, true); flushSync(); await new Promise(resolve=>setTimeout(resolve,0)); flushSync();
  assert.equal(Boolean(document.querySelector('[role=dialog]')), false);
  assert.equal(host.location.pathname, '/credit-workbench/assistant');
  console.log('Login dialog cancellation, retry and completion preserve the page');
} finally { await unmount(component); }
