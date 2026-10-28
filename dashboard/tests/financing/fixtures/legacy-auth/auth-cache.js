// Historical pre-0032 authentication fixture; never imported by production code.
// @ts-nocheck

// This caches only a business authorization decision. Central Access verification
// must succeed before it is read; cached identity fields never replace locals.user.
const CACHE_NAME = 'financing-authorization-v2';
const CACHE_TTL_SECONDS = 60;
const VALID_ROLES = new Set(['admin', 'handler', 'reviewer']);

function cacheStorage(event) {
	return event.platform?.caches ?? null;
}

function validUser(user) {
	return Boolean(
		user &&
		typeof user.id === 'string' &&
		(user.email === null || typeof user.email === 'string') &&
		VALID_ROLES.has(user.role) &&
		typeof user.personId === 'string' &&
		typeof user.personName === 'string' &&
		typeof user.hasAvatar === 'boolean' &&
		typeof user.avatarVersion === 'string'
	);
}

async function cacheKey(event, token) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	return new Request(new URL(`/__financing_internal/session/${hash}`, event.url.origin));
}

async function sessionCache(event) {
	const storage = cacheStorage(event);
	return storage ? storage.open(CACHE_NAME) : null;
}

export async function readCachedSessionUser(event, token) {
	if (!token) return null;
	try {
		const cache = await sessionCache(event);
		if (!cache) return null;
		const response = await cache.match(await cacheKey(event, token));
		if (!response) return null;
		const user = await response.json();
		return validUser(user) ? user : null;
	} catch {
		return null;
	}
}

export async function cacheSessionUser(event, token, user) {
	if (!token || !validUser(user)) return;
	try {
		const cache = await sessionCache(event);
		if (!cache) return;
		const write = cache.put(
			await cacheKey(event, token),
			new Response(JSON.stringify(user), {
				headers: {
					'content-type': 'application/json',
					'cache-control': `s-maxage=${CACHE_TTL_SECONDS}`
				}
			})
		).catch(() => undefined);
		if (event.platform?.context?.waitUntil) {
			event.platform.context.waitUntil(write);
			return;
		}
		await write;
	} catch {
		// Authentication remains authoritative when the opportunistic cache is unavailable.
	}
}

export async function invalidateCachedSession(event, token) {
	if (!token) return false;
	try {
		const cache = await sessionCache(event);
		return cache ? await cache.delete(await cacheKey(event, token)) : false;
	} catch {
		return false;
	}
}
