<script lang="ts">
  import FinancingLayout from '../../../src/routes/financing/+layout.svelte';
  import SopPage from '../../../src/routes/financing/sop/+page.svelte';
  import '../../../src/routes/financing/layout.css';
  import { PERMISSION_CODES } from '../../../src/lib/permissions';
  import { managementAudit } from '../management-fixtures.mjs';
  const data = { ...managementAudit, permissions: [...PERMISSION_CODES],
    reminders: { items: [], total: 0 }, settings: {
    sopTemplates: [{ id: 'short-term', name: '短期融资券发行 SOP', debtType: '短期融资券', isActive: true,
      description: '立项、申报、发行和存续期管理。', nodeCount: 2,
      nodes: [{ id: 'approval', name: '材料准备与内部审批' }, { id: 'issue', name: '簿记发行' }] }],
    reminderRules: [{ id: 'due', name: '任务到期提醒', isActive: true, recipientMode: 'assignee',
      periods: [{ leadHours: 24 }], targets: [{ sopName: '短期融资券发行 SOP', name: '簿记发行' }] }],
  } };
</script>

<FinancingLayout {data}>
  <SopPage {data} />
</FinancingLayout>
