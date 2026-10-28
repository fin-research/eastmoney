<script lang="ts">
  import { onMount } from 'svelte';
  import LoginRetry from '$lib/LoginRetry.svelte';
  import { loginRedirect, getLoginCallbackFailure } from '$lib/bearer-auth';
  import { loginFailure, loginFailureFromCode, type LoginFailure } from '$lib/login-failure';
  let failure = $state<LoginFailure | null>(null);
  let pending = $state(false);
  let returnTo = '/';
  async function retry() {
    if (pending) return;
    pending = true;
    try { await loginRedirect(returnTo); }
    catch (error) { failure = loginFailure(error); pending = false; }
  }
  onMount(() => {
    const params = new URL(window.location.href).searchParams;
    returnTo = params.get('returnTo') ?? '/';
    if (params.has('error')) failure = getLoginCallbackFailure() ?? loginFailureFromCode(params.get('error'));
    else void retry();
  });
</script>
<svelte:head><title>登录 · 资金管理部</title></svelte:head>
{#if failure}<LoginRetry {failure} {pending} onretry={retry} />{/if}
