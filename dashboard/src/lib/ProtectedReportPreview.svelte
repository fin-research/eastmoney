<script lang="ts">
  import Modal from '$lib/components/Modal.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { protectedReport } from './protected-report';
  let dialog: Modal;
  $effect(() => { if ($protectedReport !== null) dialog?.showModal(); });
</script>
<Modal bind:this={dialog} aria-label="资金日报" onclose={() => protectedReport.set(null)}>
  <div class="report-preview"><Button variant="ghost" onclick={() => dialog.close()}>关闭</Button>
    {#if $protectedReport !== null}<iframe title="资金日报" sandbox="allow-scripts allow-downloads" referrerpolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'" srcdoc={$protectedReport}></iframe>{/if}
  </div>
</Modal>
<style>.report-preview{width:min(90vw,90rem);height:85dvh;display:flex;flex-direction:column;gap:.5rem}.report-preview :global(button){align-self:flex-end}iframe{width:100%;flex:1;border:0;background:white}</style>
