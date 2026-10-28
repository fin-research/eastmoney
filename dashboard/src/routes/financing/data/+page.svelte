<script lang="ts">
import { page } from '$app/state';
import DataAdminTable from '$lib/financing/DataAdminTable.svelte';
import DebtDataEditor from '$lib/financing/DebtDataEditor.svelte';
import { DEBT_ENTITIES } from '$lib/financing/data-admin';
import { getContext } from 'svelte';
import { CLIENT_SESSION_CONTEXT, type ClientSession } from '$lib/client-session';
import ModuleCard from '../../../components/ModuleCard.svelte';
	import '../management.css';
	import FinanceParametersPanel from '$lib/financing/FinanceParametersPanel.svelte';
	import DebtImportPanel from '$lib/financing/DebtImportPanel.svelte';
	import { hasPermission } from '$lib/permissions';

	let { data } = $props();
	const session = getContext<ClientSession>(CLIENT_SESSION_CONTEXT);
	const permissions = $derived($session?.permissions ?? data.permissions);
const entity = $derived(DEBT_ENTITIES.find(item => item.key === page.url.searchParams.get('tab')));
const entry = $derived(page.url.searchParams.get('entry'));
const returnHref = $derived.by(() => { const url = new URL(page.url); url.searchParams.delete('entry'); return url.pathname + url.search; });
</script>

<svelte:head>
	<title>数据后台 · 融资工作台</title>
</svelte:head>

<div class="management-page data-page">
	{#if hasPermission(permissions, 'financing.data:read')}
		{#if entity}
			{#if entry}<DebtDataEditor config={entity} {entry} {returnHref} {permissions}/>{:else}<DataAdminTable config={entity} url={page.url} {permissions}/>{/if}
		{:else}
		{#if hasPermission(permissions, 'financing.data:import')}<DebtImportPanel />{/if}
		<FinanceParametersPanel permissions={permissions} />
		{/if}
	{:else}
		<ModuleCard class="section-card permission-empty">
			<h2>暂无数据后台权限</h2>
			<p>请联系具有“权限配置”权限的人员，为当前角色开通数据后台。</p>
		</ModuleCard>
	{/if}
</div>

<style>
	.data-page { padding-bottom: 5.5rem; }
	@media (min-width: 901px) { .data-page { display: grid; gap: 1.5rem; } }
	:global(.permission-empty) { padding: 1.25rem; }
	:global(.permission-empty) h2 { margin: 0; }
	:global(.permission-empty) p { margin: 0.5rem 0 0; color: #475467; }
</style>
