<script lang="ts">
  import { Badge as UiBadge } from "$lib/components/ui/badge/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import Modal from "$lib/components/Modal.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { NativeSelect } from "$lib/components/ui/native-select/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
import { CLIENT_SESSION_CONTEXT, type ClientSession } from '$lib/client-session';
import PanelHeading from '$lib/trading-research/PanelHeading.svelte';
import ModuleCard from '../../../components/ModuleCard.svelte';
	import '../management.css';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { getContext, untrack } from 'svelte';
	import {
		ArrowRight,
		BellRing,
		Clock3,
		GitBranch,
		Mail,
		Plus,
		Trash2,
		UserRound,
		Workflow
	} from '@lucide/svelte';
	import { globalMessages } from '$lib/global-messages';
	import { withBase } from '$lib/financing/app-paths';
	import { MAX_REMINDER_PERIODS, reminderPeriodLabel } from '$lib/financing/reminder-periods.js';
	import { hasPermission } from '$lib/permissions';

	let { data } = $props();
	const session = getContext<ClientSession>(CLIENT_SESSION_CONTEXT);
	const permissions = $derived($session?.permissions ?? data.permissions);
	let reminderDialog = $state<Modal>();
	let sopDialog = $state<Modal>();
	let reminderRecipientMode = $state('assignee');
	let reminderPeriodSequence = 1;
	let reminderPeriods = $state([{ key: 'period-1', days: 3, hours: 0 }]);
	let actionState = $state<{
		key: string;
		status: 'idle' | 'pending';
	}>({ key: '', status: 'idle' });

	const fallback = {
		sopTemplates: [],
		reminderRules: []
	};
	let displayedSettings = $state(untrack(() => data?.settings ?? fallback));
	$effect(() => {
		displayedSettings = data?.settings ?? fallback;
	});
	const settings = $derived(displayedSettings);
	const canManage = $derived(hasPermission(permissions, 'financing.sop:update'));
	const canCreateSop = $derived(hasPermission(permissions, 'financing.sop:create'));
	const canCreateReminder = $derived(hasPermission(permissions, 'financing.reminder:create'));
	const activeSopTemplates = $derived(
		settings.sopTemplates.filter((sop: { isActive: boolean }) => sop.isActive)
	);

	function resetReminderDraft() {
		reminderRecipientMode = 'assignee';
		reminderPeriodSequence += 1;
		reminderPeriods = [{ key: `period-${reminderPeriodSequence}`, days: 3, hours: 0 }];
	}

	function addReminderPeriod() {
		if (reminderPeriods.length >= MAX_REMINDER_PERIODS) return;
		const usedLeadHours = new Set(reminderPeriods.map((period) => period.days * 24 + period.hours));
		let leadHours = 24;
		while (usedLeadHours.has(leadHours)) leadHours += 24;
		reminderPeriodSequence += 1;
		reminderPeriods = [...reminderPeriods, {
			key: `period-${reminderPeriodSequence}`,
			days: Math.floor(leadHours / 24),
			hours: leadHours % 24
		}];
	}

	function removeReminderPeriod(key: string) {
		if (reminderPeriods.length === 1) return;
		reminderPeriods = reminderPeriods.filter((period) => period.key !== key);
	}

	const enhanceAction = (key: string, successMessage: string): SubmitFunction => {
		return ({ formElement }) => {
			actionState = { key, status: 'pending' };
			return async ({ result, update }) => {
				if (result.type === 'success') {
					if (result.data?.sopTemplate) {
						displayedSettings = {
							...displayedSettings,
							sopTemplates: [...displayedSettings.sopTemplates, result.data.sopTemplate]
								.sort((left: any, right: any) => `${left.debtType}\0${left.name}`.localeCompare(`${right.debtType}\0${right.name}`, 'zh-CN'))
						};
					}
					if (result.data?.reminderRule) {
						displayedSettings = {
							...displayedSettings,
							reminderRules: [...displayedSettings.reminderRules, result.data.reminderRule]
								.sort((left: any, right: any) => Number(right.isActive) - Number(left.isActive) || left.name.localeCompare(right.name, 'zh-CN'))
						};
					}
					await update({ reset: false, invalidateAll: false });
					globalMessages.success(String(result.data?.message ?? successMessage), {
						key: 'sop-management-action'
					});
					actionState = { key: '', status: 'idle' };
					if (key === 'reminder') {
						formElement.reset();
						resetReminderDraft();
						reminderDialog?.close();
					}
					if (key === 'sop') sopDialog?.close();
					return;
				}
				await update({ reset: false, invalidateAll: false });
				const message = result.type === 'failure'
					? String(result.data?.message ?? '提交失败，请检查后重试')
					: result.type === 'error' && result.error?.message
						? result.error.message
						: '提交失败，请稍后重试';
				globalMessages.error(message, { key: 'sop-management-action' });
				actionState = { key: '', status: 'idle' };
			};
		};
	};
</script>

<svelte:head>
	<title>SOP 管理 · 融资工作台</title>
</svelte:head>

<div class="management-page workflow-page">
	<section class="workflow-grid">
		<ModuleCard class="section-card">
			<PanelHeading id="sop-heading-0" title="负债品种 SOP" controlsInline />
			<div class="sop-list">
				{#each settings.sopTemplates as sop}
					<a data-ui-owner="routes-financing-sop--page-svelte" class="sop-item" href={withBase(`/sop/${sop.id}`)}>
						<span class="sop-type">{sop.debtType.slice(0, 2)}</span>
						<div class="sop-copy">
							<div>
								<strong>{sop.name}</strong>
								<UiBadge variant="secondary"  class={["ui-tone-success status-badge",!sop.isActive && "inactive"]}>
									{sop.isActive ? '启用' : '停用'}
								</UiBadge>
							</div>
							{#if sop.description}<p>{sop.description}</p>{/if}
							<div class="sop-meta">
								<span><GitBranch size={13} /> {sop.nodeCount} 个节点</span>
							</div>
						</div>
						<ArrowRight size={16} />
					</a>
				{:else}
					<p class="empty-state">尚未配置 SOP</p>
				{/each}
			</div>
		</ModuleCard>

		<ModuleCard class="section-card">
			<PanelHeading id="sop-heading-1" title="提醒规则" accent="var(--orange)" controlsInline><div class="header-actions">
					<Button data-ui-owner="routes-financing-sop--page-svelte" variant="ghost" class={"ui-button  link-button"} href={withBase('/sop/reminders')}>发送历史</Button>
					{#if canCreateReminder}
						<Button data-ui-owner="routes-financing-sop--page-svelte" variant="outline" class={"ui-button link-button"} type="button" onclick={() => reminderDialog?.showModal()}>
							<Plus size={14} /> 新增提醒
						</Button>
					{/if}
				</div></PanelHeading>
			<div class="reminder-list">
				{#each settings.reminderRules as rule}
					<div class="reminder-item">
						<span class="channel-icon"><Mail size={17} /></span>
						<div>
							<div class="rule-title">
								<strong>{rule.name}</strong>
								<UiBadge variant="secondary"  class={["ui-tone-success status-badge",!rule.isActive && "inactive"]}>
									{rule.isActive ? '启用' : '停用'}
								</UiBadge>
							</div>
							<p>
								<GitBranch size={13} />
								{rule.targets.length} 个节点：{rule.targets.map((target: any) => `${target.sopName} / ${target.name}`).join('、')}
							</p>
							<div class="rule-meta">
								<span><Clock3 size={12} /> {rule.periods.map((period: any) => reminderPeriodLabel(period.leadHours)).join('、')}</span>
								<span><UserRound size={12} />
									{rule.recipientMode === 'owner'
										? '项目负责人'
										: rule.recipientMode === 'custom'
											? '指定邮箱'
											: '任务负责人'}
								</span>
							</div>
						</div>
					</div>
				{:else}
					<p class="empty-state">尚未配置提醒规则。</p>
				{/each}
			</div>
		</ModuleCard>
	</section>

	{#if canCreateSop}
	<Button data-ui-owner="routes-financing-sop--page-svelte" variant="default"
		class={"ui-button  floating-create-button"}
		type="button"
		onclick={() => sopDialog?.showModal()}
		aria-label="新建 SOP"
	>
		<Plus size={23} />
	</Button>
	{/if}

	{#if canCreateReminder}
	<Modal bind:this={reminderDialog} aria-label="配置邮件提醒" class="w-[min(36rem,calc(100vw-3rem))]" onclose={resetReminderDraft}>
<div class="dialog-body config-modal management-page">
		<form method="post" action="?/createReminder" use:enhance={enhanceAction('reminder', '提醒规则已保存')}>
			<div class="modal-header">
				<div>
					<h2>配置邮件提醒</h2>
				</div>
				<Button data-ui-owner="routes-financing-sop--page-svelte" variant="outline" class={"ui-button"} type="button" aria-label="关闭" onclick={() => reminderDialog?.close()}>×</Button>
			</div>
			<div class="form-grid">
				<label class="wide">
					<span>规则名称</span>
					<Input data-ui-owner="routes-financing-sop--page-svelte" class={"ui-input"} name="name" required value="任务到期提醒" />
				</label>
				<fieldset class="wide rule-fieldset node-selector">
					<legend>关联 SOP 节点</legend>
					<div class="node-groups">
						{#each activeSopTemplates as sop}
							<section class="node-group">
								<strong>{sop.name}<span>{sop.debtType}</span></strong>
								<div>
									{#each sop.nodes as node}
										<label>
											<Checkbox data-ui-owner="routes-financing-sop--page-svelte"  name="nodeIds" value={node.id} />
											<span>{node.name}</span>
										</label>
									{:else}
										<p>该 SOP 尚未配置节点</p>
									{/each}
								</div>
							</section>
						{:else}
							<p class="empty-selector">尚无可关联的已启用 SOP 节点。</p>
						{/each}
					</div>
				</fieldset>
				<fieldset class="wide rule-fieldset period-editor">
					<legend>提醒周期</legend>
					<div class="fieldset-heading">
						<Button data-ui-owner="routes-financing-sop--page-svelte" variant="outline" type="button" class={"ui-button add-period"} onclick={addReminderPeriod} disabled={reminderPeriods.length >= MAX_REMINDER_PERIODS}><Plus size={14} /> 添加周期</Button>
					</div>
					<div class="period-list">
						{#each reminderPeriods as period, index (period.key)}
							<div class="period-row">
								<span>第 {index + 1} 次</span>
								<label>
									<span>天</span>
									<Input data-ui-owner="routes-financing-sop--page-svelte" class={"ui-input"} name="periodDays" type="number" min="0" max="3650" step="1" required bind:value={period.days} />
								</label>
								<label>
									<span>小时</span>
									<Input data-ui-owner="routes-financing-sop--page-svelte" class={"ui-input"} name="periodHours" type="number" min="0" max="23" step="1" required bind:value={period.hours} />
								</label>
								<Button data-ui-owner="routes-financing-sop--page-svelte" variant="destructive"
									type="button"
									class={"ui-button  remove-period"}
									onclick={() => removeReminderPeriod(period.key)}
									disabled={reminderPeriods.length === 1}
									aria-label={`删除第 ${index + 1} 个提醒周期`}
								><Trash2 size={15} /></Button>
							</div>
						{/each}
					</div>
				</fieldset>
				<label class="wide">
					<span>收件人</span>
					<NativeSelect data-ui-owner="routes-financing-sop--page-svelte" class={"ui-select"} name="recipientMode" bind:value={reminderRecipientMode}>
						<option value="assignee">任务负责人</option>
						<option value="owner">项目负责人</option>
						<option value="custom">指定邮箱</option>
					</NativeSelect>
				</label>
				{#if reminderRecipientMode === 'custom'}
					<label class="wide">
						<span>指定邮箱</span>
						<Input data-ui-owner="routes-financing-sop--page-svelte" class={"ui-input"} name="recipients" type="email" multiple required />
					</label>
				{/if}
			</div>
			<div class="modal-actions">
				<Button data-ui-owner="routes-financing-sop--page-svelte" variant="outline" class={"ui-button"} type="button" onclick={() => reminderDialog?.close()}>取消</Button>
				<Button data-ui-owner="routes-financing-sop--page-svelte" variant="default" class={"ui-button  primary-action"} type="submit" disabled={actionState.status === 'pending'}>
					{actionState.status === 'pending' && actionState.key === 'reminder' ? '保存中…' : '保存规则'}
				</Button>
			</div>
		</form>
	</div>
</Modal>
	{/if}

	{#if canCreateSop}
	<Modal bind:this={sopDialog} aria-label="新建负债品种 SOP" class="w-[min(36rem,calc(100vw-3rem))]">
<div class="dialog-body config-modal management-page">
		<form method="post" action="?/createSop" use:enhance={enhanceAction('sop', 'SOP 模板已创建')}>
			<div class="modal-header">
				<div>
					<h2>新建负债品种 SOP</h2>
				</div>
				<Button data-ui-owner="routes-financing-sop--page-svelte" variant="outline" class={"ui-button"} type="button" aria-label="关闭" onclick={() => sopDialog?.close()}>×</Button>
			</div>
			<div class="form-grid">
				<label class="wide">
					<span>SOP 名称</span>
					<Input data-ui-owner="routes-financing-sop--page-svelte" class={"ui-input"} name="name" required />
				</label>
				<label class="wide">
					<span>负债品种</span>
					<NativeSelect data-ui-owner="routes-financing-sop--page-svelte" class={"ui-select"} name="debtType" required>
						<option value="">请选择</option>
						<option>收益凭证</option>
						<option>公司债</option>
						<option>短期融资券</option>
						<option>转融资</option>
						<option>同业拆借</option>
						<option>集团借款</option>
					</NativeSelect>
				</label>
				<label class="wide">
					<span>说明</span>
					<Textarea data-ui-owner="routes-financing-sop--page-svelte" class={"ui-textarea"} name="description" rows={3}></Textarea>
				</label>
			</div>
			<div class="modal-actions">
				<Button data-ui-owner="routes-financing-sop--page-svelte" variant="outline" class={"ui-button"} type="button" onclick={() => sopDialog?.close()}>取消</Button>
				<Button data-ui-owner="routes-financing-sop--page-svelte" variant="default" class={"ui-button  primary-action"} type="submit" disabled={actionState.status === 'pending'}>
					{actionState.status === 'pending' && actionState.key === 'sop' ? '创建中…' : canManage ? '创建并配置节点' : '创建 SOP'}
				</Button>
			</div>
		</form>
	</div>
</Modal>
	{/if}
</div>

<style>
	.workflow-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.2fr) minmax(20rem, 0.8fr);
		gap: 1rem;
	}

	.sop-list,
	.reminder-list {
		display: grid;
	}

	.sop-item {
		display: grid;
		grid-template-columns: 2.75rem minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.875rem;
		padding: 1rem 1.125rem;
		border-top: 1px solid var(--line);
		transition: background 180ms ease;
	}

	.sop-item:hover {
		background: #f8faff;
	}

	.sop-type,
	.channel-icon {
		display: grid;
		width: 2.5rem;
		height: 2.5rem;
		place-items: center;
		border-radius: 0.5rem;
		font-size: 0.75rem;
		font-weight: bold;
		color: var(--color-primary);
		background: #eff4ff;
	}

	.sop-copy > div:first-child,
	.rule-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.sop-copy p,
	.reminder-item p {
		margin: 0.25rem 0;
		color: #667085;
	}

	.reminder-item p {
		display: flex;
		align-items: flex-start;
		gap: 0.35rem;
		line-height: 1.55;
	}

	.sop-meta,
	.rule-meta {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		font-size: 0.75rem;
		color: #98a2b3;
	}

	.sop-meta span,
	.rule-meta span {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}

	.rule-meta {
		flex-wrap: wrap;
	}

	.reminder-item {
		display: grid;
		grid-template-columns: 2.75rem minmax(0, 1fr);
		gap: 0.75rem;
		padding: 1rem 1.125rem;
		border-top: 1px solid var(--line);
	}

	.channel-icon {
		color: #b54708;
		background: #fff7ed;
	}

	.rule-fieldset {
		grid-column: 1 / -1;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.rule-fieldset > legend {
		font-weight: bold;
		color: #344054;
	}

	.node-groups,
	.period-list {
		display: grid;
		gap: 0.625rem;
		margin-top: 0.625rem;
	}

	.node-groups {
		max-height: min(32vh, 18rem);
		overflow-y: auto;
		padding: 0.625rem;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		background: #f8fafc;
	}

	.node-group {
		display: grid;
		gap: 0.5rem;
	}

	.node-group + .node-group {
		padding-top: 0.625rem;
		border-top: 1px solid var(--line);
	}

	.node-group > strong {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		color: #1d2939;
	}

	.node-group > strong span {
		font-size: 0.75rem;
		font-weight: normal;
		color: #667085;
	}

	.node-group > div {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.375rem 0.75rem;
	}

	.node-group label {
		display: grid;
		grid-template-columns: 1.25rem minmax(0, 1fr);
		align-items: center;
		gap: 0.5rem;
		min-height: 2.75rem;
		cursor: pointer;
	}

	:global(.node-group input[data-ui-owner="routes-financing-sop--page-svelte"]) {
		width: 1.125rem;
		padding: 0;
	}

	.fieldset-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	:global(.add-period[data-ui-owner="routes-financing-sop--page-svelte"]) {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding-inline: 0.75rem;
	}

	.period-row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr) 2.75rem;
		align-items: end;
		gap: 0.5rem;
	}

	.period-row > span {
		align-self: center;
		font-size: 0.75rem;
		font-weight: bold;
		color: #667085;
	}

	.period-row label {
		display: grid;
		gap: 0.25rem;
	}

	.period-row label span {
		font-size: 0.75rem;
		color: #667085;
	}

	:global(.period-row input[data-ui-owner="routes-financing-sop--page-svelte"]) {
		width: 100%;
		padding-inline: 0.75rem;
	}

	:global(.remove-period[data-ui-owner="routes-financing-sop--page-svelte"]) {
		display: grid;
		width: 2.75rem;
		place-items: center;
	}

	@media (max-width: 64rem) {
		.workflow-grid {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 51.25rem) {
    .sop-item { grid-template-columns: 2.5rem minmax(0, 1fr) auto; align-items: start; gap: .75rem; padding: 1rem 0; }
    .sop-copy { display: contents; }
    .sop-copy p, .sop-meta { grid-column: 1 / -1; }
    .sop-copy > div:first-child { flex-wrap: wrap; }
    .sop-item > :global(svg) { grid-column: 3; grid-row: 1; }

		.rule-fieldset {
			grid-column: auto;
		}
		.node-group > div {
			grid-template-columns: 1fr;
		}

		.fieldset-heading {
			align-items: stretch;
			flex-direction: column;
		}

		.period-row {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 2.75rem;
		}

		.period-row > span {
			grid-column: 1 / -1;
		}

	}
</style>
