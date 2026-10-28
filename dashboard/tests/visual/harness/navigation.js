import { onMount } from 'svelte';
import { setPageUrl } from './state.svelte.js';
/** @param {(event: {from: null, to: {url: URL}, type: string}) => void} callback */
export function afterNavigate(callback) {
  onMount(() => { callback({ from: null, to: { url: new URL(window.location.href) }, type: 'enter' }); });
}
/** @param {string | URL} url */
export function goto(url) {
 const next = new URL(url, window.location.href);
 if (window.location.pathname === '/financing/data' && next.pathname === '/financing/data') {
  window.history.pushState({}, '', next); setPageUrl(next); return Promise.resolve();
 }
 window.location.assign(String(url)); return Promise.resolve();
}

/** Component harness has no SvelteKit router. Browser unload remains native.
 * @param {(event: {cancel: () => void}) => void} _callback
 */
export function beforeNavigate(_callback) {}

export function invalidate() { return Promise.resolve(); }
export function invalidateAll() { return Promise.resolve(); }

/** @param {string | URL} url @param {unknown} state */
export function replaceState(url, state) { window.history.replaceState(state, '', url); setPageUrl(new URL(url, window.location.href)); }
