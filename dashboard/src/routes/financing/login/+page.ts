import { redirect } from '@sveltejs/kit';
import { appRoot, isAppPath } from '$lib/financing/app-paths';
import { loginUrl } from '$lib/auth-navigation';
import type { PageLoad } from './$types';

export const ssr = false;
export const load: PageLoad = ({ url }) => {
  const requested = url.searchParams.get('redirectTo');
  redirect(307, loginUrl(requested && isAppPath(requested) ? requested : appRoot));
};
