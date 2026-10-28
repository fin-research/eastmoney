<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
	import { ArrowLeft } from '@lucide/svelte';
	import ModuleCard from '../../../../components/ModuleCard.svelte';
	import PanelHeading from '$lib/trading-research/PanelHeading.svelte';
	import { withBase } from '$lib/financing/app-paths';
	let { data } = $props();
	const debt = $derived(data.debt);
	const amountYi = (value: number | null) => value == null ? '未登记' : `${(value / 100000000).toFixed(4)} 亿元`;
	const statusLabels = new Map([['planned', '未生效'], ['active', '存续'], ['matured', '到期'], ['closed', '关闭']]);
</script>

<svelte:head><title>{debt.name} · 负债详情</title></svelte:head>

<Button data-ui-owner="routes-financing-debts--id---page-svelte" variant="ghost" class={"ui-button  back-link"} href={withBase('/')}><ArrowLeft size={16} />返回仪表盘</Button>
<section class="debt-heading financing-detail-heading">
	<h2>{debt.name}</h2>
	<span>{debt.debtType}{debt.subtype ? ` / ${debt.subtype}` : ''}</span>
</section>

<section class="detail-grid">
	<ModuleCard class="debt-core-card" padding="none" labelledBy="debt-core-title"><div class="detail-card-heading"><PanelHeading id="debt-core-title" title="核心信息" /></div><dl>
		<div><dt>负债大类</dt><dd>{debt.debtType}</dd></div><div><dt>负债小类</dt><dd>{debt.subtype ?? '无'}</dd></div>
		<div><dt>交易对手</dt><dd>{debt.counterparty ?? '未登记'}</dd></div><div><dt>状态</dt><dd><span class={`ui-badge ${debt.status === 'active' ? 'ui-tone-success' : debt.status === 'planned' ? 'ui-tone-info' : 'ui-tone-neutral'}`}>{statusLabels.get(debt.status) ?? debt.status}</span></dd></div>
		<div><dt>本金</dt><dd>{amountYi(debt.amount)}</dd></div><div><dt>应付利息</dt><dd>{amountYi(debt.interestPayable)}</dd></div>
		<div><dt>本息总计</dt><dd>{amountYi(debt.totalAmount)}</dd></div><div><dt>年化利率</dt><dd>{debt.annualRate == null ? '未登记' : `${(debt.annualRate * 100).toFixed(4)}%`}</dd></div>
		<div><dt>起息日</dt><dd>{debt.issueDate ?? '未登记'}</dd></div><div><dt>到期日</dt><dd>{debt.maturityDate ?? '未登记'}</dd></div>
	</dl></ModuleCard>

	<ModuleCard padding="none" labelledBy="debt-cashflows-title"><div class="detail-card-heading"><PanelHeading id="debt-cashflows-title" title="结构化现金流" accent="var(--teal)" /></div><div class="cashflows">
		{#each debt.cashflows as flow}<div><time>{flow.eventDate}</time><strong>{flow.eventType === 'interest' ? '付息' : flow.eventType === 'principal' ? '还本' : flow.eventType === 'fee' ? '费用' : '补充'}</strong><span>{amountYi(flow.amount)}</span></div>{:else}<p>该负债暂无独立结构化现金流记录。</p>{/each}
	</div></ModuleCard>

<ModuleCard class="debt-source-card" padding="none" labelledBy="debt-fields-title"><div class="detail-card-heading"><PanelHeading id="debt-fields-title" title="完整字段" accent="var(--violet)" /></div><div class="source-grid">
	{#each debt.fields as field}<div><span>{field.fieldName}</span><strong>{field.displayValue || '-'}</strong>{#if field.rowSequence > 0}<small>附加记录 {field.rowSequence}</small>{/if}</div>{/each}
</div></ModuleCard>
</section>

<style>
	.detail-grid > :global(.module-card), :global(.debt-source-card) { overflow: hidden; }
	:global(.back-link[data-ui-owner="routes-financing-debts--id---page-svelte"]){display:inline-flex;min-height:2.75rem;align-items:center;gap:.5rem;color:var(--color-primary)}.debt-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;margin:.5rem 0 1rem}.debt-heading h2{margin:0}.debt-heading>span{padding:.375rem .625rem;border-radius:var(--radius-tag);font-size:.875rem;color:var(--color-primary);background:var(--brand-soft)}
	.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.detail-card-heading{padding:1rem 1rem 0;border-bottom:1px solid var(--line)}
	dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin:0}dl>div{min-width:0;padding:.75rem 1rem;border-bottom:1px solid var(--line)}dt{font-size:.875rem;color:var(--text-muted)}dd{margin:.25rem 0 0;font-weight: bold;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.cashflows{display:grid}.cashflows>div{display:grid;grid-template-columns:6.5rem 4rem minmax(0,1fr);gap:.75rem;padding:.75rem 1rem;border-bottom:1px solid var(--line)}.cashflows span{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.cashflows p{padding:1rem;color:var(--text-muted)}
	:global(.debt-source-card){margin-top:0}.source-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;overflow:hidden;background:var(--surface)}.source-grid>div{display:grid;gap:.25rem;padding:.75rem;background:var(--surface);outline:1px solid var(--line)}.source-grid span,.source-grid small{font-size:.875rem;color:var(--text-muted)}.source-grid strong{overflow-wrap:anywhere}
	@media(min-width:1025px){
		.detail-grid{align-items:start}
		:global(.debt-core-card){grid-row:span 2}
		:global(.debt-source-card){margin-top:0}
		.source-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
	}
	@media(max-width:64rem){.detail-grid{grid-template-columns:1fr}.source-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:35rem){.debt-heading{align-items:flex-start;flex-direction:column}dl,.source-grid{grid-template-columns:1fr}.cashflows>div{grid-template-columns:1fr 1fr}}
</style>
