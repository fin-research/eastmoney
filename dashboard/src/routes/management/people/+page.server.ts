import { identityJson } from '$lib/server/gateway-client';
import type { Auth0Role, DirectoryPerson } from '$lib/server/auth0-directory';
import { managementPeopleTab } from '$lib/workbench/navigation';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, depends, url }) => {
  const tab = managementPeopleTab(url.searchParams.get('tab'));
  if (tab === 'people') {
    return { tab, view: null };
  }
  depends('auth:permissions');
  const configuration = await identityJson<{
    roles: Auth0Role[]; configurations: Record<string, { permissions: string[] }>; mode: 'enforce'; updatedAt: number;
  }>(platform!.env, '/roles/configurations', locals.user);
  return { tab, view: { ...configuration, tab, people: [] as DirectoryPerson[] } };
};
