<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { NativeSelect } from "$lib/components/ui/native-select/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
	import ModuleCard from "../../components/ModuleCard.svelte";
	import PanelHeading from "../trading-research/PanelHeading.svelte";
	import { onMount } from 'svelte';
	import { LoaderCircle, Pencil, Plus, RefreshCw, X } from '@lucide/svelte';
	import type { DataRow } from './data-admin';
	import { FINANCE_PARAMETER_CONFIG, FINANCIAL_INPUT_FIELDS, FINANCIAL_RATIO_FIELDS, financeParameterPayload, financialReconciliation, financialValue, hasFinancialValue } from './finance-parameters';
	import { NeonDataApi } from './neon-data-api';

	import { hasPermission } from '$lib/permissions';
	let { permissions = [] }: { permissions?: string[] } = $props();
	const canCreate = $derived(hasPermission(permissions, 'financing.data:create'));
	const canUpdate = $derived(hasPermission(permissions, 'financing.data:update'));
	const api = new NeonDataApi();
	let rows = $state<DataRow[]>([]);
	let loading = $state(true);
	let loadError = $state('');
	let saveError = $state('');
	let saving = $state(false);
	let notice = $state('');
	let selectedPeriod = $state('');
	let dialog: Modal;
	let original = $state<DataRow | null>(null);
	let month = $state('');
	let values = $state<Record<string, string>>({});
	let notes = $state('');
	const selected = $derived(rows.find((row) => row.period_end === selectedPeriod));
	const preview = $derived(financialReconciliation(values));
	const reconciliation = $derived(selected ? financialReconciliation(selected) : null);

	onMount(() => { void loadRows(); });

	function sortRows(nextRows: DataRow[]) {
		return [...nextRows].sort((a, b) => String(b.period_end).localeCompare(String(a.period_end)));
	}

	async function loadRows() {
		loading = true;
		loadError = '';
		try {
			const nextRows: DataRow[] = [];
			let page = 0;
			while (true) {
				const result = await api.list(FINANCE_PARAMETER_CONFIG, {
					page, pageSize: 100, sortKey: 'period_end', sortDirection: 'desc', search: ''
				});
				nextRows.push(...result.rows);
				if (nextRows.length >= result.total || !result.rows.length) break;
				page += 1;
			}
			rows = sortRows(nextRows);
			if (!rows.some((row) => row.period_end === selectedPeriod)) selectedPeriod = String(rows[0]?.period_end ?? '');
		} catch (error) {
			loadError = error instanceof Error ? error.message : '财务数据读取失败，请重试';
		} finally {
			loading = false;
		}
	}

	function openEditor(row: DataRow | null = null) {
		original = row;
		month = String(row?.period_end ?? '').slice(0, 7);
		values = Object.fromEntries(FINANCIAL_INPUT_FIELDS.map((field) => [field.key, row?.[field.key] == null ? '' : String(row[field.key])]));
		notes = String(row?.notes ?? '');
		saveError = '';
		notice = '';
		dialog.showModal();

	}

	async function save() {
		if (saving) return;
		saving = true;
		saveError = '';
		try {
			const payload = financeParameterPayload(month, values, notes);
			if (!original && rows.some((row) => row.period_end === payload.period_end)) throw new Error('该月份已存在，请取消后选择对应月份编辑');
			const { period_end: periodEnd, ...changes } = payload;
			const savedRows = original
				? await api.update(FINANCE_PARAMETER_CONFIG, original, changes)
				: await api.insert(FINANCE_PARAMETER_CONFIG, payload);
			const saved = savedRows[0];
			if (!saved || saved.period_end !== periodEnd) throw new Error('未取得保存结果，请核对数据后重试');
			rows = sortRows(original ? rows.map((row) => row.period_end === saved.period_end ? saved : row) : [...rows, saved]);
			selectedPeriod = String(saved.period_end);
			notice = `${month} 财务数据已保存`;
			dialog.close();
		} catch (error) {
			saveError = error instanceof Error ? error.message : '保存失败，请重试';
		} finally {
			saving = false;
		}
	}
</script>

<ModuleCard class="section-card parameter-panel" labelledBy="finance-parameters-title">
<div aria-busy={loading}>
	<PanelHeading id="finance-parameters-title" title="月度财务数据" controlsInline>
		<Button data-ui-owner="lib-financing-FinanceParametersPanel-svelte" variant="outline" class={"ui-button secondary-action"} type="button" onclick={() => void loadRows()} disabled={loading || saving} aria-label="刷新财务数据"><RefreshCw size={17} class={loading ? 'spin' : ''} />刷新</Button>
		<span class="parameter-unit">单位：亿元</span>
	</PanelHeading>
	<p class="save-notice" aria-live="polite">{notice}</p>
	{#if loading}
		<p class="empty-state"><LoaderCircle size={18} class="spin" /> 正在读取财务数据…</p>
	{:else if loadError}
		<p class="error-message" role="alert">{loadError}</p>
	{:else if !rows.length}
		<p class="empty-state">暂无月度数据</p>
	{:else}
		<div class="month-toolbar">
			<label><span>数据月份</span><NativeSelect data-ui-owner="lib-financing-FinanceParametersPanel-svelte" class={"ui-select"} bind:value={selectedPeriod}>{#each rows as row (String(row.period_end))}<option value={String(row.period_end)}>{String(row.period_end).slice(0, 7)}</option>{/each}</NativeSelect></label>
			<span class="history-count">已保存 {rows.length} 个月</span>
			{#if canUpdate}<Button data-ui-owner="lib-financing-FinanceParametersPanel-svelte" variant="outline" class={"ui-button secondary-action"} type="button" onclick={() => openEditor(selected ?? null)}><Pencil size={17} />编辑本月</Button>{/if}
		</div>
		{#if selected}
			<div class="parameter-grid">
				{#each FINANCIAL_INPUT_FIELDS as field (field.key)}
					<article class="parameter-card"><h3>{field.label}</h3><p class="parameter-value" class:parameter-value--empty={!hasFinancialValue(selected[field.key])}>{financialValue(selected[field.key], false, { unit: false })}{#if hasFinancialValue(selected[field.key])}<span>亿元</span>{/if}</p></article>
				{/each}
				{#each FINANCIAL_RATIO_FIELDS as field (field.key)}
					<article class="parameter-card computed"><h3>{field.label.replace('（%）', '').replace('，%', '')}<span>计算值</span></h3><p class="parameter-value" class:parameter-value--empty={!hasFinancialValue(selected[field.key])}>{financialValue(selected[field.key], true, { unit: false })}{#if hasFinancialValue(selected[field.key])}<span>%</span>{/if}</p></article>
				{/each}
			</div>
			{#if reconciliation?.difference != null}
				<p class="reconciliation" class:mismatch={Math.abs(reconciliation.difference) > 0.00015}>
					{#if Math.abs(reconciliation.difference) <= 0.00015}勾稽一致。{:else}待核对：相差 {financialValue(reconciliation.difference)}，请核对证券净资产与资产负债。{/if}
				</p>
			{/if}
			{#if selected.notes}<p class="parameter-notes">{String(selected.notes)}</p>{/if}
		{/if}
	{/if}
</div>
</ModuleCard>

{#if !loading && !loadError}
	{#if canCreate}<Button data-ui-owner="lib-financing-FinanceParametersPanel-svelte" variant="default" class={"ui-button  floating-create-button"} type="button" aria-label="新增月份" onclick={() => openEditor()}><Plus size={24} /></Button>{/if}
{/if}

<Modal  bind:this={dialog} aria-labelledby="parameter-editor-title" oncancel={(event) => { if (saving) event.preventDefault(); }}>
<div class="dialog-body config-modal management-page">
	<form onsubmit={(event) => { event.preventDefault(); void save(); }}>
		<div class="modal-header"><h2 id="parameter-editor-title">{original ? '编辑' : '新增'}月度财务数据</h2><Button data-ui-owner="lib-financing-FinanceParametersPanel-svelte" variant="outline" class={"ui-button"} type="button" aria-label="关闭财务数据编辑" onclick={() => dialog.close()} disabled={saving}><X size={20} /></Button></div>
		<fieldset disabled={saving}>
			<div class="form-grid">
				<label class="wide"><span>数据月份</span><Input data-ui-owner="lib-financing-FinanceParametersPanel-svelte" class={"ui-input"} type="month" bind:value={month} readonly={Boolean(original)} min="1900-01" required /></label>
				{#each FINANCIAL_INPUT_FIELDS as field (field.key)}
					<label><span>{field.label}（亿元）</span><Input data-ui-owner="lib-financing-FinanceParametersPanel-svelte" class={"ui-input"} type="number" value={values[field.key] ?? ''} oninput={(event) => values = { ...values, [field.key]: event.currentTarget.value }} min={field.min} step="0.0001" /></label>
				{/each}
				<label class="wide"><span>来源与说明</span><Textarea data-ui-owner="lib-financing-FinanceParametersPanel-svelte" class={"ui-textarea"} bind:value={notes} rows={3}></Textarea></label>
			</div>
		</fieldset>
		<div class="ratio-preview" aria-live="polite">
			<p>资产负债率：<strong>{financialValue(preview.asset_liability_ratio, true)}</strong></p>
			<p>扣代理买卖后：<strong>{financialValue(preview.adjusted_asset_liability_ratio, true)}</strong></p>
			{#if preview.difference != null && Math.abs(preview.difference) > 0.00015}<p class="mismatch">勾稽差额：{financialValue(preview.difference)}，请核对证券净资产与资产负债的主体和口径。</p>{/if}
		</div>
		{#if saveError}<p class="error-message" role="alert">{saveError}</p>{/if}
		<div class="modal-actions"><Button data-ui-owner="lib-financing-FinanceParametersPanel-svelte" variant="outline" class={"ui-button"} type="button" onclick={() => dialog.close()} disabled={saving}>取消</Button><Button data-ui-owner="lib-financing-FinanceParametersPanel-svelte" variant="default" class={"ui-button "} type="submit" disabled={saving}>{#if saving}<LoaderCircle size={17} class="spin" />{/if}{saving ? '保存中…' : '保存'}</Button></div>
	</form>
</div>
</Modal>

<style>
	.parameter-unit { color: var(--text-muted); font-size: .875rem; }
	.save-notice { margin: 0; padding-inline: 1.125rem; color: var(--teal); }
	.save-notice:not(:empty) { padding-bottom: 1rem; }
	.month-toolbar { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; padding: 0 0 1rem; }
	.month-toolbar label { display: flex; flex: 0 0 auto; align-items: center; gap: .5rem; }
	.month-toolbar label span { white-space: nowrap; font-size: .875rem; color: var(--text-muted); }
	:global(.month-toolbar select[data-ui-owner="lib-financing-FinanceParametersPanel-svelte"]) { width: 9rem; padding-inline: .75rem; }
	.history-count { margin-right: auto; color: var(--text-muted); font-size: .875rem; }
	.parameter-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; padding: 0; }
	.parameter-card { min-width: 0; padding: .875rem; border: 1px solid var(--line); border-radius: .5rem; overflow-wrap: anywhere; }
	h3 { display: flex; flex-wrap: wrap; align-items: baseline; gap: .5rem; margin: 0; font-size: 1rem; font-weight: bold; }
	h3 span { font-size: .75rem; color: var(--text-muted); font-weight: normal; }
	.parameter-value { display: flex; flex-wrap: wrap; align-items: baseline; gap: .25rem; margin: .75rem 0 0; font-size: clamp(1.125rem, 1.6vw, 1.5rem); font-weight: bold; font-variant-numeric: tabular-nums; }
	.parameter-value > span { color: var(--text-muted); font-size: .875rem; font-weight: normal; }
	.parameter-value--empty { color: var(--text-muted); font-size: 1rem; font-weight: normal; }
	.computed { background: var(--canvas); }
	.parameter-notes, .reconciliation { margin: 0; padding: 0 0 1rem; font-size: .875rem; overflow-wrap: anywhere; }
	.parameter-notes { color: var(--text-muted); white-space: pre-wrap; }
	.reconciliation { color: var(--teal); }
	.mismatch { color: var(--red); }
	.error-message { margin: 0; padding: 1rem 1.125rem; color: var(--red); overflow-wrap: anywhere; }
	fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
	.ratio-preview { padding: .75rem; border-radius: .5rem; background: var(--canvas); }
	.ratio-preview p { margin: 0 0 .5rem; }
	.config-modal .error-message { padding-inline: 0; }
	:global(input[data-ui-owner="lib-financing-FinanceParametersPanel-svelte"]), :global(select[data-ui-owner="lib-financing-FinanceParametersPanel-svelte"]), :global(textarea[data-ui-owner="lib-financing-FinanceParametersPanel-svelte"]) { min-width: 0; }
	@media (min-width: 901px) {
		.parameter-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
		.parameter-card { display: flex; flex-direction: column; gap: .75rem; }
		.parameter-value { margin-top: auto; }
		.parameter-notes, .reconciliation { margin-top: 1rem; }
	}
	@media (max-width: 75rem) { .parameter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
	@media (max-width: 35rem) { .parameter-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
