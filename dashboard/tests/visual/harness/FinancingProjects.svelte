<script lang="ts">
  import FinancingLayout from '../../../src/routes/financing/+layout.svelte';
  import Projects from '../../../src/routes/financing/projects/+page.svelte';
  import Detail from '../../../src/routes/financing/projects/[id]/+page.svelte';
  import {projectData} from '../project-fixtures.mjs';
  const isDetail=window.location.pathname!=='/financing/projects';
</script>
<FinancingLayout data={projectData}>
  {#if isDetail}<Detail data={projectData} form={null}/>{:else}<Projects data={projectData}/>{/if}
</FinancingLayout>
