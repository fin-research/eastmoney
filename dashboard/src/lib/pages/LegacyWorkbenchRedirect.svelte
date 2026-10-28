<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { globalMessages } from "$lib/global-messages";

  let { to }: { to: string } = $props();
  onMount(() => {
    // The fragment is browser-only; preserve existing policy anchor links.
    void goto(to + window.location.search + window.location.hash, { replaceState: true })
      .catch(error => globalMessages.error(error instanceof Error ? error.message : "页面打开失败，请重试"));
  });
</script>

<p role="status">正在打开工作台… <a href={to}>继续打开</a></p>
