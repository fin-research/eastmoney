import assert from 'node:assert/strict';
import { installDom, loadComponent } from './svelte-dom.mjs';
import { FOCUS_STORAGE_PREFIX } from '../../src/focus-editor.ts';
const window = installDom();
const { mount, unmount, flushSync } = await import('svelte');
window.localStorage.setItem(`${FOCUS_STORAGE_PREFIX}2026-09-11`, '原始草稿');
const Host = await loadComponent('tests/helpers/FocusHost.svelte', `<script>
import FocusEditor from '../../src/components/FocusEditor.svelte';
let generating = $state(false), result = $state(null), text = $state('');
export function start() { generating = true; }
export function cancel() { generating = false; }
export function complete() { generating = false; result = {report_date:'2026-09-11', stock:'股市结论', bond:'债市结论', news_count:2}; }
export function value() { return text; }
</script>
<FocusEditor reportDate="2026-09-11" {generating} generatedBriefing={result} onTextChange={(value) => text = value} />`);
const app = mount(Host, { target: document.body }); flushSync();
assert.equal(app.value(), '原始草稿');
flushSync(() => app.start());
assert.equal(app.value(), '原始草稿');
assert.equal(document.querySelector('[contenteditable]').hasAttribute('inert'), true);
assert.equal(document.querySelector('[contenteditable]').textContent, '原始草稿');
assert.equal(window.localStorage.getItem(`${FOCUS_STORAGE_PREFIX}2026-09-11`), '原始草稿');
flushSync(() => app.cancel());
assert.equal(document.querySelector('[contenteditable]').hasAttribute('inert'), false);
assert.equal(app.value(), '原始草稿');
flushSync(() => app.complete());
assert.equal(app.value(), '1、股市结论\n2、债市结论');
assert.match(window.localStorage.getItem(`${FOCUS_STORAGE_PREFIX}2026-09-11`), /股市结论/);
await unmount(app);
