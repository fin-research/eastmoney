// Financing is a route namespace inside Dashboard, not SvelteKit's global base.
const base = '/financing';

export const appRoot = base ? `${base}/` : '/';
export const appCookiePath = base || '/';

export function withBase(path: string) {
	if (path === '/people') return '/management/people';
	if (path === '/settings') return '/management/financing-profile';
	if (!path.startsWith('/') || path.startsWith('//')) return path;
	if (base && (path === base || path.startsWith(`${base}/`))) return path;
	if (path === '/') return appRoot;
	return `${base}${path}`;
}

export function withoutBase(pathname: string) {
	if (!base) return pathname || '/';
	if (pathname === base) return '/';
	if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length) || '/';
	return pathname || '/';
}

export function isAppPath(path: string) {
	if (!path.startsWith('/') || path.startsWith('//')) return false;
	return !base || path === base || path.startsWith(`${base}/`);
}
