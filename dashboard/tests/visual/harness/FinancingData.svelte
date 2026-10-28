<script lang="ts">
  import WorkbenchShell from '../../../src/lib/workbench/WorkbenchShell.svelte';
  import DataPage from '../../../src/routes/financing/data/+page.svelte';
  import '../../../src/routes/financing/layout.css';
  import type { WorkbenchPageLink } from '../../../src/lib/workbench/navigation';
  import { PERMISSION_CODES } from '../../../src/lib/permissions';
  import { page } from '$app/state';
  import { DATA_ADMIN_TABS } from '../../../src/lib/financing/data-admin';
  const views: WorkbenchPageLink[] = [{id:'data',label:'融资数据',href:'/financing/data',icon:'database'}];
  const data={permissions:[...PERMISSION_CODES],user:null,account:null,session:null,auth0:true,reminders:{items:[],total:0}};
</script>
<WorkbenchShell title="融资工作台" homeHref="/financing/" {views} activeViewId="data" tabs={DATA_ADMIN_TABS} activeTabId={page.url.searchParams.get('tab')??'management'} class="financing-scope">
  <DataPage {data}/>
</WorkbenchShell>
