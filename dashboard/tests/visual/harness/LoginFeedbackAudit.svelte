<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from '../../../src/lib/components/Modal.svelte';
  import LoginPrompt from '../../../src/lib/LoginPrompt.svelte';
  import LoginRetry from '../../../src/lib/LoginRetry.svelte';
  import { loginFailure } from '../../../src/lib/login-failure';
  // Static feedback presentation only: no SDK, credentials or authentication requests.
  const modal = new URL(window.location.href).searchParams.get('modal') === '1';
  let dialog: Modal;
  const failure = loginFailure({ error: 'access_denied', error_description: '请先验证注册邮箱，再返回登录' });
  onMount(() => { if (modal) dialog.showModal(); });
</script>

{#if modal}
  <Modal bind:this={dialog} aria-labelledby="site-login-title">
    <LoginPrompt {failure} oncancel={() => dialog.close()} onretry={() => {}} />
  </Modal>
{:else}
  <LoginRetry {failure} onretry={() => {}} />
{/if}
