<script lang="ts">
	import ChartHost from '../../components/ChartHost.svelte';

	let {
		title,
		rows = [],
		height = 320,
		compact = false
	}: {
		title: string;
		rows?: Array<{ seriesId?: string; seriesName?: string; observationDate?: string; value?: number | null; unit?: string; tenor?: string }>;
		height?: number;
		compact?: boolean;
	} = $props();

	const colors = ['#173a63', '#3273b9', '#0e9384', '#d85b57', '#8b7bd9', '#d08b32'];
	const tenorColors: Record<string, string> = { '1年': '#15a9c3', '2年': '#4285e8', '3年': '#2f50b5', '5年': '#1f2937' };
	const series = $derived(groupRows(rows));
	const units = $derived([...new Set(series.map((item) => item.unit))]);
	const hasBasisPoints = $derived(units.includes('bp'));
	const option = $derived({
		aria: { enabled: true, decal: { show: false } },
		color: colors,
		tooltip: {
			confine: true,
			trigger: 'axis',
			formatter: (params: any) => formatTooltip(params)
		},
		legend: {
			type: 'scroll', bottom: 0, left: 'center', itemGap: compact ? 10 : 16,
			textStyle: { color: '#475569', fontSize: 12 }
		},
		grid: { left: compact ? 10 : 18, right: hasBasisPoints ? 18 : 10, top: 28, bottom: compact ? 70 : 58, containLabel: true },
		xAxis: {
			type: 'time',
			axisLine: { lineStyle: { color: '#cbd5e1' } }, axisTick: { show: false },
			axisLabel: { color: '#64748b', hideOverlap: true, formatter: (value: number) => formatAxisDate(value) },
			splitLine: { show: false }
		},
		yAxis: [
			{
				type: 'value', name: '%', scale: true, minInterval: 0.01,
				nameTextStyle: { color: '#64748b' }, axisLabel: { color: '#64748b', formatter: (value: number) => `${Number(value.toFixed(2))}%` },
				splitLine: { lineStyle: { color: '#e8edf3' } }
			},
			...(hasBasisPoints ? [{
				type: 'value', name: 'bp', scale: true, minInterval: 0.1,
				nameTextStyle: { color: '#64748b' }, axisLabel: { color: '#64748b', formatter: (value: number) => `${Number(value.toFixed(1))}bp` },
				splitLine: { show: false }
			}] : [])
		],
		series: series.map((item, index) => ({
			name: item.name,
			type: 'line',
			yAxisIndex: item.unit === 'bp' && hasBasisPoints ? 1 : 0,
			showSymbol: false,
			smooth: 0.1,
			connectNulls: false,
			lineStyle: { width: item.unit === 'bp' ? 2.2 : 2.6, type: 'solid', color: seriesColor(item, index) },
			itemStyle: { color: seriesColor(item, index) },
			emphasis: { focus: 'series' },
			data: item.points.flatMap((point) => point ? [[point.date, point.value]] : [])
		})),
		media: [{
			query: { maxWidth: 520 },
			option: {
				grid: { left: 6, right: hasBasisPoints ? 8 : 4, top: 28, bottom: 82, containLabel: true },
				legend: { bottom: 0, itemGap: 8, textStyle: { fontSize: 11 } }
			}
		}]
	});

	function groupRows(input: typeof rows) {
		const grouped = new Map<string, { id: string; name: string; unit: string; tenor: string; points: Array<{ date: string; value: number }> }>();
		for (const row of input) {
			const value = Number(row.value);
			const date = String(row.observationDate ?? '').slice(0, 10);
			if (!Number.isFinite(value) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
			const id = String(row.seriesId ?? row.seriesName ?? 'series');
			const item = grouped.get(id) ?? { id, name: String(row.seriesName ?? id), unit: String(row.unit ?? '%'), tenor: String(row.tenor ?? ''), points: [] };
			item.points.push({ date, value });
			grouped.set(id, item);
		}
		return [...grouped.values()].map((item) => ({
			...item,
			points: downsample(item.points.sort((left, right) => left.date.localeCompare(right.date)), 180)
		}));
	}

	function seriesColor(item: { tenor: string; unit: string }, index: number) {
		if (item.unit === '%' && tenorColors[item.tenor]) return tenorColors[item.tenor];
		return colors[index % colors.length];
	}

	function downsample<T>(points: T[], max: number) {
		if (points.length <= max) return points;
		const last = points.length - 1;
		return [...new Set(Array.from({ length: max }, (_, index) => Math.round(index * last / (max - 1))))].map((index) => points[index]);
	}

	function formatAxisDate(value: number) {
		const date = new Date(value);
		return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
	}

	function formatTooltip(params: any) {
		const items = Array.isArray(params) ? params : [params];
		if (!items.length) return '';
		const date = String(items[0]?.axisValueLabel ?? items[0]?.value?.[0] ?? '');
		return [escapeHtml(date), ...items.map((item: any) => {
			const value = Number(Array.isArray(item.value) ? item.value[1] : item.value);
			const source = series.find((entry) => entry.name === item.seriesName);
			return `${item.marker ?? ''}${escapeHtml(item.seriesName)}：<b>${Number.isFinite(value) ? value.toFixed(source?.unit === 'bp' ? 1 : 3) : '—'}${escapeHtml(source?.unit ?? '')}</b>`;
		})].join('<br>');
	}

	function escapeHtml(value: unknown) {
		return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
	}
</script>

{#if series.length}
	<ChartHost {option} ariaLabel={title} height={height / 16} />
{:else}
	<div class:compact class="chart-empty">暂无可靠历史序列</div>
{/if}

<style>
	.chart-empty { display: grid; min-height: 13rem; place-items: center; color: #64748b; font-size: 0.875rem; }
	.chart-empty.compact { min-height: 9rem; }
</style>
