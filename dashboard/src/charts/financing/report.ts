const fallbackColors = ['#3e5c9a', '#5a78c0', '#8b7bd9', '#4fa3d1', '#e06a74', '#8aa0b8', '#e0a24e', '#54bfa0', '#6b7280', '#7fd1b0'];

export const liabilityTypeColors: Record<string, string> = {
	固定收益凭证: '#3e5c9a',
	固定型收益凭证: '#3e5c9a',
	浮动收益凭证: '#5a78c0',
	浮动型收益凭证: '#5a78c0',
	私募债: '#8b7bd9',
	小公募: '#4fa3d1',
	公募债: '#4fa3d1',
	次级债: '#e06a74',
	短融: '#8aa0b8',
	短融券: '#8aa0b8',
	短期融资券: '#8aa0b8',
	短期公司债: '#54d8c8',
	转融资: '#e0a24e',
	互换便利: '#54bfa0',
	集团借款: '#6b7280',
	同业拆借: '#7fd1b0'
};

export const issuanceTrendTypes = ['短融', '3年公募债', '5年公募债', '3年次级债', '5年次级债'] as const;

export const issuanceTrendColors: Record<(typeof issuanceTrendTypes)[number], string> = {
	短融: '#94a3b8',
	'3年公募债': '#154575',
	'5年公募债': '#38afe5',
	'3年次级债': '#df2926',
	'5年次级债': '#fb6b6d'
};

export function liabilityTypeColor(type: string | null | undefined, index = 0) {
	return liabilityTypeColors[String(type ?? '')] ?? fallbackColors[index % fallbackColors.length];
}

export function visibleStackedTotals(
	rows: Array<{ label: string; type: string; value: number }>,
	labels: string[],
	types: string[],
	selected: Record<string, boolean> = {}
) {
	const visibleTypes = new Set(types.filter((type) => selected[type] !== false));
	return labels.map((label) => rows
		.filter((row) => row.label === label && visibleTypes.has(row.type))
		.reduce((sum, row) => sum + Number(row.value ?? 0), 0));
}
