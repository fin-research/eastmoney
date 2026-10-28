<script lang="ts">
  import WorkbenchPage from "$lib/trading-research/WorkbenchPage.svelte";
  import type { WorkbenchViewId } from "$lib/trading-research/demo-data";

  let { data }: { data: { view: WorkbenchViewId } } = $props();
</script>

<WorkbenchPage viewId={data.view} />
