// Historical pre-0032 authentication fixture; never imported by production code.
import { isPermissionAuthorizedRequest } from './permissions.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** @param {string} method */
export function isSafeRequestMethod(method) {
	return SAFE_METHODS.has(method);
}

/**
 * Mirrors SvelteKit's named-action parsing for URLs such as `?/createProject`.
 * @param {URL} url
 */
export function actionNameFromUrl(url) {
	for (const [name] of url.searchParams) {
		if (name.startsWith('/')) return name.slice(1);
	}
	return 'default';
}

/**
 * @param {string[] | null | undefined} permissions
 * @param {string | null} routeId
 * @param {string} method
 * @param {string} actionName
 */
export function isAuthorizedRequest(permissions, routeId, method, actionName = 'default') {
	return isPermissionAuthorizedRequest(permissions, routeId, method, actionName);
}
