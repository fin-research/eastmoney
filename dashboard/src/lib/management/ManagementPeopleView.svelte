<script lang="ts">
import { Badge as UiBadge } from '$lib/components/ui/badge/index.js';
import { Button } from '$lib/components/ui/button/index.js';
import { Input } from '$lib/components/ui/input/index.js';
import { getContext, untrack } from 'svelte';
import { invalidate } from '$app/navigation';
import { CLIENT_SESSION_CONTEXT, type ClientSession } from '$lib/client-session';
import type { Auth0Role, DirectoryPerson } from '$lib/server/auth0-directory';
import ModuleCard from '../../components/ModuleCard.svelte';
import PanelHeading from '$lib/trading-research/PanelHeading.svelte';
import { roleLabel } from '$lib/permissions/permission-tree';
import PermissionExplorer from '$lib/permissions/PermissionExplorer.svelte';
import { hasPermission } from '$lib/permissions';
import { globalMessages } from '$lib/global-messages';
import { ExternalLink, RefreshCw } from '@lucide/svelte';
let { data }: { data: {
  tab: 'people' | 'roles'; people: DirectoryPerson[]; roles: Auth0Role[];
  configurations: Record<string, { permissions: string[] }>; permissions: string[];
} } = $props();
const session = getContext<ClientSession>(CLIENT_SESSION_CONTEXT);
let people = $state(untrack(() => data.people));
let selectedPersonId = $state(untrack(() => data.people[0]?.id ?? ''));
let personName = $state(untrack(() => data.people[0]?.name ?? ''));
let personDepartment = $state(untrack(() => data.people[0]?.department ?? ''));
let savingPerson = $state(false);
let selectedRole = $state(untrack(() => data.roles[0]?.id ?? ''));
let refreshing = $state(false);
const role = $derived(data.roles.find(item => item.id === selectedRole));
$effect(() => {
  const nextPeople = data.people;
  people = nextPeople;
  const selected = nextPeople.find(item => item.id === untrack(() => selectedPersonId)) ?? nextPeople[0];
  selectedPersonId = selected?.id ?? '';
  personName = selected?.name ?? '';
  personDepartment = selected?.department ?? '';
});
$effect(() => {
  if (!data.roles.some(item => item.id === untrack(() => selectedRole))) selectedRole = data.roles[0]?.id ?? '';
});
function selectPerson(id: string) {
  const person = people.find(item => item.id === id);
  if (!person || savingPerson) return;
  selectedPersonId = id;
  personName = person.name;
  personDepartment = person.department;
}
async function savePerson() {
  if (savingPerson || !selectedPersonId) return;
  savingPerson = true;
  try {
    const response = await fetch('/api/management/people', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: selectedPersonId, name: personName, department: personDepartment }) });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.detail || `人员资料保存失败（${response.status}）`);
    if (!result || typeof result.id !== 'string') throw new Error('人员资料响应无效，请刷新后确认');
    people = people.map(person => person.id === result.id ? { ...person, name: result.name, department: result.department } : person);
    personName = result.name;
    personDepartment = result.department;
    const current = session.current();
    if (current && current.user && current.user.id === result.id)
      session.seed({ ...current,
        account: { name: result.name, department: result.department } });
    globalMessages.success('人员资料已保存');
  } catch (error) { globalMessages.error(error instanceof Error ? error.message : '人员资料保存失败'); }
  finally { savingPerson = false; }
}
async function refreshCache() {
  refreshing = true;
  try {
    const response = await fetch('/auth/permissions/refresh', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || '刷新失败');
    await Promise.all([invalidate('auth:permissions'), invalidate('site:session')]);
    globalMessages.success('授权已刷新');
  } catch (error) { globalMessages.error(error instanceof Error ? error.message : '刷新失败'); }
  finally { refreshing = false; }
}
</script>
<div class="permissions-page">
  {#if data.tab === 'people'}
  <div class="people-workspace">
    <ModuleCard class="people-catalog">
      <PanelHeading id="people-catalog-title" title="人员" />
      <ul class="people-list" aria-labelledby="people-catalog-title">
        {#each people as person (person.id)}
          <li><Button variant={selectedPersonId === person.id ? 'default' : 'ghost'} class="focus-visible:!border-transparent focus-visible:!bg-clip-border" type="button"
            aria-label={`${person.name}，${person.email}`} aria-pressed={selectedPersonId === person.id} onclick={() => selectPerson(person.id)}>
            {person.name}
          </Button></li>
        {/each}
      </ul>
    </ModuleCard>
    <ModuleCard class="person-editor">
      <PanelHeading id="person-editor-title" title="人员资料" />
      {#if selectedPersonId}
        <form class="person-form" onsubmit={(event) => { event.preventDefault(); void savePerson(); }}>
          <label for="person-name">姓名</label>
          <Input id="person-name" name="name" bind:value={personName} required maxlength={50} disabled={savingPerson} />
          <label for="person-department">部门</label>
          <Input id="person-department" name="department" bind:value={personDepartment} maxlength={100} disabled={savingPerson} />
          <Button variant="default" permission="admin" type="submit" disabled={savingPerson}>{savingPerson ? '正在保存' : '保存资料'}</Button>
        </form>
      {:else}<p>暂无人员。</p>{/if}
    </ModuleCard>
  </div>
  {:else}
  <div class="permission-controls">
    <Button data-ui-owner="routes-management-people--page-svelte" variant="outline" class={"ui-button "} href="https://manage.auth0.com/dashboard/eu/hasbai/roles" target="_blank" rel="noreferrer">在 Auth0 管理<ExternalLink size={16} aria-hidden="true" /></Button>
    {#if hasPermission(data.permissions, 'auth.permission:update')}<Button data-ui-owner="routes-management-people--page-svelte" variant="default" class={"ui-button "} type="button" disabled={refreshing} onclick={refreshCache}><RefreshCw size={16} aria-hidden="true" />{refreshing ? '正在同步…' : '刷新授权缓存'}</Button>{/if}
  </div>
  <div class="permission-workspace">
    <ModuleCard class="role-catalog">
      <PanelHeading id="role-catalog-title" title="角色" />
      <ul class="role-list" aria-labelledby="role-catalog-title">
        {#each data.roles as item}<li><Button data-ui-owner="routes-management-people--page-svelte" variant={selectedRole === item.id ? "default" : "ghost"} class="ui-button"  type="button" aria-pressed={selectedRole === item.id} onclick={() => selectedRole = item.id}><span>{roleLabel(item.name)}</span><UiBadge variant="secondary" class="ui-badge ui-tone-neutral">{data.configurations[item.id]?.permissions.length ?? 0}</UiBadge></Button></li>{/each}
      </ul>
    </ModuleCard>
    <ModuleCard class="permission-editor">
      {#if role}<PanelHeading id="role-permissions-title" title={roleLabel(role.name)} controlsBesideTitle><UiBadge variant="secondary" class="ui-badge ui-tone-neutral">只读</UiBadge></PanelHeading><PermissionExplorer permissions={data.configurations[selectedRole]?.permissions ?? []} />{:else}<p>暂无角色。</p>{/if}
    </ModuleCard>
  </div>
  {/if}
</div>
<style>
.permissions-page { display: grid; gap: 1.25rem; }
.people-workspace { display: grid; grid-template-columns: 230px minmax(0, 1fr); gap: 1.25rem; align-items: stretch; }
.people-workspace :global(.people-catalog), .people-workspace :global(.person-editor) { display: flex; flex-direction: column; height: clamp(24rem, 65dvh, 40rem); min-height: 0; }
.people-list { flex: 1; list-style: none; padding: 0; margin: 0; display: grid; align-content: start; gap: .375rem; min-height: 0; overflow-y: auto; }
:global(.people-list button) { width: 100%; min-height: 44px; height: auto; justify-content: flex-start; text-align: left; white-space: normal; overflow-wrap: anywhere; }
.person-form { display: grid; gap: .75rem; max-width: 30rem; }
.person-form label { font-weight: bold; }
:global(.person-form button) { min-height: 44px; justify-self: end; }
.permission-controls { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; }
.permission-workspace { display: grid; grid-template-columns: 230px minmax(0, 1fr); gap: 1.25rem; align-items: start; }
.role-list { list-style: none; padding: 0; margin: 0; display: grid; gap: .375rem; }
:global(.role-list button[data-ui-owner="routes-management-people--page-svelte"]) { width: 100%; min-height: 44px; height: auto; justify-content: space-between; text-align: left; }
:global(.role-list button[data-ui-owner="routes-management-people--page-svelte"] > span:first-child) { overflow-wrap: anywhere; min-width: 0; }
@media (max-width: 900px) { .people-workspace, .permission-workspace { grid-template-columns: 1fr; } .people-workspace :global(.people-catalog), .people-workspace :global(.person-editor) { height: auto; } .people-list { max-height: 50dvh; } .role-list { grid-template-columns: repeat(auto-fit, minmax(min(190px, 100%), 1fr)); } }
</style>
