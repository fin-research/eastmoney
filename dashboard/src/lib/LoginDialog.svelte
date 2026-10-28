<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import LoginPrompt from './LoginPrompt.svelte';
  import { onMount, onDestroy } from 'svelte';
  import type { ClientSession } from './client-session';
  import { createLoginPopup } from './login-popup';
  import type { LoginFailure } from './login-failure';

  let { session }: { session: ClientSession } = $props();
  let dialog: Modal;
  let waiting = $state(false);
  let failure = $state<LoginFailure | null>(null);
  let resolveLogin: ((result: boolean) => void) | null = null;
  let pending: Promise<boolean> | null = null;
  let popup: ReturnType<typeof createLoginPopup> | undefined;
  function finish(result: boolean) {
    const resolve = resolveLogin;
    resolveLogin = null; pending = null;
    popup?.stop();
    dialog?.close();
    resolve?.(result);
  }
  export function open(): Promise<boolean> {
    if (pending) return pending;
    failure = null;
    pending = new Promise(resolve => { resolveLogin = resolve; });
    dialog.showModal();
    return pending;
  }
  onMount(() => {
    popup = createLoginPopup(session, {
      complete: () => finish(true), error: value => { failure = value; },
      waiting: value => { waiting = value; if (value) failure = null; },
    });
  });
  onDestroy(() => finish(false));
</script>

<Modal bind:this={dialog}  aria-labelledby="site-login-title" oncancel={() => finish(false)} onclose={() => { if (!dialog.isOpen() && pending) finish(false); }}>
  <LoginPrompt {waiting} {failure} oncancel={() => finish(false)} onretry={() => { void popup?.open(); }} />
</Modal>
