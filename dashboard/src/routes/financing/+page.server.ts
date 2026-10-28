import type { PageServerLoad } from './$types';
import { getDebtTypeOptions, getFinancingDashboardData } from '$lib/server/financing/queries.js';

const PRESET_EXCLUSIONS: Record<string, string[]> = {
	all: [],
	no_interbank: ['同业拆借'],
	no_interbank_swap: ['同业拆借', '互换便利'],
	core_financing: ['同业拆借', '互换便利', '浮动收益凭证']
};

export const load: PageServerLoad = async ({ url }) => {
	const options = getDebtTypeOptions();
	const preset = url.searchParams.get('preset') ?? 'all';
	const customTypes = url.searchParams.getAll('type').filter((item) => options.includes(item));
	const selectedTypes = preset === 'custom'
		? customTypes
		: preset === 'all'
			? []
			: options.filter((item) => !(PRESET_EXCLUSIONS[preset] ?? []).includes(item));
	return {
		dashboard: await getFinancingDashboardData({ selectedTypes }),
		preset,
		selectedTypes
	};
};
