<script lang="ts">
	import ChartHost from '../../components/ChartHost.svelte';
	import { liabilityTypeColor } from './report';

	let {
		rows = [],
		total = 0
	}: {
		rows?: Array<{ type?: string; amountYi?: number }>;
		total?: number;
	} = $props();

	const values = $derived(rows.filter((row) => Number(row.amountYi) > 0));
	const option = $derived({
		aria: { enabled: true, decal: { show: false } },
		tooltip: {
			trigger: 'item',
			formatter: (item: any) => `${escapeHtml(item.name)}<br><b>${Number(item.value).toFixed(2)} 亿元</b>（${Number(item.percent).toFixed(1)}%）`
		},
		title: {
			text: Number(total).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
			subtext: '融资品种合计（亿元）',
			left: 'center',
			top: '41%',
			textStyle: { color: '#0f3d6c', fontSize: 24, fontWeight: 'bolder' },
			subtextStyle: { color: '#64748b', fontSize: 11, lineHeight: 18 }
		},
		series: [{
			type: 'pie',
			radius: ['57%', '78%'],
			center: ['50%', '50%'],
			avoidLabelOverlap: true,
			itemStyle: { borderColor: '#ffffff', borderWidth: 2, borderRadius: 4 },
			label: { show: false },
			emphasis: { scaleSize: 6, label: { show: true, formatter: '{b}\n{d}%', color: '#334155', fontWeight: 'bold' } },
			data: values.map((row, index) => ({
				name: row.type || '未分类',
				value: Number(row.amountYi),
				itemStyle: { color: liabilityTypeColor(row.type, index) }
			}))
		}]
	});

	function escapeHtml(value: unknown) {
		return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
	}
</script>

{#if values.length}
	<ChartHost {option} ariaLabel={`融资余额结构，合计 ${total.toFixed(2)} 亿元，共 ${values.length} 个品种`} height={16} />
{:else}
	<div class="chart-empty">暂无可靠融资余额结构数据</div>
{/if}

<style>
	.chart-empty { display: grid; min-height: 13rem; place-items: center; color: #64748b; font-size: 0.875rem; }
</style>
