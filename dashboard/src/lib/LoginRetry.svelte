<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import type { LoginFailure } from './login-failure';
  let { failure, pending = false, onretry }: { failure: LoginFailure; pending?: boolean; onretry: () => void } = $props();
</script>

<main class="login-retry">
  <div class="login-failure" aria-live="polite" aria-atomic="true">
    <h1>{failure.message}</h1>
    {#if failure.code}<p>{failure.code}</p>{/if}
  </div>
  <div class="login-actions">
    <Button onclick={onretry} disabled={pending}>{pending ? '正在登录' : '重新登录'}</Button>
    <Button variant="ghost" href="/">返回首页</Button>
  </div>
</main>

<style>
  .login-retry { min-height: 100dvh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1rem; padding: 2rem; }
  .login-failure { max-width: 30rem; text-align: center; overflow-wrap: anywhere; }
  h1 { margin: 0; font-size: 1.25rem; }
  p { margin: 1rem 0 0; font-size: 1rem; color: var(--text-2); }
  .login-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 1rem; }
</style>
