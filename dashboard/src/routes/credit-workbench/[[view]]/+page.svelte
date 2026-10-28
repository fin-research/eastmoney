<script lang="ts">
  import CreditWorkbenchPage from "$lib/credit-workbench/CreditWorkbenchPage.svelte";
  import type { CreditWorkbenchViewId } from "$lib/credit-workbench/navigation";

  let { data }: { data: { view: CreditWorkbenchViewId } } = $props();
</script>

<CreditWorkbenchPage viewId={data.view} />
