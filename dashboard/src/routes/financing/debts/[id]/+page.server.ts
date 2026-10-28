import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDebtDetail } from '$lib/server/financing/queries.js';

export const load: PageServerLoad = async ({ params }) => {
	const debt = await getDebtDetail(params.id);
	if (!debt) throw error(404, '未找到该负债记录');
	return { debt };
};
