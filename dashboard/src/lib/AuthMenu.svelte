<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { getContext } from 'svelte';
  import type { AccountSummary } from '$lib/identity';

  const currentAccount = getContext<() => AccountSummary | null>('site-account') ?? (() => null);
  const isChecking = getContext<() => boolean>('site-account-checking') ?? (() => false);
  const checking = $derived(isChecking());
  const account = $derived(currentAccount());
</script>

<Button data-ui-owner="lib-AuthMenu-svelte" variant="ghost" class={"ui-button  account-button"} href={account ? "/management/me" : "/auth/login"} aria-label={account ? `我的：${account.name}，${account.department || '未填写部门'}` : '我的'}>
  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></svg>
  <span>{account?.name || (checking ? '我的' : '登录 / 注册')}{#if account}<span class="account-divider" aria-hidden="true">&nbsp;/&nbsp;</span><span class="account-department">{account.department || '未填写部门'}</span>{/if}</span>
</Button>

<style>
  svg { width: 20px; height: 20px; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  :global(.account-button[data-ui-owner="lib-AuthMenu-svelte"]) { max-width: 100%; margin-inline-start: auto; flex-shrink: 0; gap: .5rem; padding-inline: .75rem; font-size: 1rem; text-decoration: none; }
  :global(.account-button[data-ui-owner="lib-AuthMenu-svelte"] > span) { overflow-wrap: anywhere; text-align: left; }
  .account-department, .account-divider { color: var(--text-muted); font-weight: normal; }
  @media print { :global(.account-button[data-ui-owner="lib-AuthMenu-svelte"]) { display: none; } }
</style>
