import type { PageServerLoad } from './$types';
import { getReminderHistory } from '$lib/server/financing/queries.js';

export const load: PageServerLoad = async ({ url }) => {
	const status = url.searchParams.get('status') ?? '';
	const query = url.searchParams.get('query')?.trim() ?? '';
	return {
		filters: { status, query },
		history: await getReminderHistory({ status, query, limit: 50 })
	};
};
