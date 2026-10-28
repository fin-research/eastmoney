// Reactive financing-data navigation exercises the production component's request races.
export const page = $state({ url: new URL(window.location.href), data: {} });
export const navigating = { to: null };
/** @param {string | URL} url */
export function setPageUrl(url) { page.url = new URL(url, window.location.href); }
window.addEventListener('popstate', () => setPageUrl(window.location.href));
