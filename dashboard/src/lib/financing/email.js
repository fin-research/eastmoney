export const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** @param {unknown} value */
export function normalizeEmail(value) {
	return String(value ?? '').trim().toLowerCase();
}

/** @param {unknown} value */
export function isValidEmail(value) {
	return emailPattern.test(normalizeEmail(value));
}
