<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { onMount } from "svelte";

  import ChartHost from "../../components/ChartHost.svelte";
  import MetricCard from "../../components/MetricCard.svelte";
  import ModuleCard from "../../components/ModuleCard.svelte";
  import {
    renderWorkbenchBarChart,
    renderWorkbenchTrendChart,
  } from "../../charts/trading-research";
  import { fetchCreditReport } from "../credit/client.ts";
  import type { CreditReportResponse } from "../credit/types.ts";
  import Badge from "./Badge.svelte";
  import PanelHeading from "./PanelHeading.svelte";
  import SectionHeading from "./SectionHeading.svelte";
  import WorkbenchIcon from "./WorkbenchIcon.svelte";
  import {
    fundingOverview,
    fundingTrend,
    overviewAlerts,
    overviewCreditFallback,
    secondaryPoolSnapshot,
    termDistribution,
    tradingSummary,
  } from "./demo-data";

  type AlertFilter = "all" | "pending" | "acknowledged";

  let creditReport = $state<CreditReportResponse | null>(null);
  let alertFilter = $state<AlertFilter>("pending");
  let acknowledgedAlertIds = $state<string[]>([]);

  const creditSummary = $derived(
    creditReport?.summary ?? overviewCreditFallback,
  );
  const productDistribution = $derived([
    {
      label: "同业拆借（纯信用）",
      value: tradingSummary.interbankAmount,
      color: "#2f6fed",
    },
    {
      label: "拆出（质押式回购）",
      value: tradingSummary.repoLendAmount,
      color: "#f79009",
    },
  ]);
  const visibleAlerts = $derived.by(() =>
    overviewAlerts.filter((alert) => {
      const acknowledged = acknowledgedAlertIds.includes(alert.id);
      if (alertFilter === "pending") return !acknowledged;
      if (alertFilter === "acknowledged") return acknowledged;
      return true;
    }),
  );

  onMount(() => {
    void fetchCreditReport()
      .then((report) => {
        creditReport = report;
      })
      .catch(() => undefined);
  });

  function toggleAlert(alertId: string): void {
    acknowledgedAlertIds = acknowledgedAlertIds.includes(alertId)
      ? acknowledgedAlertIds.filter((id) => id !== alertId)
      : [...acknowledgedAlertIds, alertId];
  }
</script>

<div class="tr-view-stack">
  <section aria-labelledby="overview-funding-title">
    <SectionHeading id="overview-funding-title" title="资金存量指标" accent="var(--tr-orange)" />
    <div class="tr-metric-grid">
      <MetricCard
        label="融入融出合计"
        value={fundingOverview.total.toFixed(1)}
        unit="亿元"
        iconComponent={WorkbenchIcon}
        iconProps={{ name: "funds" }}
        tone="orange"
      />
      <MetricCard
        label="存量融入余额"
        value={fundingOverview.borrowTotal.toFixed(1)}
        unit="亿元"
        detail="较前一交易日 +0.2亿元"
        iconComponent={WorkbenchIcon}
        iconProps={{ name: "trading" }}
        tone="blue"
      />
      <MetricCard
        label="存量融出余额"
        value={fundingOverview.lendTotal.toFixed(1)}
        unit="亿元"
        detail="较前一交易日 +11.0亿元"
        iconComponent={WorkbenchIcon}
        iconProps={{ name: "credit" }}
        tone="cyan"
      />
      <MetricCard
        label="当日成交加权利率"
        value={tradingSummary.weightedRate.toFixed(3)}
        unit="%"
        detail={`${tradingSummary.tradeCount}笔`}
        iconComponent={WorkbenchIcon}
        iconProps={{ name: "research" }}
        tone="purple"
      />
    </div>
  </section>

  <section aria-labelledby="overview-credit-title">
    <SectionHeading id="overview-credit-title" title="授信概览" accent="var(--tr-green)" />
    <div class="tr-metric-grid">
      <MetricCard
        label="授信总额度"
        value={creditSummary.totalLimit.toFixed(1)}
        unit="亿元"
        detail={`${creditSummary.institutionCount}家机构`}
        iconComponent={WorkbenchIcon}
        iconProps={{ name: "credit" }}
        tone="blue"
      />
      <MetricCard
        label="已使用额度"
        value={creditSummary.totalUsed.toFixed(1)}
        unit="亿元"
        detail={`可用 ${creditSummary.totalAvailable.toFixed(1)}亿元`}
        iconComponent={WorkbenchIcon}
        iconProps={{ name: "funds" }}
        tone="orange"
      />
      <MetricCard
        label="授信使用率"
        value={creditSummary.utilization.toFixed(1)}
        unit="%"
        detail={`${creditSummary.expiringWithin30Days}笔将在30日内到期`}
        iconComponent={WorkbenchIcon}
        iconProps={{ name: "warning" }}
        tone="red"
      />
    </div>
  </section>

  <section aria-labelledby="overview-secondary-title">
    <SectionHeading id="overview-secondary-title" title="二级资金池概览" accent="var(--tr-purple)" />
    <div class="tr-metric-grid">
      <MetricCard
        label="业务本金"
        value={secondaryPoolSnapshot.principal.toFixed(2)}
        unit="亿元"
        iconComponent={WorkbenchIcon}
        iconProps={{ name: "bond" }}
        tone="blue"
      />
      <MetricCard
        label="持仓市值"
        value={secondaryPoolSnapshot.marketValue.toFixed(2)}
        unit="亿元"
        detail={`${secondaryPoolSnapshot.positionCount}笔正持仓`}
        iconComponent={WorkbenchIcon}
        iconProps={{ name: "database" }}
        tone="purple"
      />
      <MetricCard
        label="年化收益率（含免税）"
        value={secondaryPoolSnapshot.annualizedReturn.toFixed(2)}
        unit="%"
        iconComponent={WorkbenchIcon}
        iconProps={{ name: "research" }}
        tone="green"
      />
      <MetricCard
        label="当日营收"
        value={secondaryPoolSnapshot.dailyRevenue.toFixed(2)}
        unit="万元"
        iconComponent={WorkbenchIcon}
        iconProps={{ name: "funds" }}
        tone="orange"
      />
    </div>
  </section>

  <div class="tr-three-column">
    <ModuleCard labelledBy="funding-trend-title">
      <PanelHeading id="funding-trend-title" title="融入/融出存量趋势">
        <Badge>近30日 · 亿元</Badge>
      </PanelHeading>
      <ChartHost
        renderer={renderWorkbenchTrendChart}
        args={[fundingTrend, "近30日资金融入与融出存量趋势", "亿元"]}
        ariaLabel="近30日资金融入与融出存量趋势图"
        className="tr-chart-host tr-chart-host--compact"
      />
    </ModuleCard>

    <ModuleCard labelledBy="overview-product-title">
      <PanelHeading id="overview-product-title" title="品种分布" accent="var(--tr-orange)">
        <Badge>当日成交金额</Badge>
      </PanelHeading>
      <ChartHost
        renderer={renderWorkbenchBarChart}
        args={[productDistribution, "交易研究组当日成交品种分布", "亿元"]}
        ariaLabel="交易研究组当日成交品种分布横向柱状图"
        className="tr-chart-host tr-chart-host--compact"
      />
    </ModuleCard>

    <ModuleCard labelledBy="overview-term-title">
      <PanelHeading id="overview-term-title" title="期限分布" accent="var(--tr-purple)">
        <Badge>当日成交金额</Badge>
      </PanelHeading>
      <ChartHost
        renderer={renderWorkbenchBarChart}
        args={[termDistribution, "当日交易期限分布", "亿元"]}
        ariaLabel="当日交易期限分布横向柱状图"
        className="tr-chart-host tr-chart-host--compact"
      />
    </ModuleCard>
  </div>

  <ModuleCard labelledBy="overview-alerts-title">
    <PanelHeading id="overview-alerts-title" title="预警中心" accent="var(--tr-orange)">
      <div class="tr-filter-chips" role="group" aria-label="预警筛选">
        <Button data-ui-owner="lib-trading-research-OverviewView-svelte" variant="outline" class={["ui-button", alertFilter === "all" && "is-selected"]}  type="button" onclick={() => (alertFilter = "all")}>全部 {overviewAlerts.length}</Button>
        <Button data-ui-owner="lib-trading-research-OverviewView-svelte" variant="outline" class={["ui-button", alertFilter === "pending" && "is-selected"]}  type="button" onclick={() => (alertFilter = "pending")}>待处理 {overviewAlerts.length - acknowledgedAlertIds.length}</Button>
        <Button data-ui-owner="lib-trading-research-OverviewView-svelte" variant="outline" class={["ui-button", alertFilter === "acknowledged" && "is-selected"]}  type="button" onclick={() => (alertFilter = "acknowledged")}>已确认 {acknowledgedAlertIds.length}</Button>
      </div>
    </PanelHeading>
    <div class="tr-alert-list">
      {#each visibleAlerts as alert}
        <article class={`tr-alert tr-alert--${alert.level}`}>
          <span class="tr-alert__icon" aria-hidden="true"><WorkbenchIcon name="warning" /></span>
          <div>
            <div class="tr-alert__meta">
              <strong>{alert.category}</strong>
              <span>{alert.owner}</span>
              <time>{alert.eventAt}</time>
            </div>
            <p>{alert.text}</p>
            <Button data-ui-owner="lib-trading-research-OverviewView-svelte" variant="outline" class={"ui-button tr-alert-action"} type="button" onclick={() => toggleAlert(alert.id)}>
              {acknowledgedAlertIds.includes(alert.id) ? "恢复待处理" : "确认已知"}
            </Button>
          </div>
        </article>
      {:else}
        <p class="tr-empty-state">当前筛选下无风险事项</p>
      {/each}
    </div>
  </ModuleCard>
</div>
