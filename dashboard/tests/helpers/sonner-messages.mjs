import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { get } from 'svelte/store';
import { installDom, loadComponent } from './svelte-dom.mjs';
const window = installDom();
const { mount, unmount, flushSync } = await import('svelte');
const { globalMessages } = await import('../../src/lib/global-messages.ts');
const Messages = await loadComponent('src/lib/GlobalMessages.svelte');
const app = mount(Messages, {target: document.body});
async function settle() { for (let i=0;i<6;i++) { await new Promise(resolve=>setTimeout(resolve,0)); flushSync(); } }
await settle();
try {
  const first = globalMessages.success('保存成功', {key:'save'}); await settle();
  assert.ok(document.querySelector('[data-sonner-toaster]'));
  assert.equal(document.querySelectorAll('[data-sonner-toaster]').length, 1);
  assert.match(document.body.textContent, /保存成功/);
  assert.equal(globalMessages.error('保存失败，输入已保留', {key:'save'}), first); await settle();
  assert.match(document.body.textContent, /保存失败，输入已保留/);
  assert.equal(get(globalMessages).length, 1);
  document.querySelector('[data-close-button]').click(); await settle();
  assert.equal(get(globalMessages).length, 0);

  mock.timers.enable({apis:['Date','setTimeout']});
  const id=globalMessages.info('处理中'); flushSync();
  mock.timers.tick(3000);
  document.querySelector('.global-message-region').dispatchEvent(new window.Event('pointerenter')); flushSync();
  mock.timers.tick(10000);
  assert.equal(get(globalMessages)[0]?.id,id,'hovering pauses the remaining lifetime');
  document.querySelector('.global-message-region').dispatchEvent(new window.Event('pointerleave')); flushSync();
  mock.timers.tick(1499); assert.equal(get(globalMessages).length,1);
  mock.timers.tick(1); assert.equal(get(globalMessages).length,0);
  mock.timers.reset();
  console.log('Sonner notifications replace by key, dismiss and pause without losing lifetime');
} finally {
  mock.timers.reset(); globalMessages.clear(); await unmount(app); await window.happyDOM.abort();
}
