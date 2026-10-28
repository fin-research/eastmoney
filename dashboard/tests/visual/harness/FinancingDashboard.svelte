<script lang="ts">
 import FinancingLayout from '../../../src/routes/financing/+layout.svelte';
 import Dashboard from '../../../src/routes/financing/+page.svelte';
 import {financingDashboardData} from '../financing-dashboard-fixture.mjs';
 const data=financingDashboardData(new URL(window.location.href));
</script>
<FinancingLayout {data}><Dashboard {data}/></FinancingLayout>
