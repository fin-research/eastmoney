<script lang="ts">
import { getContext } from 'svelte';
import * as Popover from '$lib/components/ui/popover/index.js';
import { Button } from '$lib/components/ui/button/index.js';
import { Badge } from '$lib/components/ui/badge/index.js';
import { CLIENT_SESSION_CONTEXT, type ClientSession } from '$lib/client-session';
import './layout.css';
import { Bell } from '@lucide/svelte';
import { navigating, page } from '$app/state';
import WorkbenchShell from '$lib/workbench/WorkbenchShell.svelte';
import type { WorkbenchIconName } from '$lib/trading-research/demo-data';
import { hasPermission } from '$lib/permissions';
import { DATA_ADMIN_TABS } from '$lib/financing/data-admin';
import { withBase, withoutBase } from '$lib/financing/app-paths';
let { data, children } = $props();
const session = getContext<ClientSession>(CLIENT_SESSION_CONTEXT);
const permissions = $derived($session?.permissions ?? data.permissions);
let navigationSlow = $state(false);
let remindersOpen = $state(false);
$effect(() => { page.url.pathname; remindersOpen = false; });
$effect(() => {
  navigationSlow = false;
  if (!navigating.to) return;
  const timer = setTimeout(() => (navigationSlow = true), 300);
  return () => clearTimeout(timer);
});
const views = $derived([
  { id: 'overview', href: '/financing/', label: '仪表盘', icon: 'overview' as WorkbenchIconName },
  { id: 'liability-report', href: '/financing/liability-report', label: '负债周报', icon: 'file' as WorkbenchIconName },
  ...(hasPermission(permissions, 'financing.data:read') ? [{ id: 'bond-investors', href: '/financing/bond-investors', label: '债券投资人', icon: 'user' as WorkbenchIconName }] : []),
  ...(hasPermission(permissions, 'financing.data:read') ? [{ id: 'clients', href: '/financing/clients', label: '客户名单', icon: 'user' as WorkbenchIconName }] : []),
  { id: 'projects', href: '/financing/projects', label: '项目进度', icon: 'workflow' as WorkbenchIconName },
  { id: 'sop', href: '/financing/sop', label: 'SOP 管理', icon: 'check' as WorkbenchIconName },
  ...(hasPermission(permissions, 'financing.data:read') ? [{ id: 'data', href: '/financing/data', label: '融资数据', icon: 'database' as WorkbenchIconName }] : [])
]);
const path = $derived(withoutBase(page.url.pathname));
const activeViewId = $derived(path === '/' || path.startsWith('/debts/') ? 'overview' : path.split('/')[1] ?? 'overview');
const isLiabilityReport = $derived(path === '/liability-report');
const activeLabel = $derived(path.startsWith('/projects/') ? '项目详情' : path.startsWith('/debts/') ? '负债详情' : path === '/sop/reminders' ? '提醒发送历史' : path.startsWith('/sop/') ? 'SOP 配置' : '');
</script>



{#if data.user}
<WorkbenchShell title="融资工作台" homeHref="/financing/" {views} {activeViewId} {activeLabel} activeHref={page.url.pathname}
  tabs={path === '/data' ? DATA_ADMIN_TABS : []} activeTabId={path === '/data' ? page.url.searchParams.get('tab') ?? 'management' : ''}
  class="financing-scope" tone="orange" layoutReport={isLiabilityReport} reportKind={isLiabilityReport ? 'liability' : null}>
  {#snippet actions()}
    <Popover.Root bind:open={remindersOpen}>
      <Popover.Trigger>{#snippet child({ props })}
      <Button {...props} variant="ghost" class="reminder-trigger" aria-label={`查看提醒，${data.reminders.total} 条待办`}>
        <Bell size={19} aria-hidden="true" /><span class="reminder-trigger-label">查看提醒</span>
        {#if data.reminders.total > 0}<Badge variant="secondary">{data.reminders.total}</Badge>{/if}
      </Button>{/snippet}</Popover.Trigger>
      <Popover.Content align="end" class="reminder-popover w-96 max-h-[60dvh] overflow-y-auto">
        <div class="reminder-popover-heading"><strong>待办与提醒</strong><span>{data.reminders.total} 条</span></div>
        {#each data.reminders.items as reminder}
          <a href={withBase(reminder.href)}><strong>{reminder.projectName}</strong><span>{reminder.taskName}</span><small>{reminder.dueLabel}</small></a>
        {:else}<p>当前没有需要处理的项目节点</p>{/each}
      </Popover.Content>
    </Popover.Root>
    {#if isLiabilityReport}
      {#await import('$lib/financing/LiabilityReportActions.svelte') then module}
        <module.default permissions={permissions} />
      {/await}
    {/if}
  {/snippet}
  {#snippet status()}
    {#if navigationSlow}<div class="navigation-progress" role="progressbar" aria-label="页面加载中"></div>{/if}
  {/snippet}
  <div class:liability-report-content={isLiabilityReport} class="financing-content" aria-busy={Boolean(navigating.to)}>{@render children()}</div>
</WorkbenchShell>
{:else}{@render children()}{/if}
