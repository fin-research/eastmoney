import assert from 'node:assert/strict';
import { installDom, loadComponent } from './svelte-dom.mjs';
import { createClientSession } from '../../src/lib/client-session.ts';

const window = installDom();
const { mount, unmount, flushSync } = await import('svelte');
const session = createClientSession();
const Page = await loadComponent('src/routes/+page.svelte');
const app = mount(Page, { target: document.body, context: new Map([
  ['site-session', session], ['site-account', () => null], ['site-account-checking', () => true],
]) });
flushSync();
const cards = () => [...document.querySelectorAll('.tool-card')].map(card => card.querySelector('h2').textContent);
assert.deepEqual(cards(), ['市场点评']);
flushSync(() => session.seed({ user: null, account: null, _roles: [], role: '', picture: '', permissions: [], expiresAt: null }));
assert.deepEqual(cards(), ['市场点评']);
flushSync(() => session.seed({ user: { id: 'auth0|test', auth0Id: 'auth0|test', email: 'test@18.cn' },
  account: { name: '测试', department: '' }, _roles: [], role: '', picture: '', permissions: ['credit.institution:read'], expiresAt: Date.now() / 1000 + 3600 }));
assert.deepEqual(cards(), ['市场点评', '授信工作台', '管理']);
await unmount(app);
await window.happyDOM.abort();
console.log('Portal visibility checks passed');
