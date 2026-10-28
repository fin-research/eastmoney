<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import type { LoginFailure } from './login-failure';
  let { waiting = false, failure = null, oncancel, onretry }: {
    waiting?: boolean; failure?: LoginFailure | null; oncancel: () => void; onretry: () => void;
  } = $props();
</script>

<div class="dialog-body site-login-box">
  <h2 id="site-login-title" aria-live="polite" aria-atomic="true">{waiting ? '等待登录' : failure?.message ?? '登录后继续'}</h2>
  {#if failure?.code}<p class="login-error-code">{failure.code}</p>{/if}
  <div class="dialog-actions">
    <Button data-ui-owner="lib-LoginPrompt-svelte" variant="ghost" type="button" class="ui-button" onclick={oncancel}>取消</Button>
    <Button data-ui-owner="lib-LoginPrompt-svelte" variant="default" type="button" class="ui-button" onclick={onretry}>{waiting ? '重新打开登录窗口' : failure ? '重新登录' : '登录 / 注册'}</Button>
  </div>
</div>

<style>
  .site-login-box { max-width: 30rem; max-height: calc(100dvh - 2rem); overflow-y: auto; }
  h2 { margin: 0 0 1rem; font-size: 1.25rem; }
  h2, .login-error-code { overflow-wrap: anywhere; }
  .login-error-code { margin: 0 0 1rem; color: var(--text-2); font-size: 1rem; }
  .dialog-actions { flex-wrap: wrap; }
</style>
