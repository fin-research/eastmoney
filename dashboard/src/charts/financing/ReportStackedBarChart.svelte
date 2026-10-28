<script lang="ts">
	import ChartHost from '../../components/ChartHost.svelte';
	import { setChart, type ChartOption } from '../charting';
	import { liabilityTypeColor, visibleStackedTotals } from './report';

	let {
		title,
		rows = [],
		labels = [],
		types = [],
		height = 320,
		horizontal = false,
		highlightLabel = ''
	}: {
		title: string;
		rows?: Array<{ label: string; type: string; value: number }>;
		labels?: string[];
		types?: string[];
		height?: number;
		horizontal?: boolean;
		highlightLabel?: string;
	} = $props();

	let selected = $state<Record<string, boolean>>({});
	const totals = $derived(visibleStackedTotals(rows, labels, types, selected));
	const maximumTotal = $derived(Math.max(0, ...totals));
	const barSeries = $derived(types.map((type, index) => ({
		name: type,
		type: 'bar',
		stack: 'total',
		barMaxWidth: horizontal ? 24 : 44,
		itemStyle: { color: liabilityTypeColor(type, index) },
		emphasis: { focus: 'none' },
		label: horizontal ? {
			show: true,
			position: 'inside',
			color: insideLabelColor(type),
			fontSize: 10,
			fontWeight: 'bolder',
			formatter: (params: any) => Number(params.value) > 0 ? formatAmount(params.value) : ''
		} : { show: false },
		data: labels.map((label) => Number(rows.find((row) => row.label === label && row.type === type)?.value ?? 0))
	})));
	const totalSeries = $derived({
		name: '合计',
		type: 'bar',
		barGap: '-100%',
		barMaxWidth: horizontal ? 24 : 44,
		silent: true,
		tooltip: { show: false },
		itemStyle: { color: 'transparent' },
		label: {
			show: true,
			position: horizontal ? 'right' : 'top',
			distance: horizontal ? 8 : 4,
			formatter: (params: any) => {
				if (Number(params.value) === 0) return '';
				const value = formatAmount(params.value);
				if (horizontal && isHighlighted(labels[params.dataIndex])) return `{highlight|${value}}`;
				if (!horizontal && Number(params.value) === maximumTotal) return `{maximum|${value}}`;
				return `{normal|${value}}`;
			},
			rich: {
				highlight: { color: '#dc2626', fontSize: 11, fontWeight: 'bolder' },
				maximum: { color: '#dc2626', fontSize: 11, fontWeight: 'bolder' },
				normal: { color: '#0f3d6c', fontSize: 11, fontWeight: 'bolder' }
			}
		},
		data: totals
	});
	const option = $derived({
		aria: { enabled: true, decal: { show: false } },
		tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (value: unknown) => `${Number(value).toFixed(2)} 亿元` },
		legend: { type: 'scroll', bottom: 0, data: types, selected, textStyle: { color: '#334155', fontSize: 12 } },
		grid: horizontal
			? { left: 12, right: 36, top: 16, bottom: 48, containLabel: true }
			: { left: 16, right: 10, top: 28, bottom: 58, containLabel: true },
		xAxis: horizontal
			? { type: 'value', name: '亿元', axisLabel: { color: '#334155' }, nameTextStyle: { color: '#64748b' }, splitLine: { lineStyle: { color: '#dbe3ed', type: 'dashed' } } }
			: { type: 'category', data: labels, axisLabel: { color: '#111827', formatter: compactLabel }, axisTick: { show: false }, axisLine: { lineStyle: { color: '#cbd5e1' } } },
		yAxis: horizontal
			? {
				type: 'category',
				inverse: true,
				data: labels,
				axisLabel: {
					color: '#334155',
					width: 118,
					overflow: 'truncate',
					formatter: (value: string) => isHighlighted(value) ? `{highlight|${value}}` : value,
					rich: { highlight: { color: '#dc2626', fontWeight: 'bolder' } }
				},
				axisTick: { show: false },
				axisLine: { show: false }
			}
			: { type: 'value', name: '亿元', axisLabel: { color: '#111827' }, nameTextStyle: { color: '#64748b' }, splitLine: { lineStyle: { color: '#dbe3ed' } } },
		series: [...barSeries, totalSeries],
		media: [{
			query: { maxWidth: 520 },
			option: {
				grid: { left: 4, right: horizontal ? 24 : 4, top: 24, bottom: 68, containLabel: true },
				legend: { bottom: 0, textStyle: { fontSize: 11 } }
			}
		}]
	});

	function onLegendChange(event: unknown) {
		const selection = event as { selected: Record<string, boolean> };
		selected = { ...selection.selected };
	}

	function renderChart(host: HTMLElement, chartOption: ChartOption) {
		const chart = setChart(host, chartOption);
		chart.off('legendselectchanged', onLegendChange);
		chart.on('legendselectchanged', onLegendChange);
	}

	function compactLabel(label: string) {
		if (!/^\d{4}-\d{2}$/.test(label)) return label;
		const [year, month] = label.split('-');
		return `${year}/${Number(month)}`;
	}

	function isHighlighted(value: string | null | undefined) {
		return Boolean(highlightLabel && String(value ?? '').includes(highlightLabel));
	}

	function insideLabelColor(type: string) {
		return ['短期公司债'].includes(type) ? '#0f3d6c' : '#ffffff';
	}

	function formatAmount(value: unknown) {
		return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
	}
</script>

{#if labels.length && rows.some((row) => row.value > 0)}
	<ChartHost {option} renderer={renderChart} ariaLabel={title} height={height / 16} />
{:else}
	<div class="chart-empty">暂无可靠分类数据</div>
{/if}

<style>
	.chart-empty { display: grid; min-height: 13rem; place-items: center; color: #64748b; font-size: 0.875rem; }
</style>
