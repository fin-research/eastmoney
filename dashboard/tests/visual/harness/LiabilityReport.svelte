<script lang="ts">
  import FinancingLayout from '../../../src/routes/financing/+layout.svelte';
  import LiabilityReport from '../../../src/routes/financing/liability-report/+page.svelte';
  import {liabilityAudit} from '../liability-fixture.mjs';
  import {page} from './state.js';
  import {PERMISSION_CODES} from '../../../src/lib/permissions';
  import '../../../src/routes/financing/layout.css';
  const data={report:liabilityAudit,hasSnapshot:true,snapshotVersion:'audit-1',selectedReportDate:'2026-09-15',today:'2026-09-15',permissions:[...PERMISSION_CODES],account:null,session:null,auth0:true,snapshotError:null,externalDataApiUrl:'/data',user:{id:'auth0|test',personId:'fixture',email:'test@18.cn',personName:'测试用户',roles:[],role:'admin',picture:''},reminders:{items:[],total:0}};
  page.data=data;
</script>
<FinancingLayout {data}><LiabilityReport {data}/></FinancingLayout>
