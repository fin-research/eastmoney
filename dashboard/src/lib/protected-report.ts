import { writable } from 'svelte/store';
export const protectedReport = writable<string | null>(null);
