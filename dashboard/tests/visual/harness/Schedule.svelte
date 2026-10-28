<script>
  import { Button } from "$lib/components/ui/button/index.js";
  import WorkbenchShell from '../../../src/lib/workbench/WorkbenchShell.svelte';
  import ModuleCard from '../../../src/components/ModuleCard.svelte';
  import ScheduleFields from '../../../src/lib/financing/components/ScheduleFields.svelte';
  import '../../../src/routes/financing/dashboard.css';
</script>
<WorkbenchShell title="融资工作台" homeHref="/financing" views={[{id:'sop',label:'SOP 管理',href:'/financing/sop',icon:'check'}]} activeViewId="sop" activeLabel="发行节点" tone="orange">
  <div class="financing-scope">
    <ModuleCard>
      <form>
        <ScheduleFields relative scheduleType="period" startValue={-5} endValue={-1} />
        <Button type="reset">重置</Button>
      </form>
    </ModuleCard>
  </div>
</WorkbenchShell>
