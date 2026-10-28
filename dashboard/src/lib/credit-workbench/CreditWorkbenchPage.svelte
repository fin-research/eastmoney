<script lang="ts">
  import { afterNavigate } from "$app/navigation";
  import type { CreditReportResponse } from "../credit/types.ts";
  import WorkbenchShell from "../workbench/WorkbenchShell.svelte";
  import CreditView from "../trading-research/CreditView.svelte";
  import { creditWorkbenchViews, type CreditWorkbenchViewId } from "./navigation";

  let { viewId = "overview" }: { viewId?: CreditWorkbenchViewId } = $props();
  let overviewTab = $state('dashboard');
  let reportDate = $state('');
  afterNavigate(({ to }) => {
    overviewTab = to?.url?.searchParams.get('tab') === 'bank-credit' ? 'bank-credit' : 'dashboard';
  });
  const tabs = $derived(viewId === 'overview' ? [
    { id: 'dashboard', label: '仪表盘', href: `/credit-workbench${reportDate ? `?date=${reportDate}` : ''}` },
    { id: 'bank-credit', label: '银行授信情况', href: `/credit-workbench?tab=bank-credit${reportDate ? `&date=${reportDate}` : ''}` },
  ] : []);
  function updateReport(report: CreditReportResponse) { reportDate = report.summary.reportDate; }
</script>

<WorkbenchShell title="授信工作台" homeHref="/credit-workbench" views={creditWorkbenchViews}
  activeViewId={viewId} tone="teal" {tabs} activeTabId={overviewTab}
  visualVariant={viewId === "weekly" ? "report" : "workspace"}>
  <CreditView tab={viewId} {overviewTab} onreport={updateReport} />
</WorkbenchShell>
