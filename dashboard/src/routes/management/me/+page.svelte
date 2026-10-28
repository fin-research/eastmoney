<script lang="ts">
  import { Badge as UiBadge } from "$lib/components/ui/badge/index.js";
  import * as RadioGroup from "$lib/components/ui/radio-group/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import '../../profile/profile.css';
  import { getContext } from 'svelte';
  import { CLIENT_SESSION_CONTEXT, type ClientSession } from '$lib/client-session';
  import PanelHeading from '$lib/trading-research/PanelHeading.svelte';
  import { onMount } from 'svelte';
  import ModuleCard from '../../../components/ModuleCard.svelte';
  import { globalMessages } from '$lib/global-messages';
  import { logoutBearer } from '$lib/bearer-auth';
  import { isLoginRedirecting } from '$lib/auth-client';
  import { type AccountProfile } from '$lib/profile';
  import { readPreferences, savePreferences, type MarketColorConvention } from '$lib/preferences';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const session = getContext<ClientSession>(CLIENT_SESSION_CONTEXT);
  let profile = $state<AccountProfile | null>(null);
  let loading = $state(true);
  let loadError = $state('');
  let name = $state('');
  let department = $state('');
  let email = $state('');
  let confirmed = $state(false);
  let pending = $state<'name' | 'email' | 'password' | null>(null);
  let marketColorConvention = $state<MarketColorConvention>('red-up-green-down');

  async function loadProfile(signal?: AbortSignal) {
    loading = true;
    loadError = '';
    try {
      const response = await fetch('/api/profile', { cache: 'no-store', signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || '个人信息读取失败');
      profile = payload as AccountProfile;
      name = profile.name;
      department = profile.department;
      email = profile.email;
    } catch (error) {
      if (!signal?.aborted && !isLoginRedirecting()) loadError = error instanceof Error ? error.message : '个人信息读取失败';
    } finally { loading = false; }
  }

  async function submit(action: 'name' | 'email' | 'password') {
    if (pending || !profile) return;
    pending = action;
    try {
      const body = action === 'name' ? { action, name, department } : action === 'email' ? { action, email, confirmed } : { action };
      const response = await fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || '个人信息保存失败');
      if (typeof result.name === 'string' && typeof result.department === 'string') {
        profile = { ...profile, name: result.name, department: result.department };
        name = result.name; department = result.department;
        const current = session.current();
        if (current?.user) session.seed({ ...current, account: { name: result.name, department: result.department } });
      }
      globalMessages.success(result.message, { key: 'profile-action', duration: 10000 });
      if (result.logout) { void logoutBearer(); return; }
    } catch (error) {
      if (!isLoginRedirecting()) globalMessages.error(error instanceof Error ? error.message : '个人信息保存失败', { key: 'profile-action' });
    } finally { pending = null; }
  }

  function persistPreferences() {
    try {
      savePreferences({ marketColorConvention });
      globalMessages.success('个性化配置已保存', { key: 'profile-preferences' });
    } catch { globalMessages.error('浏览器无法保存个性化配置，请检查存储权限'); }
  }

  onMount(() => {
    marketColorConvention = readPreferences().marketColorConvention;
    const controller = new AbortController();
    void loadProfile(controller.signal);
    return () => controller.abort();
  });
</script>

<svelte:head>
  <title>我的 · 资金管理部</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="profile-page">
  <div class="profile-content">
    <div class="profile-summary">
      <span class="profile-avatar" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></svg></span>
      <div><strong>{profile?.name || data.account?.name || '我的账号'} / {profile ? profile.department || '未填写部门' : data.account?.department || '未填写部门'}</strong><span>{profile?.email || data.email}</span></div>
      <UiBadge variant="secondary" class="ui-badge ui-tone-success profile-tag">已登录</UiBadge>
    </div>
    {#if loading}
      <div class="profile-state" role="status">正在读取个人信息…</div>
    {:else if loadError}
      <div class="profile-state" role="alert"><p>{loadError}</p><Button data-ui-owner="routes-profile--page-svelte" variant="outline" class={"ui-button  profile-button"} type="button" onclick={() => loadProfile()}>重新读取</Button></div>
    {/if}
    <div class="profile-grid">
      <ModuleCard labelledBy="profile-details-title">
        <PanelHeading id="profile-details-title" title="个人资料" />
        <form class="profile-form" onsubmit={(event) => { event.preventDefault(); void submit('name'); }}>
          <label for="profile-name">显示姓名</label>
          <Input data-ui-owner="routes-profile--page-svelte" class={"ui-input"} id="profile-name" name="name" autocomplete="name" bind:value={name} required maxlength={50} disabled={!profile || pending !== null} />
          <label for="profile-department">部门</label>
          <Input data-ui-owner="routes-profile--page-svelte" class={"ui-input"} id="profile-department" name="department" bind:value={department} maxlength={100} disabled={!profile || pending !== null} />
          <div class="profile-actions"><Button data-ui-owner="routes-profile--page-svelte" variant="default" class={"ui-button  profile-button primary"} permission="account.profile:update" type="submit" disabled={!profile || pending !== null}>{pending === 'name' ? '正在保存' : '保存个人资料'}</Button></div>
        </form>
      </ModuleCard>
      <ModuleCard labelledBy="profile-email-title">
        <PanelHeading id="profile-email-title" title="登录邮箱" accent="var(--business-accent)" />
        <form class="profile-form" onsubmit={(event) => { event.preventDefault(); void submit('email'); }}>
          <label for="profile-email">邮箱地址 · @18.cn {#if profile}<span class="field-status">{profile.emailVerified ? '已验证' : '待验证'}</span>{/if}</label>
          <Input data-ui-owner="routes-profile--page-svelte" class={"ui-input"} id="profile-email" name="email" type="email" autocomplete="email" bind:value={email} required maxlength={254} pattern="[^@\s]+@18\.[cC][nN]" disabled={!profile || pending !== null} />
          <label class="profile-choice"><Checkbox data-ui-owner="routes-profile--page-svelte"  bind:checked={confirmed} disabled={!profile || pending !== null} /><span>确认修改邮箱并重新验证</span></label>
          <div class="profile-actions"><Button data-ui-owner="routes-profile--page-svelte" variant="default" class={"ui-button  profile-button primary"} permission="account.profile:update" type="submit" disabled={!profile || pending !== null || !confirmed || email.trim().toLowerCase() === profile.email.toLowerCase()}>{pending === 'email' ? '正在更新' : '更新邮箱并退出登录'}</Button></div>
        </form>
      </ModuleCard>
      <ModuleCard labelledBy="profile-password-title">
        <PanelHeading id="profile-password-title" title="登录密码" accent="var(--color-warning-content)" />
        <div class="profile-form">
          <label for="password-recipient">收件邮箱</label>
          <Input data-ui-owner="routes-profile--page-svelte" class={"ui-input"} id="password-recipient" value={profile?.email || data.email} readonly />
          <div class="profile-actions"><Button data-ui-owner="routes-profile--page-svelte" variant="outline" class={"ui-button  profile-button"} permission="account.profile:update" type="button" disabled={!profile || pending !== null} onclick={() => submit('password')}>{pending === 'password' ? '正在请求' : '发送密码重置邮件'}</Button></div>
        </div>
      </ModuleCard>
      <ModuleCard labelledBy="profile-preferences-title">
        <PanelHeading id="profile-preferences-title" title="个性化配置" accent="var(--business-purple)" />
        <form class="profile-form" onsubmit={(event) => { event.preventDefault(); persistPreferences(); }}>
          <fieldset><legend>行情颜色逻辑</legend>
            <RadioGroup.Root name="marketColorConvention" bind:value={marketColorConvention} class="flex flex-wrap gap-x-5 gap-y-0">
            <label class="profile-choice"><RadioGroup.Item value="red-up-green-down" /><span>红涨绿跌</span></label>
            <label class="profile-choice"><RadioGroup.Item value="green-up-red-down" /><span>绿涨红跌</span></label>
            </RadioGroup.Root>
          </fieldset>
          <div class="profile-actions"><Button data-ui-owner="routes-profile--page-svelte" variant="default" class={"ui-button  profile-button primary"} type="submit">保存个性化配置</Button></div>
        </form>
      </ModuleCard>
    </div>
    <div class="profile-footer"><form onsubmit={(event) => { event.preventDefault(); void logoutBearer(); }}><Button data-ui-owner="routes-profile--page-svelte" variant="outline" class={"ui-button  profile-button"} type="submit">退出登录</Button></form></div>
  </div>
</div>
