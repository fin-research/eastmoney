import assert from 'node:assert/strict';
import { installDom, loadComponent } from './svelte-dom.mjs';

const window = installDom();
const { mount, unmount, flushSync, tick } = await import('svelte');
const ScheduleFields = await loadComponent('src/lib/financing/components/ScheduleFields.svelte');

async function exercise(props, startName, endName, start, end) {
	const form = document.createElement('form');
	document.body.append(form);
	const app = mount(ScheduleFields, { target: form, props });
	flushSync();
	// happy-dom does not implement option:checked; Svelte uses this browser
	// selector to read the selected option. Preserve native selection semantics.
	const select = form.querySelector('select');
	const querySelector = select.querySelector.bind(select);
	select.querySelector = (selector) => selector === ':checked' ? [...select.options].find(option => option.selected) ?? null : querySelector(selector);
	const change = (name, value, event = 'input') => {
		const control = form.querySelector(`[name="${name}"]`);
		control.value = value;
		control.dispatchEvent(new Event(event, { bubbles: true }));
		flushSync();
	};
	assert.equal(form.querySelector(`[name="${startName}"]`), null);
	change('scheduleType', 'period', 'change');
	assert.ok(form.querySelector(`[name="${startName}"]`).required);
	assert.equal(form.checkValidity(), false, 'incomplete periods must block auto-save');
	change(startName, start);
	change(endName, end);
	assert.equal(form.checkValidity(), true);
	let values = new window.FormData(form);
	assert.equal(values.get('scheduleType'), 'period');
	assert.equal(values.get(startName), start);
	assert.equal(values.get(endName), end);
	change('scheduleType', 'point', 'change');
	values = new window.FormData(form);
	assert.equal(values.has(startName), false, 'switching to point must not submit a stale start');
	change('scheduleType', 'period', 'change');
	assert.equal(form.querySelector(`[name="${startName}"]`).value, start);
	form.reset();
	// Let the native/Svelte reset batch finish before the component restores its props.
	await new Promise(resolve => setTimeout(resolve, 0));
	await tick();
	await Promise.resolve();
	flushSync();
	assert.equal(form.querySelector('[name="scheduleType"]').value, 'point');
	assert.equal(form.querySelector(`[name="${startName}"]`), null);
	assert.equal(form.querySelector(`[name="${endName}"]`).value, String(props.endValue ?? ''));
	await unmount(app);
	form.remove();
}

await exercise({ relative: true, endValue: 0 }, 'startOffsetDays', 'offsetDays', '-10', '-3');
await exercise({}, 'plannedStartDate', 'dueDate', '2026-09-08', '2026-09-10');
await window.happyDOM.close();
