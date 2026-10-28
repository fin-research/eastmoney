<script lang="ts">
  import { defaults, superForm } from 'sveltekit-superforms';
  import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
  import { projectCreateSchema } from '$lib/financing/project-form';
  import Modal from "$lib/components/Modal.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { NativeSelect } from "$lib/components/ui/native-select/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
import { CLIENT_SESSION_CONTEXT, type ClientSession } from '$lib/client-session';
import ModuleCard from '../../../components/ModuleCard.svelte';
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { getContext, untrack, tick } from 'svelte';
	import {
		ArrowRight,
		CalendarDays,
		CheckCircle2,
		ChevronDown,
		ChevronRight,
		CircleDashed,
		Clock3,
		Filter,
		Flag,
		LoaderCircle,
		Pencil,
		Plus,
		Search,
		Trash2,
		Users
	} from '@lucide/svelte';
	import MultiSelectFilter from '$lib/financing/MultiSelectFilter.svelte';
	import { autoSave, completeAutoSave, getAutoSaveRevision } from '$lib/financing/auto-save';
	import { withBase } from '$lib/financing/app-paths';
	import { globalMessages } from '$lib/global-messages';
	import { hasPermission } from '$lib/permissions';
	import { buildProjectPageData } from '$lib/financing/project-page.js';

	let { data } = $props();
	const session = getContext<ClientSession>(CLIENT_SESSION_CONTEXT);
	const permissions = $derived($session?.permissions ?? data.permissions);
	let selectedTypes = $state<string[]>([]);
	const initialOwnerSelection = () =>
		data?.viewContext?.defaultOwnProjects && data?.viewContext?.personName
			? [data.viewContext.personName]
			: [];
	let selectedOwners = $state<string[]>(initialOwnerSelection());
	let selectedStatuses = $state<string[]>([]);
	let view = $state<'month' | 'quarter'>('month');
	let expandedProject = $state<string | number | null>(null);
	let newProjectDialog: Modal;
	let editProjectDialog: Modal;
	let editingProject = $state<any>(null);
	const { form: projectForm, errors: projectErrors, validateForm: validateProject, reset: resetProject } = superForm(
    defaults(zod4(projectCreateSchema)),
    { validators: zod4Client(projectCreateSchema), resetForm: false, applyAction: false, invalidateAll: false }
  );
	const initialProjectSources = untrack(() => data?.projectSources ?? []);
	let projectSources = $state<any[]>([...initialProjectSources]);
	let projectOptions = $state<{ people: any[]; projectSops: any[] }>({ people: [], projectSops: [] });
	let projectOptionsStatus = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	let projectOptionsRequest: Promise<boolean> | null = null;
	let actionState = $state<{ key: string; status: 'idle' | 'pending' }>({
		key: '', status: 'idle'
	});
	const canManage = $derived(hasPermission(permissions, 'financing.project:update'));
	const canCreate = $derived(hasPermission(permissions, 'financing.project:create'));
	const canDelete = $derived(hasPermission(permissions, 'financing.project:delete'));

	function showAutoSaved(message: string) {
		globalMessages.success(message, { key: 'project-list-auto-save', duration: 3000, title: '项目已同步' });
		actionState = { key: '', status: 'idle' };
	}

	const enhanceProjectAction = (key: string, dialog?: 'create'): SubmitFunction => async ({ formElement, cancel }) => {
    if (key === 'create') {
      const validation = await validateProject({ update: true });
      if (!validation.valid) {
        cancel();
        globalMessages.error(Object.values(validation.errors).flat().filter(Boolean).join('；'));
        await tick();
        formElement.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
        return;
      }
    }
		const isAutoSave = key === 'edit';
		const submittedRevision = isAutoSave ? getAutoSaveRevision(formElement) : 0;
		actionState = { key, status: 'pending' };
		return async ({ result, update }) => {
			const responseIsCurrent = !isAutoSave || submittedRevision === getAutoSaveRevision(formElement);
			if (result.type === 'success') {
				const returnedProject = result.data?.project ?? null;
				if (responseIsCurrent && returnedProject) {
					const existingIndex = projectSources.findIndex((project: any) => project.id === returnedProject.id);
					projectSources = existingIndex >= 0
						? projectSources.map((project: any) => project.id === returnedProject.id ? returnedProject : project)
						: [...projectSources, returnedProject];
				}
				const deletedProjectId = String(result.data?.deletedProjectId ?? '');
				if (deletedProjectId) {
					projectSources = projectSources.filter((project: any) => project.id !== deletedProjectId);
					if (String(expandedProject ?? '') === deletedProjectId) expandedProject = null;
				}
				await update({ reset: false, invalidateAll: false });
				if (responseIsCurrent && result.data?.refreshReminders) {
					await invalidate('financing:reminders');
				}
				if (isAutoSave) {
					if (responseIsCurrent) {
						const confirmed = projects.find((project: any) => String(project.id) === String(editingProject?.id));
						if (confirmed) editingProject = confirmed;
						showAutoSaved('已保存');
					} else {
						actionState = { key, status: 'pending' };
					}
				} else {
					globalMessages.success(String(result.data?.message ?? '项目已保存'), {
						key: 'project-list-action'
					});
					actionState = { key: '', status: 'idle' };
				}
				if (dialog === 'create') { newProjectDialog?.close(); resetProject(); }
				if (isAutoSave) completeAutoSave(formElement, true);
				return;
			}
			await update({ reset: false, invalidateAll: false });
      if (key === 'create' && result.type === 'failure') {
        const failedForm = result.data?.form as { errors?: typeof $projectErrors } | undefined;
        if (failedForm?.errors) {
          $projectErrors = failedForm.errors;
          await tick();
          formElement.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
        }
      }
			const message = result.type === 'failure'
				? String(result.data?.message ?? '保存失败，请检查填写内容后重试。')
				: result.type === 'error' && result.error?.message
					? result.error.message
					: '保存失败，请稍后重试。';
			globalMessages.error(message, { key: isAutoSave ? 'project-list-auto-save' : 'project-list-action' });
			actionState = { key: '', status: 'idle' };
			if (isAutoSave) completeAutoSave(formElement, false);
		};
	};

	function ensureProjectOptions() {
		if (projectOptionsStatus === 'ready') return Promise.resolve(true);
		if (projectOptionsRequest) return projectOptionsRequest;
		projectOptionsStatus = 'loading';
		projectOptionsRequest = (async () => {
			try {
				const response = await fetch(withBase('/projects/options'), {
					headers: { Accept: 'application/json' },
					cache: 'no-store'
				});
				if (!response.ok) throw new Error(`项目表单选项加载失败（${response.status}）`);
				const options = await response.json();
				projectOptions = {
					people: Array.isArray(options?.people) ? options.people : [],
					projectSops: Array.isArray(options?.projectSops) ? options.projectSops : []
				};
				projectOptionsStatus = 'ready';
				return true;
			} catch (error) {
				projectOptionsStatus = 'error';
				globalMessages.error(
					error instanceof Error ? error.message : '项目表单选项加载失败，请稍后重试',
					{ key: 'project-form-options' }
				);
				return false;
			} finally {
				projectOptionsRequest = null;
			}
		})();
		return projectOptionsRequest;
	}

	function openNewProject() {
		$projectForm.plannedBookbuildingDate = data.today;
    $projectForm.ownerId = data.viewContext.personId ?? '';
		newProjectDialog.showModal();
		void ensureProjectOptions();
	}

	function openEditProject(project: any) {
		editingProject = project;
		editProjectDialog.showModal();
		void ensureProjectOptions();
	}

	const projectPage = $derived(buildProjectPageData(projectSources, data.today));
	const projects = $derived(projectPage.projects);
	const activeTimeline = $derived(projectPage.timeline);
	const visibleProjects = $derived(
		projects.filter(
			(project: any) =>
				(selectedTypes.length === 0 || selectedTypes.includes(project.type)) &&
				(selectedOwners.length === 0 || selectedOwners.includes(project.owner)) &&
				(selectedStatuses.length === 0 || selectedStatuses.includes(project.status))
		)
	);
	const summary = $derived({
		inProgress: visibleProjects.filter((project: any) => project.progress < 100).length,
		dueThisWeek: visibleProjects.filter((project: any) =>
			['今天', '明天', '2天后', '3天后', '4天后', '5天后', '6天后', '7天后'].includes(project.dueText)
		).length,
		atRisk: visibleProjects.filter((project: any) => project.tone === 'orange').length,
		completed: visibleProjects.filter((project: any) => project.progress === 100).length
	});
	const projectTypes = $derived([
		...new Set<string>(
			projects.map((project: any) => String(project.type))
		)
	]);
	const projectOwners = $derived([
		...new Set<string>(
			projects.map((project: any) => String(project.owner))
		)
	]);
	const projectStatuses = $derived([
		...new Set<string>(
			projects.map((project: any) => String(project.status))
		)
	]);
	const primaryTimelineBands = $derived(
		view === 'quarter' ? activeTimeline?.quarters ?? [] : activeTimeline?.months ?? []
	);
	const secondaryTimelineBands = $derived(
		view === 'quarter' ? activeTimeline?.months ?? [] : activeTimeline?.weeks ?? []
	);
</script>

<svelte:head>
	<title>项目进度 · 融资工作台</title>
</svelte:head>

<section class="financing-project-summary" aria-label="项目汇总">
	<div>
		<span class="summary-icon blue"><CircleDashed size={17} /></span>
		<p><strong>{summary.inProgress}</strong><span>进行中</span></p>
	</div>
	<div>
		<span class="summary-icon orange"><Clock3 size={17} /></span>
		<p><strong>{summary.dueThisWeek}</strong><span>本周到期节点</span></p>
	</div>
	<div>
		<span class="summary-icon red"><Flag size={17} /></span>
		<p><strong>{summary.atRisk}</strong><span>存在延期风险</span></p>
	</div>
	<div>
		<span class="summary-icon green"><CheckCircle2 size={17} /></span>
		<p><strong>{summary.completed}</strong><span>本月已完成</span></p>
	</div>
</section>

<section class="toolbar" aria-label="甘特图筛选">
	<label data-ui-owner="routes-financing-projects--page-svelte" class="search-field">
		<Search size={15} />
		<Input class="pl-10" data-ui-owner="routes-financing-projects--page-svelte" aria-label="搜索项目" />
	</label>
	<div class="select-group">
		<Filter size={14} />
		<MultiSelectFilter
			label="融资品种"
			options={projectTypes}
			bind:values={selectedTypes}
			allLabel="全部品种"
		/>
		<MultiSelectFilter
			label="负责人"
			options={projectOwners}
			bind:values={selectedOwners}
			allLabel="全部人员"
		/>
		<MultiSelectFilter
			label="项目状态"
			options={projectStatuses}
			bind:values={selectedStatuses}
			allLabel="全部状态"
		/>
	</div>
	<div class="view-switcher" aria-label="时间视图">
		<Button data-ui-owner="routes-financing-projects--page-svelte" variant={view === 'month' ? "default" : "ghost"} class="ui-button" aria-pressed={view === 'month'}  type="button" onclick={() => (view = 'month')}>月</Button>
		<Button data-ui-owner="routes-financing-projects--page-svelte" variant={view === 'quarter' ? "default" : "ghost"} class="ui-button" aria-pressed={view === 'quarter'}  type="button" onclick={() => (view = 'quarter')}
			>季</Button
		>
	</div>
</section>

<ModuleCard class="gantt-panel" padding="none">
	<div class="gantt-head">
		<div class="project-column-title">项目 / 负责人</div>
		<div class="status-column-title">状态</div>
		<div class="timeline-head">
			<div class="month-band">
				{#each primaryTimelineBands as band (band.key)}
					<span style:flex-basis={`${band.widthPct}%`}>{band.label}</span>
				{/each}
			</div>
			<div class="week-band">
				{#each secondaryTimelineBands as band (band.key)}
					<span style:flex-basis={`${band.widthPct}%`}>{band.label}</span>
				{/each}
			</div>
		</div>
	</div>

	<div class="gantt-body">
		{#each visibleProjects as project (project.id)}
			<div class:expanded={expandedProject === project.id} class="project-row">
				<div class="project-info">
					<Button data-ui-owner="routes-financing-projects--page-svelte" variant="ghost"
						class={"ui-button  expand-button"}
						type="button"
						aria-label={`${expandedProject === project.id ? '收起' : '展开'} ${project.name}`}
						onclick={() => (expandedProject = expandedProject === project.id ? null : project.id)}
					>
						{#if expandedProject === project.id}
							<ChevronDown size={15} />
						{:else}
							<ChevronRight size={15} />
						{/if}
					</Button>
					<div class="project-copy">
						<a href={withBase(`/projects/${project.id}`)}>{project.name}</a>
						<p>
							<span>{project.code}</span>
							<i></i>
							<span>{project.type}</span>
						</p>
					</div>
					<div class="project-people" aria-label={`项目成员 ${project.members.join('、')}`}>
						{#each project.members.slice(0, 3) as member, index}
							<span style:z-index={3 - index}>{member}</span>
						{/each}
					</div>
					{#if canManage || canDelete}
						<div class="project-row-actions">
              {#if canManage}
							<Button data-ui-owner="routes-financing-projects--page-svelte" variant="ghost" size="icon" class={"ui-button  "}
								type="button"
								aria-label={`编辑 ${project.name}`}
								onclick={() => openEditProject(project)}
							>
								<Pencil size={15} />
							</Button>
              {/if}
              {#if canDelete}
							<form
								method="post"
								action="?/deleteProject"
								use:enhance={enhanceProjectAction(`delete-${project.id}`)}
								onsubmit={(event) => {
									if (!confirm(`确定删除项目 ${project.name} 吗？项目任务和关联提醒将一并删除。`)) event.preventDefault();
								}}
							>
								<input data-ui-owner="routes-financing-projects--page-svelte" type="hidden" name="id" value={project.id} />
								<Button data-ui-owner="routes-financing-projects--page-svelte" variant="ghost" size="icon"
									type="submit"
									class={"ui-button   danger-action"}
									aria-label={`删除 ${project.name}`}
									disabled={actionState.status === 'pending'}
								>
									<Trash2 size={15} />
								</Button>
							</form>
              {/if}
						</div>
					{/if}
				</div>
				<div class="project-status">
					<span class={`ui-badge status-pill ${project.tone}`}>{project.status}</span>
					<div class="progress-line">
						<span style:width={`${project.progress}%`}></span>
					</div>
					<small>{project.progress}%</small>
				</div>
				<div class="timeline-cell" style:--timeline-columns={Math.max(1, secondaryTimelineBands.length)}>
					<div class="today-line" style:left={`${activeTimeline?.todayPct ?? 0}%`}><span>今天</span></div>
					<div
						class={`project-bar ${project.tone}`}
						style:left={`${project.startPct}%`}
						style:width={`${project.widthPct}%`}
						title={`${project.name}：${project.start} 至 ${project.end}`}
					>
						<span>{project.progress}%</span>
					</div>
					<div class="next-node" style:left={`${Math.min(project.startPct, 60)}%`}>
						<i></i>
						<span>{project.nextNode}</span>
					</div>
				</div>
				<div class="mobile-project-meta">
					<div><CalendarDays size={14} /> {project.start} — {project.end}</div>
					<div><Users size={14} /> {project.owner} · {project.members.length}人</div>
					<div><Clock3 size={14} /> 下一节点：{project.nextNode}（{project.dueText}）</div>
				</div>
			</div>

			{#if expandedProject === project.id && project.tasks.length > 0}
				<div class="task-rows">
					{#each project.tasks as task, index}
						<div class="task-row">
							<div class="task-info">
								<span class={`task-dot ${task.status}`}></span>
								<span>{index + 1}. {task.name}<small class="task-date">{task.scheduleType === 'period' ? `${task.plannedStartDate} 至 ${task.dueDate}` : task.dueDate ?? '待安排'}</small></span>
							</div>
							<div class="task-status">
								{task.status === 'done' ? '已完成' : task.status === 'doing' ? '进行中' : '待开始'}
							</div>
							<div class="task-timeline" style:--timeline-columns={Math.max(1, secondaryTimelineBands.length)}>
								{#if task.hasSchedule}
									<div
										class={`task-bar ${task.status}`}
										class:task-point={task.scheduleType === 'point'}
										style:left={`${task.startPct}%`}
										style:width={task.scheduleType === 'period' ? `${task.widthPct}%` : '0.75rem'}
										title={task.scheduleType === 'period' ? `${task.name}：${task.plannedStartDate} 至 ${task.dueDate}` : `${task.name}：${task.dueDate}`}
									></div>
								{/if}
							</div>
						</div>
					{/each}
					<a class="project-detail-link" href={withBase(`/projects/${project.id}`)}>
						查看项目详情与全部任务 <ArrowRight size={13} />
					</a>
				</div>
			{/if}
		{:else}
			<p class="empty-projects">当前筛选条件下暂无项目</p>
		{/each}
	</div>
</ModuleCard>

{#if canCreate}
	<Button data-ui-owner="routes-financing-projects--page-svelte" variant="default"
		class={"ui-button  floating-create-button"}
		type="button"
		onclick={openNewProject}
		aria-label="新建项目"
	>
		<Plus size={23} />
	</Button>
{/if}

<Modal bind:this={newProjectDialog} aria-label="新建融资项目" class="w-[min(35rem,calc(100vw-3rem))]">
<div class="dialog-body new-project-modal">
	<form method="post" action="?/createProject" use:enhance={enhanceProjectAction('create', 'create')}>
		<div class="modal-header">
			<div>

				<h2>新建融资项目</h2>

			</div>
			<Button data-ui-owner="routes-financing-projects--page-svelte" variant="outline" class={"ui-button"} type="button" aria-label="关闭" onclick={() => newProjectDialog.close()}>×</Button>
		</div>
		<div class="form-grid">
			<label class="wide">
				<span>项目名称</span>
				<Input data-ui-owner="routes-financing-projects--page-svelte" class={"ui-input"} name="name" bind:value={$projectForm.name} aria-invalid={Boolean($projectErrors.name)} maxlength={160} required />
			</label>
			<label class="wide">
				<span>融资品种 / SOP</span>
				<NativeSelect data-ui-owner="routes-financing-projects--page-svelte" class={"ui-select"} name="sopTemplateId" bind:value={$projectForm.sopTemplateId} aria-invalid={Boolean($projectErrors.sopTemplateId)} required disabled={projectOptionsStatus !== 'ready'}>
					<option value="">
						{projectOptionsStatus === 'loading' ? '正在加载选项…' : projectOptionsStatus === 'error' ? '选项加载失败' : projectOptions.projectSops.length === 0 ? '暂无启用 SOP' : '请选择融资品种'}
					</option>
					{#each projectOptions.projectSops as sop}
						<option value={sop.id}>{sop.debtType} · {sop.name}</option>
					{/each}
				</NativeSelect>
				{#if projectOptionsStatus === 'error'}<Button data-ui-owner="routes-financing-projects--page-svelte" variant="ghost" class={"ui-button "} type="button" onclick={() => void ensureProjectOptions()}>重试</Button>{/if}
			</label>
			<label>
				<span>项目规模（亿元）</span>
				<Input data-ui-owner="routes-financing-projects--page-svelte" class={"ui-input"} name="amountYi" value={$projectForm.amountYi} oninput={(event) => $projectForm.amountYi = event.currentTarget.value} aria-invalid={Boolean($projectErrors.amountYi)} type="number" min="0" step="0.01" inputmode="decimal" />
			</label>
			<label>
				<span>负责人</span>
				<NativeSelect data-ui-owner="routes-financing-projects--page-svelte" class={"ui-select"} name="ownerId" bind:value={$projectForm.ownerId} disabled={projectOptionsStatus !== 'ready'}>
					<option value="">待分配</option>
					{#each projectOptions.people as person}
						<option value={person.id}>{person.name}</option>
					{/each}
				</NativeSelect>
			</label>
			<label>
				<span>计划簿记</span>
				<Input data-ui-owner="routes-financing-projects--page-svelte" class={"ui-input"} name="plannedBookbuildingDate" type="date" aria-invalid={Boolean($projectErrors.plannedBookbuildingDate)} bind:value={$projectForm.plannedBookbuildingDate} required />
			</label>
			<label class="wide">
				<span>项目说明</span>
				<Textarea data-ui-owner="routes-financing-projects--page-svelte" class={"ui-textarea"} name="notes" bind:value={$projectForm.notes} aria-invalid={Boolean($projectErrors.notes)} rows={3} maxlength={4000}></Textarea>
			</label>
		</div>
		<div class="modal-actions">
			<Button data-ui-owner="routes-financing-projects--page-svelte" variant="outline" class={"ui-button"} type="button" disabled={actionState.status === 'pending'} onclick={() => newProjectDialog.close()}>取消</Button>
			<Button data-ui-owner="routes-financing-projects--page-svelte" variant="default"
				class={"ui-button  primary-action"}
				type="submit"
				disabled={actionState.status === 'pending' || projectOptionsStatus !== 'ready' || projectOptions.projectSops.length === 0}
			>
				{#if actionState.status === 'pending' && actionState.key === 'create'}<LoaderCircle class="spin" size={16} />{/if}
				{actionState.status === 'pending' && actionState.key === 'create' ? '创建中…' : '创建项目'}
			</Button>
		</div>
	</form>
</div>
</Modal>

<Modal bind:this={editProjectDialog} aria-label="修改融资项目" class="w-[min(35rem,calc(100vw-3rem))]">
<div class="dialog-body new-project-modal">
	{#if editingProject}
		<form method="post" action="?/updateProject" use:autoSave use:enhance={enhanceProjectAction('edit')}>
			<div class="modal-header">
				<div>

					<h2>修改融资项目</h2>

				</div>
				<Button data-ui-owner="routes-financing-projects--page-svelte" variant="outline" class={"ui-button"} type="button" aria-label="关闭" onclick={() => editProjectDialog.close()}>×</Button>
			</div>
			<input data-ui-owner="routes-financing-projects--page-svelte" type="hidden" name="id" value={editingProject.id} />
			<div class="form-grid">
				<label class="wide">
					<span>项目名称</span>
					<Input data-ui-owner="routes-financing-projects--page-svelte" class={"ui-input"} name="name" maxlength={160} required value={editingProject.name} />
				</label>
				<label class="wide">
					<span>融资品种</span>
					<Input data-ui-owner="routes-financing-projects--page-svelte" class={"ui-input"} value={editingProject.type} readonly />
				</label>
				<label>
					<span>项目状态</span>
					<NativeSelect data-ui-owner="routes-financing-projects--page-svelte" class={"ui-select"} name="status" value={editingProject.rawStatus} required>
						<option value="planning">规划中</option>
						<option value="in_progress">执行中</option>
						<option value="at_risk">存在风险</option>
						<option value="completed">已完成</option>
						<option value="cancelled">已取消</option>
					</NativeSelect>
				</label>
				<label>
					<span>负责人</span>
					<NativeSelect data-ui-owner="routes-financing-projects--page-svelte" class={"ui-select"} name="ownerId" value={editingProject.ownerId ?? ''}>
						<option value="">待分配</option>
						{#if projectOptionsStatus !== 'ready' && editingProject.ownerId}
							<option value={editingProject.ownerId}>{editingProject.owner}</option>
						{/if}
						{#each projectOptions.people as person}
							<option value={person.id}>{person.name}</option>
						{/each}
					</NativeSelect>
				</label>
				<label>
					<span>计划簿记</span>
					<Input data-ui-owner="routes-financing-projects--page-svelte" class={"ui-input"} name="plannedBookbuildingDate" type="date" value={editingProject.plannedBookbuildingDate} required />
				</label>
				<label class="wide">
					<span>项目说明</span>
					<Textarea data-ui-owner="routes-financing-projects--page-svelte" value={editingProject.notes} class={"ui-textarea"} name="notes" rows={4} maxlength={4000}></Textarea>
				</label>
			</div>
			<div class="modal-actions">
				<Button data-ui-owner="routes-financing-projects--page-svelte" variant="outline" class={"ui-button"} type="button" onclick={() => editProjectDialog.close()}>关闭</Button>
			</div>
		</form>
	{/if}
</div>
</Modal>

<style>
	:global(.primary-action[data-ui-owner="routes-financing-projects--page-svelte"]) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4375rem;
		padding: 0 0.8125rem;
	}

	.spin {
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}

	.financing-project-summary {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		margin-bottom: 0.75rem;
		border: 1px solid var(--border-color);
		border-radius: 0.625rem;
		background: #fff;
		box-shadow: 0 1px 2px rgb(16 24 40 / 4%);
	}

	.financing-project-summary > div {
		display: flex;
		align-items: center;
		gap: 0.6875rem;
		min-height: 4.625rem;
		padding: 0.75rem 1.125rem;
		border-right: 1px solid #eaecf0;
	}

	.financing-project-summary > div:last-child {
		border-right: 0;
	}

	.summary-icon {
		display: grid;
		width: 2.125rem;
		height: 2.125rem;
		flex: 0 0 auto;
		place-items: center;
		border-radius: 0.5rem;
	}

	.summary-icon.blue {
		color: var(--color-primary);
		background: #edf4ff;
	}

	.summary-icon.orange {
		color: #dc6803;
		background: #fff4e8;
	}

	.summary-icon.red {
		color: #d92d20;
		background: #fef3f2;
	}

	.summary-icon.green {
		color: #079455;
		background: #ecfdf3;
	}

	.financing-project-summary p {
		display: grid;
		margin: 0;
	}

	.financing-project-summary strong {
		font-variant-numeric: tabular-nums;
		font-size: 1.25rem;
		line-height: 1.1;
		color: #101828;
	}

	.financing-project-summary p span {
		margin-top: 0.1875rem;
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.toolbar {
		display: flex;
		min-height: 3.375rem;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		margin-bottom: 1rem;
		padding: 0.5625rem 0.75rem;
		border: 1px solid var(--border-color);
		border-radius: 0.625rem;
		background: #fff;
	}

	.search-field {
		position: relative;
		display: flex;
		min-height: 2.75rem;
		width: 15rem;
		flex: 1 1 14rem;
		align-items: center;
		gap: 0.4375rem;
		color: var(--text-muted);
	}

	.search-field :global(svg) { position: absolute; left: 14px; pointer-events: none; }

	:global(.search-field input[data-ui-owner="routes-financing-projects--page-svelte"]) {
		width: 100%;
	}

	.select-group {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		color: var(--text-muted);
	}

	.select-group :global(.multi-filter) {
		flex: 1 1 10rem;
	}

	.view-switcher {
		display: flex;
		min-height: 2.75rem;
		flex: 0 0 auto;
		margin-left: auto;
		padding: 0;
		border: 1px solid #d0d5dd;
		border-radius: var(--radius-control);
		background: var(--muted);
	}

	:global(.view-switcher button[data-ui-owner="routes-financing-projects--page-svelte"]) {
		min-width: 2.75rem;
	}

	.gantt-panel {
	overflow: hidden;
	margin-bottom: 0.75rem;
	}

	.gantt-head,
	.project-row,
	.task-row {
		display: grid;
		grid-template-columns: minmax(24rem, 35%) 7.5rem minmax(28rem, 1fr);
	}

	.gantt-head {
		min-height: 4.25rem;
		border-bottom: 1px solid #dfe3e8;
		font-size: 0.75rem;
		font-weight: bold;
		color: #667085;
		background: #f8fafc;
	}

	.project-column-title,
	.status-column-title {
		display: flex;
		align-items: center;
		padding: 0 1rem;
		border-right: 1px solid var(--border-color);
	}

	.timeline-head {
		min-width: 0;
	}

	.month-band,
	.week-band {
		display: flex;
		align-items: center;
		text-align: center;
	}

	.month-band {
		height: 2rem;
		border-bottom: 1px solid var(--border-color);
	}

	.month-band span {
		min-width: 0;
		flex: 0 0 auto;
		height: 100%;
		overflow: hidden;
		padding-top: 0.5625rem;
		border-right: 1px solid var(--border-color);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.month-band span:last-child {
		border-right: 0;
	}

	.week-band {
		height: 2.1875rem;
	}

	.week-band span {
		min-width: 0;
		flex: 0 0 auto;
		height: 100%;
		overflow: hidden;
		padding-top: 0.625rem;
		border-right: 1px solid #eaecf0;
		font-weight: normal;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.project-row {
		position: relative;
		min-height: 4.9375rem;
		border-bottom: 1px solid #eaecf0;
		transition: background 180ms ease;
	}

	.project-row:hover,
	.project-row.expanded {
		background: #fbfcfe;
	}

	.project-info {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 0.5rem;
		padding: 0.6875rem 0.875rem 0.6875rem 0.5rem;
		border-right: 1px solid #eaecf0;
	}

	:global(.expand-button[data-ui-owner="routes-financing-projects--page-svelte"]) {
		display: grid;
		width: 2.75rem;
		flex: 0 0 auto;
		place-items: center;
	}

	.project-copy {
		min-width: 0;
		flex: 1;
	}

	.project-info a {
		display: block;
		overflow: hidden;
		font-weight: bold;
		color: #1d2939;
		white-space: normal;
		overflow-wrap: anywhere;
		font-size: 0.875rem;
		line-height: 1.5;
	}

	.project-info a:hover {
		color: var(--color-primary);
	}

	.project-info p {
		display: flex;
		align-items: center;
		gap: 0.3125rem;
		flex-wrap: wrap;
		margin: 0.25rem 0 0;
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.project-info p i {
		width: 2px;
		height: 2px;
		border-radius: 50%;
		background: #cbd0d8;
	}

	.project-people {
		display: flex;
		margin-left: auto;
		padding-left: 0.5rem;
	}

	.project-people span {
		display: grid;
		width: 1.5rem;
		height: 1.5rem;
		margin-left: -0.375rem;
		place-items: center;
		border: 2px solid #fff;
		border-radius: 50%;
		font-size: 0.75rem;
		font-weight: bold;
		color: var(--color-primary);
		background: #e9f1ff;
	}

	.project-row-actions {
		display: flex;
		flex: 0 0 auto;
		gap: 0.25rem;
		margin-left: 0.25rem;
	}

	.project-row-actions form {
		display: contents;
	}

	:global(.project-row-actions button[data-ui-owner="routes-financing-projects--page-svelte"]) {
		display: grid;
		width: 2.75rem;
		place-items: center;
	}

	.project-status {
		display: grid;
		grid-template-columns: 1fr auto;
		align-content: center;
		gap: 0.375rem 0.4375rem;
		padding: 0.625rem 0.8125rem;
		border-right: 1px solid #eaecf0;
	}

	.status-pill {
		grid-column: 1 / -1;
		justify-self: start;
		padding: 0.25rem 0.4375rem;
		border: 1px solid #d6e4ff;
		border-radius: 0.3125rem;
		font-size: 0.75rem;
		font-weight: bold;
		color: var(--color-primary);
		background: #eff4ff;
	}

	.status-pill.teal {
		border-color: #a6f4c5;
		color: #067647;
		background: #ecfdf3;
	}

	.status-pill.violet {
		border-color: #d9d6fe;
		color: #5925dc;
		background: #f4f3ff;
	}

	.status-pill.orange {
		border-color: #fedf89;
		color: #b54708;
		background: #fffaeb;
	}

	.status-pill.gray {
		border-color: var(--border-color);
		color: #475467;
		background: #f9fafb;
	}

	.progress-line {
		height: 0.1875rem;
		align-self: center;
		overflow: hidden;
		border-radius: 6.1875rem;
		background: #eaecf0;
	}

	.progress-line span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--color-primary);
	}

	.project-status small {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.timeline-cell,
	.task-timeline {
		position: relative;
		overflow: hidden;
		background-image: linear-gradient(to right, #eef0f3 1px, transparent 1px);
		background-size: calc(100% / var(--timeline-columns, 1)) 100%;
	}

	.today-line {
		position: absolute;
		z-index: 2;
		top: 0;
		bottom: 0;
		width: 1px;
		background: #f04438;
	}

	.empty-projects {
		margin: 0;
		padding: 2rem 1rem;
		font-size: 1rem;
		color: #667085;
		text-align: center;
	}

	.today-line span {
		position: absolute;
		top: 0.25rem;
		left: 0.25rem;
		white-space: nowrap;
		padding: 1px 0.25rem;
		border-radius: 0.1875rem;
		font-size: 0.75rem;
		font-weight: bold;
		color: #b42318;
		background: #fef3f2;
	}

	.project-bar {
		position: absolute;
		z-index: 1;
		top: 1.875rem;
		height: 1.25rem;
		min-width: 1rem;
		overflow: hidden;
		border-radius: 0.3125rem;
		background: linear-gradient(90deg, #356ee0, #5d8cf0);
		box-shadow: 0 2px 0.3125rem rgb(47 111 237 / 18%);
	}

	.project-bar.teal {
		background: linear-gradient(90deg, #0e9384, #38b8a8);
	}

	.project-bar.violet {
		background: linear-gradient(90deg, #6941c6, #875bf7);
	}

	.project-bar.orange {
		background: linear-gradient(90deg, #dc6803, #f79009);
	}

	.project-bar.gray {
		background: linear-gradient(90deg, #667085, var(--text-muted));
	}

	.project-bar span {
		display: block;
		padding: 0.25rem 0.4375rem;
		font-size: 0.75rem;
		font-weight: bold;
		color: #fff;
	}

	.next-node {
		position: absolute;
		top: 3.375rem;
		right: .75rem;
		display: flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.75rem;
		color: #667085;
		white-space: nowrap;
	}

	.next-node span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }

	.next-node i {
		width: 0.375rem;
		height: 0.375rem;
		border: 2px solid var(--color-primary);
		border-radius: 50%;
		background: #fff;
	}

	.mobile-project-meta {
		display: none;
	}

	.task-rows {
		border-bottom: 1px solid #dfe3e8;
		background: #f9fbfd;
	}

	.task-row {
		min-height: 2.4375rem;
		color: #667085;
	}

	.task-info,
	.task-status {
		display: flex;
		align-items: center;
		border-right: 1px solid #eaecf0;
		font-size: 0.75rem;
	}

	.task-info {
		gap: 0.4375rem;
		padding-left: 3.125rem;
	}

	.task-status {
		padding-left: 0.875rem;
	}

	.task-dot {
		width: 0.4375rem;
		height: 0.4375rem;
		border: 2px solid var(--text-muted);
		border-radius: 50%;
	}

	.task-dot.done {
		border-color: #12b76a;
		background: #12b76a;
	}

	.task-dot.doing {
		border-color: var(--color-primary);
		background: #dbe8ff;
	}

	.task-date { display: block; margin-top: 0.2rem; font-size: 0.8125rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
	.task-bar.task-point { height: 0.75rem; border-radius: 0; transform: translate(-50%, -50%) rotate(45deg); }
	.task-bar {
		position: absolute;
		top: 0.9375rem;
		height: 0.5rem;
		border-radius: 6.1875rem;
		background: var(--text-muted);
	}

	.task-bar.done {
		background: #12b76a;
	}

	.task-bar.doing {
		background: var(--color-primary);
	}

	.project-detail-link {
		display: flex;
		min-height: 2.125rem;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
		border-top: 1px solid #eef0f3;
		font-size: 0.75rem;
		font-weight: bold;
		color: var(--color-primary);
	}

	.new-project-modal {
		width: min(35rem, 100%);
		padding: 0;
	}

	.new-project-modal form {
		padding: 1.25rem;
	}

	.modal-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		padding-bottom: 0.9375rem;
		border-bottom: 1px solid #eaecf0;
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.125rem;
	}


	:global(.modal-header button[data-ui-owner="routes-financing-projects--page-svelte"]) {
		display: grid;
		width: 2.75rem;
		place-items: center;
	}

	.form-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.8125rem;
		padding: 1.0625rem 0;
	}

	.form-grid label {
		display: grid;
		gap: 0.375rem;
	}

	.form-grid label.wide {
		grid-column: 1 / -1;
	}

	.form-grid label span {
		font-size: 0.875rem;
		font-weight: bold;
		color: #475467;
	}

	:global(.form-grid input[data-ui-owner="routes-financing-projects--page-svelte"]),
	:global(.form-grid select[data-ui-owner="routes-financing-projects--page-svelte"]),
	:global(.form-grid textarea[data-ui-owner="routes-financing-projects--page-svelte"]) {
		width: 100%;
		padding: 0 0.625rem;
	}

	:global(.form-grid textarea[data-ui-owner="routes-financing-projects--page-svelte"]) {
		padding-block: 0.625rem;
		resize: vertical;
	}

	.modal-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
		padding-top: 1rem;
	}

	:global(.modal-actions > button[data-ui-owner="routes-financing-projects--page-svelte"]:not(.primary-action[data-ui-owner="routes-financing-projects--page-svelte"])) {
		padding: 0 0.8125rem;
	}

	@media (max-width: 75rem) {
		.gantt-panel {
			overflow-x: auto;
		}

		.gantt-head,
		.project-row,
		.task-row {
			min-width: 65.625rem;
		}

		.select-group :global(svg) {
			display: none;
		}
	}

	@media (max-width: 51.25rem) {
		.financing-project-summary {
			grid-template-columns: 1fr 1fr;
		}

		.financing-project-summary > div:nth-child(2) {
			border-right: 0;
		}

		.financing-project-summary > div:nth-child(-n + 2) {
			border-bottom: 1px solid #eaecf0;
		}

		.toolbar {
			flex-wrap: wrap;
		min-height: 3.375rem;
		}

		.search-field {
			flex: 1 1 13.75rem;
		}

		.select-group {
			order: 3;
			width: 100%;
		}

		.gantt-panel {
			overflow: visible;
			border: 0;
			background: transparent;
			box-shadow: none;
		}

		.gantt-head {
			display: none;
		min-height: 4.25rem;
		}

		.project-row {
			display: grid;
			min-width: 0;
			grid-template-columns: minmax(0, 1fr) 6.625rem;
			margin-bottom: 0.5625rem;
			border: 1px solid var(--border-color);
			border-radius: 0.625rem;
			background: #fff;
			box-shadow: 0 1px 2px rgb(16 24 40 / 4%);
		min-height: 4.9375rem;
		}

		.project-info,
		.project-status {
			border-right: 0;
		}

		.timeline-cell {
			display: none;
		}

		.mobile-project-meta {
			display: grid;
			grid-column: 1 / -1;
			gap: 0.3125rem;
			padding: 0.625rem 0.875rem;
			border-top: 1px solid #eaecf0;
			font-size: 0.75rem;
			color: #667085;
			background: #f9fafb;
		}

		.mobile-project-meta div {
			display: flex;
			align-items: center;
			gap: 0.3125rem;
		}

		.task-rows {
			display: none;
		}

	}

	@media (max-width: 51.25rem) {
    .project-row { grid-template-columns: minmax(0, 1fr); }
    .project-info { display: grid; grid-template-columns: 2.75rem minmax(0, 1fr) auto; }
    .project-people { display: none; }
    .project-row-actions { grid-column: 3; grid-row: 1; }
    .project-status { display: flex; align-items: center; gap: .75rem; padding: 0 .875rem .75rem; }
    .progress-line { flex: 1; }
    .project-info p { overflow-wrap: anywhere; }
  }

	@media (max-width: 35rem) {
		.financing-project-summary > div {
			padding: 0.625rem 0.75rem;
		min-height: 4.625rem;
		}

		.select-group {
			display: grid;
			grid-template-columns: 1fr 1fr;
		}

		.select-group :global(.multi-filter:last-child) {
			grid-column: 1 / -1;
		}

		.form-grid {
			grid-template-columns: 1fr;
		}

		.form-grid label.wide {
			grid-column: auto;
		}
	}
</style>
