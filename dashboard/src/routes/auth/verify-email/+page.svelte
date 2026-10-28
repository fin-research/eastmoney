<script lang="ts">
  import ModuleCard from '../../../components/ModuleCard.svelte';
</script>

<svelte:head>
  <title>请检查验证邮件 · 资金管理部</title>
  <meta name="robots" content="noindex, nofollow" />
  <meta name="referrer" content="no-referrer" />
</svelte:head>

<main class="verification-page">
  <div class="verification-content">
    <a class="brand-link" href="/">东方财富证券 · 资金管理部</a>
    <ModuleCard labelledBy="verification-title">
      <div class="verification-message">
        <span class="mail-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg></span>
        <h1 id="verification-title">请检查验证邮件</h1>
        <a class="login-button" data-sveltekit-reload href="/auth/login?returnTo=%2Fprofile">我已验证，继续登录</a>
      </div>
    </ModuleCard>
  </div>
</main>

<style>
  .verification-page { display: grid; min-height: 100dvh; place-items: center; padding: 32px 16px; color: var(--text-1); background: var(--bg-page); }
  .verification-content { width: min(100%, 520px); }
  .brand-link { display: inline-flex; min-height: 44px; align-items: center; margin-bottom: 16px; color: var(--brand-deep); font-weight: bold; text-decoration: none; }
  .verification-message { display: grid; gap: 20px; padding: 12px; }
  .mail-icon { display: grid; width: 56px; height: 56px; place-items: center; border-radius: var(--radius-control); color: var(--brand); background: var(--brand-soft); }
  svg { width: 28px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  h1 { margin: 0; font-size: 1.5rem; font-weight: bolder; }
  .login-button { display: flex; min-height: 44px; align-items: center; justify-content: center; padding: 10px 16px; border-radius: var(--radius-control); color: white; background: var(--brand); text-decoration: none; font-weight: bold; }
  .login-button:hover { background: var(--brand-deep); }
  a:focus-visible { outline: 3px solid var(--brand); outline-offset: 3px; }
  @media (max-width: 480px) { .verification-message { padding: 4px; } }
</style>
