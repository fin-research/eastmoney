<script lang="ts">
  import '../app.css';
  import '../styles.css';
  import { onMount, setContext, untrack } from "svelte";
  import { beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { pageRequiresLogin } from '$lib/auth-navigation';
  import { createClientNavigationGuard, requireClientLogin, isLoginRedirecting, installAuthInteraction } from '$lib/auth-client';
  import { createClientSession, CLIENT_SESSION_CONTEXT } from '$lib/client-session';
  import { installAuthControls } from '$lib/auth-controls';
  import { globalMessages } from '$lib/global-messages';

  import ProtectedReportPreview from '$lib/ProtectedReportPreview.svelte';
  import LoginDialog from "$lib/LoginDialog.svelte";
  let loginDialog: LoginDialog;

  import GlobalMessages from "$lib/GlobalMessages.svelte";
  import AiPanel from "$lib/AiPanel.svelte";
  import { provideAiClient } from "$lib/ai-client.svelte";
  import { applyPreferences, readPreferences } from "$lib/preferences";

  let { children, data } = $props();
  const session = createClientSession(untrack(() => data.session));
  const aiClient = provideAiClient();
  let aiIdentity = untrack(() => data.session?.user?.id ?? null);
  setContext(CLIENT_SESSION_CONTEXT, session);
  setContext('site-account', () => $session?.account ?? null);
  setContext('site-account-checking', () => $session === null);

  $effect(() => {
    const nextIdentity = $session?.user?.id ?? null;
    if (nextIdentity !== aiIdentity) {
      aiIdentity = nextIdentity;
      aiClient.reset();
    }
  });
  $effect(() => {
    if (page.url.searchParams.get('ai') === 'open' && $session?.user) aiClient.setOpen(true);
  });

  beforeNavigate(createClientNavigationGuard(session, {
    origin: () => page.url.origin,
    navigate: (url) => goto(url),
    error: (message) => globalMessages.error(message),
  }));

  onMount(() => {
    const uninstall = installAuthInteraction({ session, login: () => loginDialog.open(), error: message => globalMessages.error(message) });
    const uninstallControls = installAuthControls(session, document, message => globalMessages.error(message), url => goto(url));
    applyPreferences(readPreferences());
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/service-worker.js', {scope:'/'}).catch(() => {});
    // Authenticated SSR already seeded this store. Public pages bootstrap once in
    // the background without making report rendering depend on Auth0.
    void session.load().then(() => {
      if (pageRequiresLogin(page.url.pathname)) {
        return requireClientLogin(page.url.pathname + page.url.search + page.url.hash, session);
      }
    }).catch((error) => { if (!isLoginRedirecting()) globalMessages.error(error.message); });
    return () => { uninstallControls(); uninstall(); };
  });
</script>

<GlobalMessages />
<ProtectedReportPreview />
<LoginDialog bind:this={loginDialog} {session} />
<div class="site-with-ai">
  <div class="site-content">{@render children()}</div>
  <AiPanel client={aiClient} identity={$session?.user?.id ?? null} />
</div>

<style>
  :global(.site-with-ai) { display:flex; align-items:flex-start; height:100dvh; min-height:0; }
  :global(.site-content) { flex:1; min-width:0; min-height:0; height:100%; }
  @media (max-width:600px) {
    :global(.site-with-ai) { display:block; }
    :global(.site-with-ai:has(.page-shell)) { height:auto; min-height:100dvh; }
    :global(.site-with-ai:has(.page-shell) .site-content) { height:auto; }
  }
</style>
