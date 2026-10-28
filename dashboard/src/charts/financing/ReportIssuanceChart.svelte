<script lang="ts">
	import ChartHost from '../../components/ChartHost.svelte';
	import { issuanceTrendColors, issuanceTrendTypes } from './report';

	type Row = { month: string; type: string; amountYi: number; weightedRatePct?: number | null };
	let { rows = [] }: { rows?: Row[] } = $props();
	const months = $derived(
		[...new Set(rows.map((row) => row.month))]
			.sort()
			.filter((month) => rows.some((row) => row.month === month && (Number(row.amountYi) > 0 || row.weightedRatePct != null)))
	);
	const lastRateIndices = $derived(Object.fromEntries(issuanceTrendTypes.map((type) => [type, lastObservedRateIndex(type)])));
	const option = $derived({
		aria: { enabled: true, decal: { show: false } },
		tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
		legend: {
			type: 'scroll',
			bottom: 0,
			data: [...issuanceTrendTypes],
			textStyle: { color: '#334155', fontSize: 12 }
		},
		grid: { left: 20, right: 24, top: 28, bottom: 58, containLabel: true },
		xAxis: {
			type: 'category', data: months,
			axisTick: { show: false }, axisLine: { lineStyle: { color: '#94a3b8' } },
			axisLabel: { color: '#334155', rotate: 32, formatter: (value: string) => value.slice(2) }
		},
		yAxis: [
			{
				type: 'value', name: '亿元', min: 0,
				axisLabel: { color: '#334155' }, nameTextStyle: { color: '#64748b' },
				splitLine: { lineStyle: { color: '#dbe3ed' } }
			},
			{
				type: 'value', name: '%', scale: true,
				axisLabel: { color: '#334155', formatter: '{value}%' }, nameTextStyle: { color: '#64748b' },
				splitLine: { show: false }
			}
		],
		series: [
			...issuanceTrendTypes.map((type) => ({
				name: type,
				type: 'bar',
				stack: '发行规模',
				barMaxWidth: 34,
				itemStyle: { color: issuanceTrendColors[type] },
				tooltip: { valueFormatter: (value: unknown) => `${Number(value).toFixed(2)} 亿元` },
				data: months.map((month) => Number(findRow(month, type)?.amountYi ?? 0))
			})),
			...issuanceTrendTypes.map((type) => ({
				name: type,
				type: 'line',
				yAxisIndex: 1,
				showSymbol: true,
				symbol: 'circle',
				symbolSize: 6,
				connectNulls: true,
				lineStyle: { width: 2.4, color: issuanceTrendColors[type] },
				itemStyle: { color: issuanceTrendColors[type] },
				label: {
					show: true,
					position: 'left',
					distance: 8,
					color: issuanceTrendColors[type],
					fontSize: 11,
					fontWeight: 'bolder',
					backgroundColor: 'rgba(255,255,255,0.9)',
					padding: [2, 3],
					borderRadius: 2,
					formatter: (params: any) => params.dataIndex === lastRateIndices[type]
						? `${Number(params.value).toFixed(2)}%`
						: ''
				},
				tooltip: { valueFormatter: (value: unknown) => `${Number(value).toFixed(2)}%` },
				data: months.map((month, index) => {
					const value = findRow(month, type)?.weightedRatePct;
					return value == null ? null : { value: Number(value), label: { show: index === lastRateIndices[type] } };
				})
			}))
		],
		media: [{
			query: { maxWidth: 560 },
			option: { grid: { left: 8, right: 12, top: 38, bottom: 74, containLabel: true } }
		}]
	});

	function findRow(month: string, type: string) {
		return rows.find((row) => row.month === month && row.type === type);
	}

	function lastObservedRateIndex(type: string) {
		for (let index = months.length - 1; index >= 0; index -= 1) {
			if (findRow(months[index]!, type)?.weightedRatePct != null) return index;
		}
		return -1;
	}
</script>

{#if months.length && rows.some((row) => Number(row.amountYi) > 0)}
	<ChartHost {option} ariaLabel="近一年公司债券发行规模与加权发行利率" height={19} />
{:else}
	<div class="chart-empty">近一年暂无可靠公司债发行数据</div>
{/if}

<style>
	.chart-empty { display: grid; min-height: 16rem; place-items: center; color: #64748b; font-size: 0.875rem; }
</style>
