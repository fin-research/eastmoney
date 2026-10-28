<script lang="ts">
  import ManagementLayout from '../../../src/routes/management/+layout.svelte';
  import People from '../../../src/routes/management/people/+page.svelte';
  import Me from '../../../src/routes/management/me/+page.svelte';
  import Notifications from '../../../src/routes/management/notifications/+page.svelte';
  import {managementAudit} from '../management-fixtures.mjs';
  const path=window.location.pathname;
  const tab: 'people' | 'roles'=window.location.search.includes('tab=roles') ? 'roles' : 'people';
  const roleData={...managementAudit,tab:'roles' as const,people:[]};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(input,init)=>input==='/api/management/people'
    ? window.location.search.includes('loading=1')
      ? new Promise<Response>(()=>{}) : Promise.resolve(Response.json(managementAudit.people))
    : originalFetch(input,init);
</script>
<ManagementLayout>
  {#if path==='/management/people' && tab==='roles'}<People data={{...managementAudit,tab:'roles',view:roleData}} params={{}} form={null} />
  {:else if path==='/management/people'}<People data={{...managementAudit,tab:'people',view:null}} params={{}} form={null} />
  {:else if path==='/management/me'}<Me data={managementAudit} />
  {:else}<Notifications />{/if}
</ManagementLayout>
