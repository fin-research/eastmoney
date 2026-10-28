import { redirect } from '@sveltejs/kit';
export function load() { redirect(303, '/auth/logout'); }
export const actions = { default: () => redirect(303, '/auth/logout') };
