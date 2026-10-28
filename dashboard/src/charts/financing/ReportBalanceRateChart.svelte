<script lang="ts">
	import ChartHost from '../../components/ChartHost.svelte';

	let { rows = [] }: { rows?: Array<{ date?: string; balanceYi?: number; weightedRatePct?: number | null }> } = $props();
	const values = $derived(rows
		.filter((row) => Number(row.balanceYi) > 0 && /^\d{4}-\d{2}-\d{2}/.test(String(row.date ?? '')))
		.sort((left, right) => String(left.date).localeCompare(String(right.date))));
	const yearTickIndices = $derived(firstIndexOfEachYear(values));
	const annotationIndices = $derived(withLastIndex(yearTickIndices, values.length));
	const balancePoints = $derived(annotationIndices.map((index) => ({
		coord: [values[index]!.date, Number(values[index]!.balanceYi)],
		value: Number(values[index]!.balanceYi),
		label: { align: index === 0 ? 'left' : index === values.length - 1 ? 'right' : 'center' }
	})));
	const ratePoints = $derived(annotationIndices
		.filter((index) => values[index]!.weightedRatePct != null)
		.map((index) => ({
			coord: [values[index]!.date, Number(values[index]!.weightedRatePct)],
			value: Number(values[index]!.weightedRatePct),
			label: { align: index === 0 ? 'left' : index === values.length - 1 ? 'right' : 'center' }
		})));
	const option = $derived({
		aria: { enabled: true, decal: { show: false } },
		tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
		legend: {
			bottom: 0,
			data: ['综合融资利率', '融资余额'],
			textStyle: { color: '#334155', fontSize: 12 }
		},
		grid: { left: 18, right: 18, top: 34, bottom: 52, containLabel: true },
		xAxis: {
			type: 'category',
			boundaryGap: false,
			data: values.map((row) => row.date),
			axisLine: { lineStyle: { color: '#94a3b8' } },
			axisTick: { show: false },
			axisLabel: {
				interval: 0,
				color: '#334155',
				formatter: (value: string, index: number) => yearTickIndices.includes(index) ? value.slice(0, 4) : ''
			}
		},
		yAxis: [
			{
				type: 'value', name: '%', scale: true,
				nameTextStyle: { color: '#64748b' },
				axisLabel: { color: '#334155', formatter: '{value}%' },
				splitLine: { lineStyle: { color: '#dbe3ed' } }
			},
			{
				type: 'value', name: '亿元', min: 0,
				nameTextStyle: { color: '#64748b' },
				axisLabel: { color: '#334155' },
				splitLine: { show: false }
			}
		],
		series: [
			{
				name: '融资余额',
				type: 'line',
				yAxisIndex: 1,
				showSymbol: false,
				smooth: false,
				lineStyle: { width: 2.5, color: '#154575' },
				itemStyle: { color: '#154575' },
				areaStyle: { color: '#7f98b2', opacity: 0.72 },
				markPoint: {
					silent: true,
					symbol: 'circle',
					symbolSize: 8,
					itemStyle: { color: '#154575', borderColor: '#ffffff', borderWidth: 1.5 },
					label: {
						show: true,
						position: 'bottom',
						color: '#154575',
						fontSize: 11,
						fontWeight: 'bolder',
						backgroundColor: 'rgba(255,255,255,0.9)',
						padding: [2, 3],
						borderRadius: 2,
						formatter: (params: any) => `${formatAmount(params.value)}亿`
					},
					data: balancePoints
				},
				tooltip: { valueFormatter: (value: unknown) => `${formatAmount(value)} 亿元` },
				data: values.map((row) => Number(row.balanceYi ?? 0))
			},
			{
				name: '综合融资利率',
				type: 'line',
				yAxisIndex: 0,
				showSymbol: false,
				smooth: 0.12,
				lineStyle: { width: 3, color: '#df2926' },
				itemStyle: { color: '#df2926' },
				markPoint: {
					silent: true,
					symbol: 'circle',
					symbolSize: 8,
					itemStyle: { color: '#df2926', borderColor: '#ffffff', borderWidth: 1.5 },
					label: {
						show: true,
						position: 'top',
						color: '#df2926',
						fontSize: 11,
						fontWeight: 'bolder',
						backgroundColor: 'rgba(255,255,255,0.9)',
						padding: [2, 3],
						borderRadius: 2,
						formatter: (params: any) => `${Number(params.value).toFixed(2)}%`
					},
					data: ratePoints
				},
				tooltip: { valueFormatter: (value: unknown) => `${Number(value).toFixed(2)}%` },
				data: values.map((row) => row.weightedRatePct == null ? null : Number(row.weightedRatePct))
			}
		],
		media: [{
			query: { maxWidth: 560 },
			option: { grid: { left: 8, right: 8, top: 46, bottom: 58, containLabel: true } }
		}]
	});

	function firstIndexOfEachYear(input: typeof values) {
		const seen = new Set<string>();
		const indices: number[] = [];
		input.forEach((row, index) => {
			const year = String(row.date).slice(0, 4);
			if (seen.has(year)) return;
			seen.add(year);
			indices.push(index);
		});
		return indices;
	}

	function withLastIndex(indices: number[], length: number) {
		if (!length) return indices;
		const last = length - 1;
		return indices.includes(last) ? indices : [...indices, last];
	}

	function formatAmount(value: unknown) {
		return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
	}
</script>

{#if values.length}
	<ChartHost {option} ariaLabel="2021年以来公司融资余额与综合融资利率趋势" height={20} />
{:else}
	<div class="chart-empty">暂无可靠的历史余额与利率数据</div>
{/if}

<style>
	.chart-empty { display: grid; min-height: 16rem; place-items: center; color: #64748b; font-size: 0.875rem; }
</style>
