<script lang="ts">
  import FinancingLayout from '../../../src/routes/financing/+layout.svelte';
  import Detail from '../../../src/routes/financing/sop/[id]/+page.svelte';
  import History from '../../../src/routes/financing/sop/reminders/+page.svelte';
  import {sopDetailAudit,reminderRows} from '../sop-fixtures.mjs';
  const url=new URL(window.location.href);
  const isHistory=url.pathname==='/financing/sop/reminders';
  const filters={status:url.searchParams.get('status')??'',query:url.searchParams.get('query')??''};
  const rows=reminderRows.filter(row=>(!filters.status||row.status===filters.status)&&(!filters.query||`${row.ruleName} ${row.targetId} ${row.recipients.join(' ')}`.includes(filters.query)));
  const historyData={...sopDetailAudit,filters,history:{rows,summary:{total:4,sent:1,pending:1,failed:1},nextCursor:'fixture-next',hasMore:!filters.status&&!filters.query}};
</script>
<FinancingLayout data={sopDetailAudit}>
 {#if isHistory}<History data={historyData}/>{:else}<Detail data={sopDetailAudit} form={null}/>{/if}
</FinancingLayout>
