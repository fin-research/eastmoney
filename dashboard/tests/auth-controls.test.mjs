import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { Window } from 'happy-dom';
import { installAuthControls } from '../src/lib/auth-controls.ts';
import { installAuthInteraction } from '../src/lib/auth-client.ts';
import { createClientSession } from '../src/lib/client-session.ts';

const anonymous = { user: null, account: null, _roles: [], role: '', picture: '', permissions: [], expiresAt: null };
const authenticated = { ...anonymous, user: { email: 'test@18.cn' }, permissions: ['financing.project:create', 'fund.report:read'], expiresAt: Date.now() / 1000 + 3600 };

test('native forms preserve submitter and draft, deduplicate pending clicks, and stop denied submits', async t => {
  const host = new Window({ url: 'https://eastmoney.hasbai.xyz/financing/projects' });
  for (const name of ['Element', 'HTMLFormElement', 'HTMLButtonElement', 'HTMLInputElement']) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: host[name] });
    t.after(() => old ? Object.defineProperty(globalThis, name, old) : delete globalThis[name]);
  }
  const { document } = host;
  document.body.innerHTML = '<form method="post"><input name="name" value="保留的项目草稿"><button formaction="?/createProject">保存</button></form><a href="/fund-report" data-sveltekit-preload-data="hover">报告</a>';
  const form = document.querySelector('form'), button = document.querySelector('button'), anchor = document.querySelector('a');
  const state = createClientSession(anonymous); let complete; let logins = 0; let sent = 0;
  const errors = [];
  const login = installAuthInteraction({ session: state, login: () => { logins++; return new Promise(resolve => { complete = resolve; }); }, error: value => errors.push(value) });
  const cleanup = installAuthControls(state, document, assert.fail);
  t.after(() => { cleanup(); login(); });
  anchor.dispatchEvent(new host.MouseEvent('mousemove', { bubbles: true }));
  assert.equal(anchor.getAttribute('data-sveltekit-preload-data'), 'off'); assert.equal(logins, 0);
  form.addEventListener('submit', event => { event.preventDefault(); sent++; assert.equal(event.submitter, button); assert.equal(form.querySelector('input').value, '保留的项目草稿'); });
  const submit = () => form.dispatchEvent(new host.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: button }));
  submit(); submit(); await setImmediate(); assert.equal(logins, 1); assert.equal(sent, 0);
  state.seed(authenticated); complete(true); await setImmediate(); assert.equal(sent, 1);
  anchor.dispatchEvent(new host.MouseEvent('mousemove', { bubbles: true }));
  assert.equal(anchor.getAttribute('data-sveltekit-preload-data'), 'hover');
  state.seed({ ...authenticated, permissions: [] }); submit(); await setImmediate();
  assert.equal(sent, 1); assert.equal(errors.length, 1);
});

test('native GET filters navigate through the SPA while custom form handlers remain untouched', async t => {
  const host = new Window({ url: 'https://eastmoney.hasbai.xyz/financing/bond-investors' });
  for (const name of ['Element', 'HTMLFormElement', 'HTMLButtonElement', 'HTMLInputElement', 'FormData']) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: host[name] });
    t.after(() => old ? Object.defineProperty(globalThis, name, old) : delete globalThis[name]);
  }
  host.document.body.innerHTML = '<form method="GET"><input name="q" value="机构"></form><form id="custom"><input name="name" value="草稿"></form>';
  const paths = [];
  const state = createClientSession({ ...authenticated, permissions: [...authenticated.permissions, 'financing.data:read'] });
  const cleanup = installAuthControls(state, host.document, assert.fail, async path => paths.push(path)); t.after(cleanup);
  const first = host.document.querySelector('form');
  first.dispatchEvent(new host.SubmitEvent('submit', { bubbles: true, cancelable: true }));
  assert.equal(new URL(paths[0], host.location.origin).searchParams.get('q'), '机构');
  const custom = host.document.querySelector('#custom'); let handled = 0;
  custom.addEventListener('submit', event => { event.preventDefault(); handled++; });
  custom.dispatchEvent(new host.SubmitEvent('submit', { bubbles: true, cancelable: true }));
  assert.equal(handled, 1); assert.equal(paths.length, 1);
});

test('protected HTML clicks and middle-clicks use authenticated fetch and sandbox preview without native navigation', async t => {
  const { protectedReport } = await import('../src/lib/protected-report.ts');
  const host = new Window({ url: 'https://eastmoney.hasbai.xyz/fund-report' });
  for (const name of ['Element', 'HTMLFormElement', 'HTMLButtonElement', 'HTMLInputElement']) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: host[name] });
    t.after(() => old ? Object.defineProperty(globalThis, name, old) : delete globalThis[name]);
  }
  const original = globalThis.fetch; let fetched;
  globalThis.fetch = async url => { fetched = String(url); return new Response('<h1>日报</h1>', { headers: { 'Content-Type': 'text/html' } }); };
  t.after(() => { globalThis.fetch = original; protectedReport.set(null); });
  host.document.body.innerHTML = '<a href="/fund-report/2026-10-04.html">日报</a>';
  const cleanup = installAuthControls(createClientSession(authenticated), host.document, assert.fail); t.after(cleanup);
  for (const type of ['click', 'auxclick']) {
    const click = new host.MouseEvent(type, { button: type === 'auxclick' ? 1 : 0, bubbles: true, cancelable: true }); host.document.querySelector('a').dispatchEvent(click);
    assert.equal(click.defaultPrevented, true); await setImmediate();
  }
  const pageLink = host.document.createElement('a'); pageLink.href = '/fund-report'; host.document.body.append(pageLink);
  const native = new host.MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }); pageLink.dispatchEvent(native);
  assert.equal(native.defaultPrevented, false, 'ordinary CSR page middle-click keeps native new-tab behavior');
  assert.equal(fetched, 'https://eastmoney.hasbai.xyz/fund-report/2026-10-04.html');
  let value; const off = protectedReport.subscribe(next => value = next); off(); assert.equal(value, '<h1>日报</h1>');
});
