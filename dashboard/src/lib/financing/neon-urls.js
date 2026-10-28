/** @param {string | null | undefined} authUrl */
export function dataApiUrlFromAuthUrl(authUrl) {
	if (!authUrl) return null;
	const url = new URL(authUrl);
	if (!url.hostname.includes('.neonauth.')) return null;
	url.hostname = url.hostname.replace('.neonauth.', '.apirest.');
	url.pathname = url.pathname.replace(/\/auth\/?$/, '/rest/v1');
	url.search = '';
	url.hash = '';
	return url.toString().replace(/\/$/, '');
}
