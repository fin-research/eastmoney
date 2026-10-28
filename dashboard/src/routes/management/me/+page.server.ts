import { redirect } from '@sveltejs/kit';
import { loginUrl } from '$lib/auth-navigation';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url, setHeaders }) => {
  if (!locals.user) redirect(303, loginUrl(url.pathname + url.search));
  setHeaders({ 'Cache-Control': 'no-store, private' });
  return { email: locals.user.email };
};
