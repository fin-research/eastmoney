import type { ClientSessionData, AccountSummary } from '$lib/identity';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = () => ({ session: null as ClientSessionData | null, permissions: [] as string[], account: null as AccountSummary | null });
