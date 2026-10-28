<script lang="ts">
	import ChartHost from '../../components/ChartHost.svelte';

	let {
		label,
		value,
		warning,
		limit,
		maxLabel
	}: {
		label: string;
		value: number | null | undefined;
		warning: number;
		limit: number;
		maxLabel: string;
	} = $props();

	const hasValue = $derived(value != null && Number.isFinite(Number(value)));
	const safeValue = $derived(hasValue ? Math.max(0, Number(value)) : 0);
	const tone = $derived(!hasValue ? '#64748b' : safeValue >= limit ? '#dc2626' : safeValue >= warning ? '#d97706' : '#059669');
	const stateLabel = $derived(!hasValue ? '待配置' : safeValue >= limit ? '超上限' : safeValue >= warning ? '需关注' : '安全');
	const display = $derived(hasValue ? `${safeValue.toFixed(1)}%` : '—');
	const chartMax = $derived(Math.max(limit * 1.2, safeValue * 1.08, 1));
	const option = $derived({
		animationDuration: 280,
		aria: { enabled: true },
		tooltip: {
			trigger: 'item',
			formatter: `${label}<br/>当前：${display}<br/>预警：${warning.toFixed(1)}% ｜ 上限：${maxLabel}`
		},
		series: [{
			type: 'gauge',
			startAngle: 215,
			endAngle: -35,
			center: ['50%', '62%'],
			radius: '82%',
			min: 0,
			max: chartMax,
			splitNumber: 4,
			axisLine: {
				roundCap: true,
				lineStyle: {
					width: 10,
					shadowBlur: 6,
					shadowColor: 'rgba(32, 38, 34, 0.08)',
					color: [
						[Math.min(warning / chartMax, 1), '#059669'],
						[Math.min(limit / chartMax, 1), '#d97706'],
						[1, '#dc2626']
					]
				}
			},
			axisTick: { show: false },
			splitLine: {
				show: true,
				distance: -13,
				length: 6,
				lineStyle: { color: 'rgba(255, 255, 255, 0.92)', width: 1 }
			},
			axisLabel: { show: false },
			pointer: {
				show: hasValue,
				length: '46%',
				width: 3,
				itemStyle: { color: tone, shadowBlur: 5, shadowColor: `${tone}3d` }
			},
			anchor: {
				show: hasValue,
				size: 11,
				itemStyle: {
					color: '#fff',
					borderColor: tone,
					borderWidth: 3,
					shadowBlur: 4,
					shadowColor: 'rgba(32, 38, 34, 0.16)'
				}
			},
			title: { show: false },
			detail: { show: false },
			data: [{ value: safeValue, name: stateLabel }]
		}]
	});
</script>

{#if hasValue}
	<div class="report-gauge-chart">
		<ChartHost {option} ariaLabel={`${label}，当前 ${display}，状态 ${stateLabel}，预警 ${warning}% ，上限 ${maxLabel}`} height={5.2} />
		<strong class="report-gauge-value" style:color={tone}>{display}</strong>
	</div>
{:else}
	<div class="report-gauge-empty">暂无可靠数据</div>
{/if}

<style>
	.report-gauge-chart { display: grid; min-width: 0; justify-items: stretch; }
	.report-gauge-value { margin-top: -0.25rem; font-size: 1.125rem; font-variant-numeric: tabular-nums; line-height: 1; text-align: center; }
	.report-gauge-empty { display: grid; min-height: 6rem; place-items: center; color: #64748b; font-size: 0.875rem; }
</style>
