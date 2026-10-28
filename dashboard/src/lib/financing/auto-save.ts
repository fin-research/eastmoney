const AUTO_SAVE_COMPLETE_EVENT = 'autosavecomplete';
const DEFAULT_DELAY = 650;

type EditableControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type AutoSaveOptions = {
	delay?: number;
	onDirty?: () => void;
	onInvalid?: () => void;
};

function revisionOf(form: HTMLFormElement) {
	return Number(form.dataset.autoSaveRevision ?? '0');
}

function isEditableControl(target: EventTarget | null): target is EditableControl {
	if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) {
		return false;
	}
	const readOnly = target instanceof HTMLSelectElement ? false : target.readOnly;
	return !target.disabled && !readOnly && !['button', 'hidden', 'reset', 'submit'].includes(target.type);
}

function controlValue(target: EditableControl) {
	if (target instanceof HTMLInputElement && target.type === 'file') {
		return [...(target.files ?? [])]
			.map((file) => `${file.name}:${file.size}:${file.lastModified}`)
			.join('|');
	}
	if (target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type)) {
		return `${target.checked}:${target.value}`;
	}
	return target.value;
}

export function getAutoSaveRevision(form: HTMLFormElement) {
	return revisionOf(form);
}

export function completeAutoSave(form: HTMLFormElement, success: boolean) {
	form.dispatchEvent(new CustomEvent(AUTO_SAVE_COMPLETE_EVENT, { detail: { success } }));
}

/**
 * Debounced, serial auto-save for enhanced SvelteKit forms. The enhancement
 * callback must call completeAutoSave() after every response so edits made
 * while a request is in flight can be submitted next without racing.
 */
export function autoSave(form: HTMLFormElement, initialOptions: AutoSaveOptions = {}) {
	let options = initialOptions;
	let timer: number | null = null;
	let dirty = false;
	let inFlight = false;
	let submittedRevision = revisionOf(form);
	const controlValues = new WeakMap<EditableControl, string>();

	function clearTimer() {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
	}

	function attempt(reportValidity = false) {
		clearTimer();
		if (!dirty || inFlight) return;
		if (!form.checkValidity()) {
			if (reportValidity) form.reportValidity();
			options.onInvalid?.();
			return;
		}
		form.requestSubmit();
	}

	function schedule(delay: number, reportValidity = false) {
		clearTimer();
		timer = window.setTimeout(() => attempt(reportValidity), delay);
	}

	function markDirty(target: EditableControl) {
		const value = controlValue(target);
		if (controlValues.get(target) === value) return false;
		controlValues.set(target, value);
		dirty = true;
		form.dataset.autoSaveRevision = String(revisionOf(form) + 1);
		options.onDirty?.();
		return true;
	}

	function handleInput(event: Event) {
		if (!isEditableControl(event.target)) return;
		markDirty(event.target);
		schedule(Number(options.delay ?? DEFAULT_DELAY));
	}

	function handleChange(event: Event) {
		if (!isEditableControl(event.target)) return;
		markDirty(event.target);
		schedule(0, true);
	}

	function handleBlur(event: FocusEvent) {
		if (!isEditableControl(event.target) || !dirty) return;
		schedule(0, true);
	}

	function handleSubmit() {
		clearTimer();
		inFlight = true;
		dirty = false;
		submittedRevision = revisionOf(form);
	}

	function handleComplete(event: Event) {
		inFlight = false;
		const success = Boolean((event as CustomEvent<{ success?: boolean }>).detail?.success);
		if (!success) {
			dirty = true;
			return;
		}
		if (revisionOf(form) > submittedRevision) {
			dirty = true;
			schedule(0);
		}
	}

	form.addEventListener('input', handleInput);
	form.addEventListener('change', handleChange);
	form.addEventListener('focusout', handleBlur);
	form.addEventListener('submit', handleSubmit);
	form.addEventListener(AUTO_SAVE_COMPLETE_EVENT, handleComplete);

	return {
		update(nextOptions: AutoSaveOptions = {}) {
			options = nextOptions;
		},
		destroy() {
			clearTimer();
			form.removeEventListener('input', handleInput);
			form.removeEventListener('change', handleChange);
			form.removeEventListener('focusout', handleBlur);
			form.removeEventListener('submit', handleSubmit);
			form.removeEventListener(AUTO_SAVE_COMPLETE_EVENT, handleComplete);
		}
	};
}
