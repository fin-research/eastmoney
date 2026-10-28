<script lang="ts">
  import BondLedgerPage from "$lib/pages/BondLedgerPage.svelte";
  import FinancingModelPage from "$lib/pages/FinancingModelPage.svelte";
  import SecondaryBondPoolWeeklyPage from "$lib/pages/SecondaryBondPoolWeeklyPage.svelte";
  import MarketHotspotsPage from "$lib/pages/MarketHotspotsPage.svelte";
  import CommentaryPage from "$lib/pages/CommentaryPage.svelte";
  import PolicyTrackingPage from "$lib/pages/PolicyTrackingPage.svelte";
  import WorkbenchShell from "../workbench/WorkbenchShell.svelte";
  import OverviewView from "./OverviewView.svelte";
  import ResearchView from "./ResearchView.svelte";
  import TradingView from "./TradingView.svelte";
  import InterbankLedgerView from "./InterbankLedgerView.svelte";
  import WorkflowView from "./WorkflowView.svelte";
  import { normalizeWorkbenchView, workbenchViewPath, workbenchRoutes, workbenchViews, type WorkbenchViewId } from "./demo-data";

  let { viewId = "overview" }: { viewId?: string | null } = $props();
  const activeViewId = $derived(normalizeWorkbenchView(viewId));
  const views = workbenchViews.map(view => ({ ...view, href: workbenchViewPath(view.id) }));
  const tradingTabs = [
    { id: "trading", label: "交易记录", href: workbenchViewPath("trading") },
    { id: "workflow", label: "交易流程", href: workbenchViewPath("workflow") },
    { id: "interbank-ledger", label: "拆借台账", href: workbenchViewPath("interbank-ledger") },
  ];
  const isTradingView = $derived(activeViewId === "trading" || activeViewId === "workflow" || activeViewId === "interbank-ledger");
  const shellViewId = $derived(isTradingView ? "trading" : activeViewId);
  function isIntegratedView(value: WorkbenchViewId) {
    return value === "bond" || value === "secondary-bond-pool" || value === "financing-model";
  }
  function isLayoutReport(value: WorkbenchViewId) {
    return value === "secondary-bond-pool" || value === "financing-model";
  }
</script>

<WorkbenchShell title="交易研究工作台" homeHref="/trading-research" {views} activeViewId={shellViewId}
  activeHref={workbenchViewPath(shellViewId)}
  activeLabel={workbenchRoutes.find(view => view.id === shellViewId)?.label}
  tabs={isTradingView ? tradingTabs : []} activeTabId={isTradingView ? activeViewId : ""}
  integrated={isIntegratedView(activeViewId)} layoutReport={isLayoutReport(activeViewId)}
  canvas={activeViewId === "market-hotspots"}
  reportKind={activeViewId === "secondary-bond-pool" ? "secondary" : activeViewId === "financing-model" ? "financing" : null}>
  {#if activeViewId === "overview"}
    <OverviewView />
  {:else if activeViewId === "trading"}
    <TradingView />
  {:else if activeViewId === "market-hotspots"}
    <MarketHotspotsPage embedded />
  {:else if activeViewId === "policy-tracking"}
    <PolicyTrackingPage embedded />
  {:else if activeViewId === "tracking-commentary"}
    <CommentaryPage />
  {:else if activeViewId === "research"}
    <ResearchView />
  {:else if activeViewId === "interbank-ledger"}
    <InterbankLedgerView />
  {:else if activeViewId === "workflow"}
    <WorkflowView />
  {:else if activeViewId === "bond"}
    <BondLedgerPage embedded />
  {:else if activeViewId === "secondary-bond-pool"}
    <SecondaryBondPoolWeeklyPage embedded />
  {:else}
    <FinancingModelPage embedded />
  {/if}
</WorkbenchShell>
