<script lang="ts">
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Search, Check, Minus, Layers, Box, ShieldCheck } from '@lucide/svelte';
  import { permissionTree } from './permission-tree';
  let { permissions, grantedOnly = false }: { permissions: string[]; grantedOnly?: boolean } = $props();
  let query = $state('');
  let scope = $state('');
  const tree = $derived(permissionTree(permissions, query, grantedOnly));
  const scopes = $derived(permissionTree(permissions, '', grantedOnly));
  const visible = $derived(tree.filter(group => !scope || group.scope === scope));
  const total = $derived(permissionTree(permissions, '', true));
  const resources = $derived(total.reduce((sum, group) => sum + group.resources.length, 0));
  const actions = $derived(total.reduce((sum, group) => sum + group.resources.reduce((n, resource) => n + resource.actions.length, 0), 0));
</script>

<div class="permission-explorer">
  <div class="permission-overview" aria-label="授权概览">
    <span><Layers size={18} aria-hidden="true" /><strong>{total.length}</strong>业务范围</span>
    <span><Box size={18} aria-hidden="true" /><strong>{resources}</strong>资源</span>
    <span><ShieldCheck size={18} aria-hidden="true" /><strong>{actions}</strong>已授权操作</span>
  </div>
  <label class="permission-search"><Search size={18} aria-hidden="true" /><Input class="pl-10" type="search" bind:value={query} aria-label="搜索权限" /></label>
  <div class="scope-filters" aria-label="业务范围筛选">
    <Button data-ui-owner="lib-permissions-PermissionExplorer-svelte" variant={!scope ? 'default' : 'ghost'} type="button" class="ui-button" aria-pressed={!scope} onclick={() => scope = ''}>全部范围</Button>
    {#each scopes as group}
      <Button data-ui-owner="lib-permissions-PermissionExplorer-svelte" variant={scope === group.scope ? 'default' : 'ghost'} type="button" class="ui-button" aria-pressed={scope === group.scope} onclick={() => scope = group.scope}>{group.label}</Button>
    {/each}
  </div>
  <div class="permission-tree">
    {#each visible as group}
      <section class="scope-section" aria-label={group.label}>
        <div class="scope-heading"><span class="scope-icon"><Layers size={18} aria-hidden="true" /></span><h3>{group.label}</h3><span class="scope-count">{group.resources.length} 个资源</span></div>
        <div class="resource-grid">
          {#each group.resources as resource}
            <div class="resource-row">
              <div class="resource-heading"><h4>{resource.name}</h4></div>
              <ul class="action-list" aria-label={`${resource.name}的操作`}>
                {#each resource.actions as action}
                  <li class:action-granted={action.granted} class:action-denied={!action.granted}>
                    {#if action.granted}<Check size={15} aria-hidden="true" />{:else}<Minus size={15} aria-hidden="true" />{/if}
                    <span>{action.name}</span><span class="sr-only">：{action.granted ? '已授权' : '未授权'}，{action.code}</span>
                  </li>
                {/each}
              </ul>
            </div>
          {/each}
        </div>
      </section>
    {/each}
    {#if !visible.length}<p class="permission-empty" role="status">{query || scope ? '无匹配权限' : '暂无权限'}</p>{/if}
  </div>
</div>

<style>
  .permission-explorer { display: grid; gap: 1rem; min-width: 0; }
  .permission-overview { display: flex; flex-wrap: wrap; gap: .75rem 1.75rem; padding: 1rem; background: var(--brand-soft); border-radius: var(--radius-control); }
  .permission-overview > span { display: flex; align-items: center; gap: .5rem; color: var(--text-1); font-size: 1rem; }
  .permission-overview strong { color: var(--text-1); font-size: 1.25rem; }
  .permission-overview :global(svg) { color: var(--brand); }
  .permission-search { position: relative; width: 100%; }
  .permission-search :global(svg) { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); pointer-events: none; }
  .scope-filters { display: flex; flex-wrap: wrap; gap: .375rem; }
  :global(.scope-filters .ui-button[data-ui-owner="lib-permissions-PermissionExplorer-svelte"]) { min-height: 44px; height: auto; }
  .permission-tree { display: grid; gap: 1.5rem; }
  .scope-heading { display: flex; align-items: center; flex-wrap: wrap; gap: .625rem; padding-bottom: .75rem; border-bottom: 1px solid var(--line); }
  .scope-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius-control); background: var(--brand-soft); color: var(--brand); }
  .scope-heading h3 { margin: 0; font-size: 1.125rem; font-weight: bold; }
  .scope-count { margin-left: auto; color: var(--text-1); font-size: 1rem; }
  .resource-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr)); gap: 0 1.5rem; }
  .resource-row { min-width: 0; display: grid; align-content: start; gap: .75rem; padding: 1rem 0; border-bottom: 1px solid var(--line); }
  .resource-heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: .5rem; }
  h4 { margin: 0; font-size: 1rem; font-weight: bold; }
  .action-list { display: flex; flex-wrap: wrap; gap: .5rem; list-style: none; padding: 0; margin: 0; }
  .action-list li { display: inline-flex; align-items: center; gap: .25rem; border-radius: var(--radius-control); padding: .375rem .625rem; font-size: .875rem; }
  .action-granted { color: var(--brand); background: var(--brand-soft); }
  .action-denied { color: var(--text-muted); background: var(--panel); }
  .permission-empty { margin: 0; padding: 1.5rem 0; color: var(--text-muted); }
</style>
