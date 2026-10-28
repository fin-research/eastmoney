<script lang="ts">
  import { globalMessages } from '../global-messages.ts';
  import Modal from '$lib/components/Modal.svelte';
  import CreditReportDatePicker from './CreditReportDatePicker.svelte';
  import { isCreditFinalized } from '../credit/report-date.ts';
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { NativeSelect } from "$lib/components/ui/native-select/index.js";
  import { onMount } from "svelte";
  import { afterNavigate, replaceState } from "$app/navigation";

  import BankCreditStatus from "../credit-workbench/BankCreditStatus.svelte";
  import ChartHost from "../../components/ChartHost.svelte";
  import MetricCard from "../../components/MetricCard.svelte";
  import ModuleCard from "../../components/ModuleCard.svelte";
  import { buildCreditOverview } from "../credit/overview.ts";
  import { renderCreditOverviewBarChart, renderCreditOverviewDonutChart, renderCreditOverviewHistogram, renderCreditOverviewGauge } from "../../charts/credit-overview";
  import MultiSelectFilter from "../financing/MultiSelectFilter.svelte";
  import { creditLimitFilterLabels, matchesCreditCalendarEvent } from "../credit/calendar.ts";
  import { portal } from "../portal.ts";
  import { scrollableRegion } from "../scrollable-region";
  import {applyCreditDataUpdate,type CreditDataset} from "../credit/data.ts";
  import {buildCreditReport} from "../credit/build-report.ts";
  import { fetchCreditData } from "../credit/client.ts";
  import {
    creditItemLabels,
    creditItemTypes,
    type CreditInstitutionView,
    type CreditInstitutionUpdateResponse,
    type CreditItemType,
    type CreditReportResponse,
    type CreditStatus,
    type CreditWeeklyNewsItem,
  } from "../credit/types.ts";
  import { groupCreditInstitutions, cycleCreditSort, defaultCreditSort, type CreditSort, type CreditSortKey as SortKey } from "../credit/sorting.ts";
  import { creditCategoryTone, compareCreditInstitutionOrder, matchesCreditStatus } from "../credit/presentation.ts";
  import { creditEffectiveStatus, isCreditEffective, type CreditEffectiveStatus } from "../credit/validity.ts";
  import { formatCreditWeeklyNews } from "../credit/weekly-news.ts";
  import CreditApplicationDialog from "./CreditApplicationDialog.svelte";
  import CreditDetailEditor from "./CreditDetailEditor.svelte";
  import Badge from "./Badge.svelte";
  import PanelHeading from "./PanelHeading.svelte";
  import SectionHeading from "./SectionHeading.svelte";
  import WorkbenchIcon from "./WorkbenchIcon.svelte";

  type CreditTab = "overview" | "ledger" | "calendar" | "weekly";
  type CreditAlert = {
    id: string;
    level: "critical" | "high" | "medium" | "low";
    label: string;
    meta: string;
    text: string;
  };


  const weekdays = ["一", "二", "三", "四", "五", "六", "日"];

  let { tab = "overview", overviewTab = "dashboard", onreport }: { tab?: CreditTab; overviewTab?: string; onreport?: (report: CreditReportResponse) => void } = $props();
  const activeTab = $derived(tab);
  let sourceData=$state<CreditDataset|null>(null);
  let report=$derived(sourceData?buildCreditReport(sourceData):null);
  $effect(() => { if (report) onreport?.(report); });
  let loading = $state(true);
  let errorMessage = $state("");
  let query = $state("");
  let statusFilter = $state<CreditStatus | "active" | "all">("active");
  let riskFilter = $state("all");
  let selectedInstitutionName = $state<string | null>(null);
  let detailDialog: Modal;
  const selectedInstitution = $derived(report?.institutions.find(row => row.institutionName === selectedInstitutionName));
  let sorts = $state<CreditSort[]>([...defaultCreditSort]);
  let calendarLimitFilters = $state<string[]>([]);
  let calendarUsageFilters = $state<string[]>([]);
  let calendarMonth = $state("");
  let applicationDialog = $state<CreditApplicationDialog | null>(null);
  let loadSequence = $state(0);
  let requestedReportDate: string | null = null;
  let exporting = $state(false);
  let weeklyReport: HTMLDivElement;

  async function exportExcel(): Promise<void> {
    if (!report || loading || exporting) return;
    const snapshot = $state.snapshot(report);
    if (!snapshot.institutions.some(row => creditEffectiveStatus(row) !== 'revoked')) {
      globalMessages.info('暂无可导出的授信机构');
      return;
    }
    exporting = true;
    try {
      const { downloadCreditWorkbook } = await import('../credit/export.ts');
      await downloadCreditWorkbook(snapshot);
    } catch {
      globalMessages.error('Excel导出失败，请重试');
    } finally {
      exporting = false;
    }
  }

  function applyUpdate(result: CreditInstitutionUpdateResponse, version: number): void {
    if (!report || loading || version !== loadSequence) return;
    if(sourceData)sourceData=applyCreditDataUpdate(sourceData,result,calendarMonth);
  }

  const filteredInstitutions = $derived.by(() => {
    const currentReport = report;
    if (!currentReport) return [];
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return currentReport.institutions
      .filter((institution) => {
        const matchesQuery =
          !normalizedQuery ||
          [
            institution.institutionName,
            institution.institutionType,
            institution.bankOffice,
            institution.applyingDepartment,
            institution.handler,
          ]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase("zh-CN")
            .includes(normalizedQuery);
        const matchesStatus =
          matchesCreditStatus(institution.status, statusFilter);
        const matchesRisk =
          riskFilter === "all" ||
          (riskFilter === "attention" && isCreditEffective(institution) && (institution.utilization ?? 0) >= 60) ||
          (riskFilter === "warning" && isCreditEffective(institution) && (institution.utilization ?? 0) >= 80) ||
          (riskFilter === "expiry" && isCreditEffective(institution) &&
            Boolean(
              institution.expiryDate &&
                daysBetween(currentReport.summary.reportDate, institution.expiryDate) >= 0 &&
                daysBetween(currentReport.summary.reportDate, institution.expiryDate) <= 30,
            ));
        return matchesQuery && matchesStatus && matchesRisk;
      });
  });

  const ledgerGroups = $derived(groupCreditInstitutions(filteredInstitutions, sorts));
  const overview = $derived(buildCreditOverview(report?.institutions ?? [], report?.summary.reportDate ?? ''));
  const overviewCharts = $derived([
    { id: 'bank-limits', title: '授信额度（按类型）', rows: overview.bankLimits, unit: '亿元' },
    { id: 'bank-usage', title: '已用额度（按类型）', rows: overview.bankUsage, unit: '亿元' },
    { id: 'bank-utilization', title: '使用率（按类型）', rows: overview.bankUtilization, unit: '%' },
    { id: 'product-limits', title: '授信额度（按品种）', rows: overview.productLimits, unit: '亿元' },
    { id: 'product-usage', title: '已用额度（按品种）', rows: overview.productUsage, unit: '亿元' },
    { id: 'product-utilization', title: '使用率（按品种）', rows: overview.productUtilization, unit: '%' },
    { id: 'top-limits', title: '授信额度 Top10', rows: overview.topLimits, unit: '亿元' },
    { id: 'top-usage', title: '已用额度 Top10', rows: overview.topUsage, unit: '亿元' },
    { id: 'top-utilization', title: '使用率 Top10', rows: overview.topUtilization, unit: '%' },
  ]);
  const overviewDistributions = $derived([
    { id: 'status-counts', title: '授信状态', rows: overview.statusCounts, renderer: renderCreditOverviewDonutChart },
    { id: 'expiry-counts', title: '到期期限分布', rows: overview.expiryCounts, renderer: renderCreditOverviewHistogram },
  ]);

  const weeklyNews = $derived.by(() => {
    return report?.weeklyNews.map(formatCreditWeeklyNews) ?? [];
  });

  const weeklyCreditDetailGroups = $derived.by(() => {
    const groups = new Map<string, CreditInstitutionView[]>();
    const institutions = (report?.institutions ?? [])
      .filter(
        (institution) =>
          institution.status !== "revoked",
      )
      .sort(compareCreditInstitutionOrder);
    for (const institution of institutions) {
      const group = groups.get(institution.institutionType) ?? [];
      group.push(institution);
      groups.set(institution.institutionType, group);
    }
    return [...groups].map(([institutionType, groupedInstitutions]) => ({
      institutionType,
      institutions: groupedInstitutions,
    }));
  });

  const creditAlerts = $derived.by(() => {
    const currentReport = report;
    if (!currentReport) return [];
    const alerts: CreditAlert[] = [];
    for (const institution of currentReport.institutions) {
      const utilization = institution.utilization ?? 0;
      if (isCreditEffective(institution) && utilization >= 60) {
        alerts.push({
          id: `usage-${institution.institutionName}`,
          level: utilization >= 80 ? "critical" : "medium",
          label: utilization >= 80 ? "额度预警" : "额度关注",
          meta: `${utilization.toFixed(1)}%`,
          text: `${institution.institutionName}授信额度使用率达到${utilization.toFixed(1)}%`,
        });
      }
      if (institution.expiryDate && isCreditEffective(institution)) {
        const remainingDays = daysBetween(
          currentReport.summary.reportDate,
          institution.expiryDate,
        );
        if (remainingDays >= 0 && remainingDays <= 30) {
          alerts.push({
            id: `expiry-${institution.institutionName}`,
            level: remainingDays <= 7 ? "critical" : "high",
            label: "到期预警",
            meta: `${remainingDays}天`,
            text: `${institution.institutionName}授信将在${remainingDays}天内到期，需安排续作材料`,
          });
        }
      }
    }
    const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    return alerts.sort((left, right) => order[left.level] - order[right.level]);
  });

  const calendarCells = $derived.by(() => {
    if (!calendarMonth) return [];
    const first = new Date(`${calendarMonth}-01T00:00:00Z`);
    const mondayOffset = (first.getUTCDay() + 6) % 7;
    first.setUTCDate(first.getUTCDate() - mondayOffset);
    const visibleEvents = (report?.calendarEvents ?? []).filter(
      (event) => matchesCreditCalendarEvent(event, calendarLimitFilters, calendarUsageFilters),
    );
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(first);
      date.setUTCDate(date.getUTCDate() + index);
      const dateKey = date.toISOString().slice(0, 10);
      return {
        date: dateKey,
        day: date.getUTCDate(),
        outside: dateKey.slice(0, 7) !== calendarMonth,
        reportDate: dateKey === report?.summary.reportDate,
        events: visibleEvents.filter((event) => event.date === dateKey),
      };
    });
  });

  afterNavigate(({ to }) => {
    const date = to?.url?.searchParams.get('date');
    if (date && date !== (loading ? requestedReportDate : sourceData?.reportDate)) void loadReport(date);
  });

  onMount(() => {
    if (loadSequence === 0) void loadReport(new URLSearchParams(window.location.search).get("date"));
  });

  async function loadReport(reportDate: string | null = null, month?: string): Promise<void> {
    const sequence = ++loadSequence;
    requestedReportDate = reportDate;
    loading = true;
    errorMessage = "";
    detailDialog?.close();
    selectedInstitutionName = null;
    try {
      const result = await fetchCreditData(reportDate,fetch,month);
      if (sequence !== loadSequence) return;
      sourceData = result;
      if (window.location.pathname.startsWith('/credit-workbench')) {
        const url = new URL(window.location.href);
        url.searchParams.set('date', result.reportDate);
        replaceState(url, {});
      }
      calendarMonth = month ?? result.reportDate.slice(0, 7);
    } catch (error) {
      if (sequence !== loadSequence) return;
      errorMessage = error instanceof Error ? error.message : "授信数据加载失败";
    } finally {
      if (sequence === loadSequence) loading = false;
    }
  }

  function openInstitution(institution: CreditInstitutionView): void {
    selectedInstitutionName = institution.institutionName;
    detailDialog.showModal();
  }

  function toggleSort(key: SortKey): void {
    sorts = cycleCreditSort(sorts, key);
  }

  function sortIndicator(key: SortKey): string {
    if (key === 'institutionType') return sorts.find(sort => sort.key === key)?.direction === 'descending' ? '↓' : '↑';
    const groupSorts = sorts.filter(sort => sort.key !== 'institutionType');
    const index = groupSorts.findIndex(sort => sort.key === key);
    if (index < 0) return '⇅';
    return `${groupSorts[index]?.direction === 'ascending' ? '↑' : '↓'}${index + 1}`;
  }

  function ariaSort(key: SortKey): 'ascending' | 'descending' | 'none' {
    return key === 'institutionType' ? (sorts.find(sort => sort.key === key)?.direction ?? 'ascending') : 'none';
  }

  function sortDescription(key: SortKey): string | undefined {
    if (key === 'institutionType') return `分类${ariaSort(key) === 'descending' ? '降序' : '升序'}`;
    const groupSorts = sorts.filter(sort => sort.key !== 'institutionType');
    const index = groupSorts.findIndex(sort => sort.key === key);
    return index < 0 ? undefined : `组内第${index + 1}排序，${groupSorts[index]?.direction === 'ascending' ? '升序' : '降序'}`;
  }

  function shiftCalendarMonth(offset: number): void {
    const date = new Date(`${calendarMonth}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + offset);
    void loadReport(report?.summary.reportDate ?? null,date.toISOString().slice(0, 7));
  }

  function calendarMonthLabel(month: string): string {
    const [year, monthNumber] = month.split("-");
    return `${year}年${Number(monthNumber)}月`;
  }

  async function exportWeeklyImage(): Promise<void> {
    if (!report || loading || exporting || !weeklyReport) return;
    const reportDate = report.summary.reportDate;
    exporting = true;
    try {
      const { exportReportImage } = await import('../../export');
      await exportReportImage(weeklyReport, reportDate, {
        captureClass: true,
        filename: `资金管理部-授信周报-${reportDate}.png`,
      });
      globalMessages.success('授信周报图片已导出');
    } catch {
      globalMessages.error('图片导出失败，请重试');
    } finally {
      exporting = false;
    }
  }

  function statusLabel(status: CreditEffectiveStatus): string {
    return {
      approved: "已获批",
      applying: "申请中",
      revoked: "已撤销",
    }[status];
  }

  function statusTone(status: CreditEffectiveStatus): "success" | "warning" | "neutral" {
    if (status === "approved") return "success";
    if (status === "applying") return "warning";
    return "neutral";
  }

  function formatAmount(value: number | null | undefined): string {
    return value == null ? "—" : value.toFixed(2);
  }

  function weeklyChange(current: number, previous: number | null | undefined, unit: string, digits = 2) {
    if (previous == null) return { detailPrefix: '较上周', detail: `—${unit}`, detailTone: '' };
    const change = Number((current - previous).toFixed(digits));
    return {
      detailPrefix: '较上周',
      detail: `${change > 0 ? '+' : ''}${change}${unit}`,
      detailTone: change > 0 ? 'tone-withdraw' : change < 0 ? 'tone-inject' : '',
    };
  }

  function weeklyReportChange(current: number, previous: number | null | undefined, unit: string, digits = 2) {
    const change = previous == null ? null : Number((current - previous).toFixed(digits));
    return {
      detail: change == null ? '—' : change === 0 ? '持平' : `${change > 0 ? '+' : ''}${change}${unit}`,
      neutralDetail: true,
    };
  }

  function creditEventLabel(eventType: CreditWeeklyNewsItem["eventType"]): string {
    return {
      new: "新增",
      renewal: "续作",
      increase: "扩额",
      expiry: "到期",
      revocation: "撤销",
      decrease: "缩额",
      amendment: "调整",
    }[eventType];
  }

  function creditEventTone(
    eventType: CreditWeeklyNewsItem["eventType"],
  ): "info" | "success" | "warning" | "neutral" {
    if (eventType === "new") return "success";
    if (eventType === "increase") return "warning";
    if (eventType === "renewal") return "info";
    return "neutral";
  }

  function formatCreditPeriod(event: CreditWeeklyNewsItem): string {
    const start = event.currentEffectiveDate ?? event.previousEffectiveDate ?? "—";
    const end = event.currentExpiryDate ?? event.previousExpiryDate ?? "—";
    return `${start} 至 ${end}`;
  }

  function formatApprovalDetails(event: CreditWeeklyNewsItem): string {
    const details = event.creditDetails.map((item) => {
      const amount = item.limitAmount == null ? "" : `${formatAmount(item.limitAmount)}亿`;
      const note = item.details?.trim() ? `（${item.details.trim()}）` : "";
      return `${creditItemLabels[item.type]}${amount ? ` ${amount}` : ""}${note}`;
    });
    return details.length ? details.join("；") : "—";
  }

  function daysBetween(start: string, end: string): number {
    return Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
        86_400_000,
    );
  }
</script>

<div class="tr-view-stack tr-credit-view">
  <div
    class="tr-credit-toolbar"
    aria-label="授信报表控制"
    use:portal={"#tr-topbar-actions"}
  >
    {#if report}
      <div class="tr-credit-toolbar__actions">
        <CreditReportDatePicker disabled={activeTab === "weekly" && exporting} value={report.summary.reportDate} min={report.availableDates[0]} onchange={date => void loadReport(date)} />
        {#if activeTab === "weekly"}
          <Button data-ui-owner="lib-trading-research-CreditView-svelte" variant="outline" class={"ui-button tr-credit-print"} type="button" onclick={exportWeeklyImage} disabled={loading || exporting} aria-busy={exporting}>{exporting ? '导出中…' : '导出图片'}</Button>
        {/if}
      </div>
    {/if}
    {#if report && (activeTab === "overview" || activeTab === "ledger")}<Button permission="credit.institution:update" data-ui-owner="lib-trading-research-CreditView-svelte" variant="default" class={"ui-button"} type="button" onclick={() => applicationDialog?.open()}>授信申请</Button>{/if}
  </div>

  {#if report && (activeTab === "overview" || activeTab === "ledger")}
    <CreditApplicationDialog bind:this={applicationDialog} institutions={report.institutions} reportDate={report.summary.reportDate} {calendarMonth} firstDate={report.availableDates[0]} previousDate={report.previousDate} contextVersion={loadSequence} onapplied={applyUpdate} />
  {/if}

  <Modal bind:this={detailDialog} aria-label="授信详情" class="credit-detail-dialog" onclose={() => selectedInstitutionName = null}>
    {#if report && selectedInstitution}
      <div class="dialog-body">
        <div class="tr-credit-dialog-head"><h2>授信详情</h2><Button type="button" variant="ghost" aria-label="关闭授信详情" onclick={() => detailDialog.close()}>关闭</Button></div>
        <CreditDetailEditor institution={selectedInstitution} reportDate={report.summary.reportDate} {calendarMonth} firstDate={report.availableDates[0]} previousDate={report.previousDate} contextVersion={loadSequence} onapplied={applyUpdate} />
      </div>
    {/if}
  </Modal>

  {#if loading}
    <section class="tr-empty-panel" aria-live="polite">
      <WorkbenchIcon name="database" />
      <h2>正在读取授信数据</h2>
    </section>
  {:else if errorMessage || !report}
    <section class="tr-empty-panel" role="alert">
      <WorkbenchIcon name="warning" />
      <div><h2>授信数据暂不可用</h2><p>{errorMessage || "暂无授信记录"}</p></div>
      <Button data-ui-owner="lib-trading-research-CreditView-svelte" variant="outline" class={"ui-button tr-credit-retry"} type="button" onclick={() => void loadReport()}>重新加载</Button>
    </section>
  {:else if activeTab === "overview" && overviewTab === "bank-credit"}
    <BankCreditStatus {report} />
  {:else if activeTab === "overview"}
    <section aria-labelledby="credit-metrics-title">
      <SectionHeading id="credit-metrics-title" title="授信总览" />
      <div class="tr-metric-grid tr-metric-grid--five tr-credit-metric-grid">
        <MetricCard label="授信总额" value={report.summary.totalLimit.toFixed(1)} {...weeklyChange(report.summary.totalLimit, report.previousSummary?.totalLimit, '亿元')} iconComponent={WorkbenchIcon} iconProps={{ name: "credit" }} tone="blue" compact smallIcon />
        <MetricCard label="已用额度" value={report.summary.totalUsed.toFixed(1)} {...weeklyChange(report.summary.totalUsed, report.previousSummary?.totalUsed, '亿元')} iconComponent={WorkbenchIcon} iconProps={{ name: "funds" }} tone="orange" compact smallIcon />
        <MetricCard label="可用额度" value={report.summary.totalAvailable.toFixed(1)} {...weeklyChange(report.summary.totalAvailable, report.previousSummary?.totalAvailable, '亿元')} iconComponent={WorkbenchIcon} iconProps={{ name: "check" }} tone="green" compact smallIcon />
        <MetricCard label="30日内到期" value={String(report.summary.expiringWithin30Days)} unit="笔" {...weeklyChange(report.summary.expiringWithin30Days, report.previousSummary?.expiringWithin30Days, '笔', 0)} iconComponent={WorkbenchIcon} iconProps={{ name: "calendar" }} tone="red" compact smallIcon />
        <MetricCard label="额度使用率" value={report.summary.utilization.toFixed(1)} unit="%" {...weeklyChange(report.summary.utilization, report.previousSummary?.utilization, '个百分点', 1)} iconComponent={WorkbenchIcon} iconProps={{ name: "warning" }} tone="purple" compact smallIcon />
      </div>
    </section>

    <div class="tr-credit-chart-grid">
      {#each overviewCharts as chart (chart.id)}
        <ModuleCard labelledBy={`credit-${chart.id}-title`}>
          <PanelHeading id={`credit-${chart.id}-title`} title={chart.title} />
          {#if chart.rows.some(row => row.value != null)}
            <ChartHost renderer={renderCreditOverviewBarChart}
              args={[chart.rows, chart.title, chart.unit]}
              ariaLabel={`${chart.title}图`} className="tr-chart-host tr-credit-overview-chart" />
          {:else}<p class="tr-empty-state">授信数据暂缺</p>{/if}
        </ModuleCard>
      {/each}
    </div>

    <div class="tr-two-column tr-two-column--credit">
      {#each overviewDistributions as chart (chart.id)}
        <ModuleCard labelledBy={`credit-${chart.id}-title`}>
          <PanelHeading id={`credit-${chart.id}-title`} title={chart.title} />
          <ChartHost renderer={chart.renderer} args={[chart.rows, chart.title]}
            ariaLabel={`${chart.title}图`} className="tr-chart-host tr-credit-overview-chart" />
        </ModuleCard>
      {/each}
    </div>

    <div class="tr-two-column tr-two-column--credit">
      <ModuleCard labelledBy="credit-usage-title">
        <PanelHeading id="credit-usage-title" title="授信额度使用率" />
        {#if overview.utilization != null}
          <ChartHost
            renderer={renderCreditOverviewGauge}
            args={[overview.utilization, overview.totalLimit, overview.totalUsed]}
            ariaLabel={`授信额度使用率${overview.utilization.toFixed(1)}%`}
            className="tr-chart-host"
          />
        {:else}
          <p class="tr-empty-state">暂无可展示的已获批授信使用率</p>
        {/if}
      </ModuleCard>

      <ModuleCard labelledBy="credit-alerts-title">
        <PanelHeading id="credit-alerts-title" title="授信预警">
          <Badge tone={creditAlerts.length ? "warning" : "success"}>{creditAlerts.length} 项</Badge>
        </PanelHeading>
        <div class="tr-alert-list tr-credit-alert-list">
          {#each creditAlerts as alert (alert.id)}
            <article class={`tr-alert tr-alert--${alert.level}`}>
              <span class="tr-alert__icon" aria-hidden="true"><WorkbenchIcon name="warning" /></span>
              <div>
                <div class="tr-alert__meta"><strong>{alert.label}</strong><span>{alert.meta}</span></div>
                <p>{alert.text}</p>
              </div>
            </article>
          {:else}
            <p class="tr-empty-state">当前无额度使用率或30日内到期预警</p>
          {/each}
        </div>
      </ModuleCard>
    </div>

  {:else if activeTab === "ledger"}
    <ModuleCard labelledBy="credit-table-title">
      <PanelHeading id="credit-table-title" title="授信一览表" wrap>
        <div class="tr-table-controls" role="search">
          <label class="tr-search-control">
            <span class="sr-only">搜索授信机构</span>
            <WorkbenchIcon name="search" />
            <Input data-ui-owner="lib-trading-research-CreditView-svelte" class={"ui-input"} bind:value={query} type="search" />
          </label>
          <label>
            <span class="sr-only">授信状态</span>
            <NativeSelect data-ui-owner="lib-trading-research-CreditView-svelte" class={"ui-select"} bind:value={statusFilter}>
              <option value="active">未撤销</option>
              <option value="all">全部状态</option>
              <option value="approved">已获批</option>
              <option value="applying">申请中</option>
              <option value="revoked">已撤销</option>
            </NativeSelect>
          </label>
          <label>
            <span class="sr-only">授信风险</span>
            <NativeSelect data-ui-owner="lib-trading-research-CreditView-svelte" class={"ui-select"} bind:value={riskFilter}>
              <option value="all">全部风险</option>
              <option value="attention">使用率60%及以上</option>
              <option value="warning">使用率80%及以上</option>
              <option value="expiry">近30日到期</option>
            </NativeSelect>
          </label>
        </div>
        <div class="tr-table-controls" role="group" aria-label="一览表操作">
          <Button data-ui-owner="lib-trading-research-CreditView-svelte" variant="outline" onclick={() => sorts = []} disabled={!sorts.length}>清除排序</Button>
          <Button data-ui-owner="lib-trading-research-CreditView-svelte" variant="outline" onclick={() => sorts = [...defaultCreditSort]}>默认排序</Button>
          <Button data-ui-owner="lib-trading-research-CreditView-svelte" variant="outline" onclick={exportExcel} disabled={loading || exporting} aria-busy={exporting}>{exporting ? '导出中…' : '导出Excel'}</Button>
        </div>
      </PanelHeading>
      <div class="tr-table-scroll" role="region" aria-label="授信机构记录" use:scrollableRegion>
        <table class="tr-data-table tr-credit-table">
          <caption class="sr-only">授信一览表</caption>
          <thead>
            <tr>
              <th aria-sort={ariaSort("institutionType")}><Button data-ui-owner="lib-trading-research-CreditView-svelte" variant="ghost" class={"ui-button tr-sort-button"} type="button" onclick={() => toggleSort("institutionType")}>机构性质<span aria-hidden="true">{sortIndicator("institutionType")}</span><span class="sr-only">{sortDescription("institutionType") ?? "未排序"}</span></Button></th>
              <th aria-sort={ariaSort("institutionName")}><Button data-ui-owner="lib-trading-research-CreditView-svelte" variant="ghost" class={"ui-button tr-sort-button"} type="button" onclick={() => toggleSort("institutionName")}>授信主体<span aria-hidden="true">{sortIndicator("institutionName")}</span><span class="sr-only">{sortDescription("institutionName") ?? "未排序"}</span></Button></th>

              <th aria-sort={ariaSort("status")}><Button data-ui-owner="lib-trading-research-CreditView-svelte" variant="ghost" class={"ui-button tr-sort-button"} type="button" onclick={() => toggleSort("status")}>状态<span aria-hidden="true">{sortIndicator("status")}</span><span class="sr-only">{sortDescription("status") ?? "未排序"}</span></Button></th>
              <th class="is-numeric" aria-sort={ariaSort("totalLimit")}><Button data-ui-owner="lib-trading-research-CreditView-svelte" variant="ghost" class={"ui-button tr-sort-button tr-sort-button--numeric"} type="button" onclick={() => toggleSort("totalLimit")}>总额度<span aria-hidden="true">{sortIndicator("totalLimit")}</span><span class="sr-only">{sortDescription("totalLimit") ?? "未排序"}</span></Button></th>
              <th class="is-numeric" aria-sort={ariaSort("totalUsed")}><Button data-ui-owner="lib-trading-research-CreditView-svelte" variant="ghost" class={"ui-button tr-sort-button tr-sort-button--numeric"} type="button" onclick={() => toggleSort("totalUsed")}>已使用<span aria-hidden="true">{sortIndicator("totalUsed")}</span><span class="sr-only">{sortDescription("totalUsed") ?? "未排序"}</span></Button></th>
              <th class="is-numeric" aria-sort={ariaSort("availableAmount")}><Button data-ui-owner="lib-trading-research-CreditView-svelte" variant="ghost" class={"ui-button tr-sort-button tr-sort-button--numeric"} type="button" onclick={() => toggleSort("availableAmount")}>可用<span aria-hidden="true">{sortIndicator("availableAmount")}</span><span class="sr-only">{sortDescription("availableAmount") ?? "未排序"}</span></Button></th>
              <th class="is-numeric" aria-sort={ariaSort("utilization")}><Button data-ui-owner="lib-trading-research-CreditView-svelte" variant="ghost" class={"ui-button tr-sort-button tr-sort-button--numeric"} type="button" onclick={() => toggleSort("utilization")}>使用率<span aria-hidden="true">{sortIndicator("utilization")}</span><span class="sr-only">{sortDescription("utilization") ?? "未排序"}</span></Button></th>
              <th aria-sort={ariaSort("effectiveDate")}><Button data-ui-owner="lib-trading-research-CreditView-svelte" variant="ghost" class={"ui-button tr-sort-button"} type="button" onclick={() => toggleSort("effectiveDate")}>生效日<span aria-hidden="true">{sortIndicator("effectiveDate")}</span><span class="sr-only">{sortDescription("effectiveDate") ?? "未排序"}</span></Button></th>
              <th aria-sort={ariaSort("expiryDate")}><Button data-ui-owner="lib-trading-research-CreditView-svelte" variant="ghost" class={"ui-button tr-sort-button"} type="button" onclick={() => toggleSort("expiryDate")}>到期日<span aria-hidden="true">{sortIndicator("expiryDate")}</span><span class="sr-only">{sortDescription("expiryDate") ?? "未排序"}</span></Button></th>
            </tr>
          </thead>
          {#each ledgerGroups as group (group.institutionType)}
          <tbody>
            {#each group.institutions as institution, index (institution.institutionName)}
              <tr class={`tr-credit-institution-row tr-credit-category--${creditCategoryTone(group.institutionType)}`} tabindex="0" aria-label={`${institution.institutionName}授信详情`}
                onclick={event => { if (!(event.target as Element).closest('th[scope="rowgroup"]')) openInstitution(institution); }}
                onkeydown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openInstitution(institution); } }}>
                {#if index === 0}<th class="tr-credit-category" rowspan={group.institutions.length} scope="rowgroup">{group.institutionType}</th>{/if}
                <th scope="row"><span class="tr-credit-bank-event">{institution.institutionName}{#if isCreditFinalized(institution, report.summary.reportDate)}<Badge tone="success">定稿</Badge>{/if}</span></th>
                <td><Badge tone={statusTone(institution.status)}>{statusLabel(institution.status)}</Badge></td>
                <td class="is-numeric">{formatAmount(institution.totalLimit)}</td>
                <td class="is-numeric">{formatAmount(institution.totalUsed)}</td>
                <td class="is-numeric">{formatAmount(institution.availableAmount)}</td>
                <td class="is-numeric">{institution.utilization == null ? "—" : `${institution.utilization.toFixed(1)}%`}</td>
                <td>{institution.effectiveDate ?? "—"}</td>
                <td>{institution.expiryDate ?? "—"}</td>
              </tr>
            {/each}
          </tbody>
          {:else}
            <tbody><tr><td class="tr-empty-cell" colspan="9">没有符合当前筛选条件的授信记录</td></tr></tbody>
          {/each}
        </table>
      </div>
    </ModuleCard>
  {:else if activeTab === "calendar"}
    <section aria-labelledby="credit-calendar-title">
      <SectionHeading id="credit-calendar-title" title="授信日历" />
      <ModuleCard class="tr-credit-calendar-panel" labelledBy="credit-calendar-title">
        <div class="tr-credit-calendar-toolbar">
          <div class="tr-credit-calendar-filter" role="group" aria-label="授信日历筛选">
            <MultiSelectFilter label="额度" options={Object.keys(creditLimitFilterLabels)} optionLabels={creditLimitFilterLabels} bind:values={calendarLimitFilters} />
            <MultiSelectFilter label="已用" options={[...creditItemTypes]} optionLabels={creditItemLabels} bind:values={calendarUsageFilters} />
          </div>
          <div class="tr-credit-calendar-nav">
            <Button data-ui-owner="lib-trading-research-CreditView-svelte" variant="outline" class={"ui-button"} type="button" aria-label="上一个月" onclick={() => shiftCalendarMonth(-1)}>‹</Button>
            <strong>{calendarMonthLabel(calendarMonth)}</strong>
            <Button data-ui-owner="lib-trading-research-CreditView-svelte" variant="outline" class={"ui-button"} type="button" aria-label="下一个月" onclick={() => shiftCalendarMonth(1)}>›</Button>
          </div>
        </div>
        <div class="tr-credit-calendar-scroll" role="region" aria-label="授信日历，左右滚动查看完整日期" use:scrollableRegion>
        <div class="tr-credit-calendar" role="grid" aria-label={`${calendarMonthLabel(calendarMonth)}授信事件`}>
          {#each weekdays as weekday}<div class="tr-credit-calendar-weekday" role="columnheader">{weekday}</div>{/each}
          {#each calendarCells as cell (cell.date)}
            <div class:outside={cell.outside} class:report-date={cell.reportDate} class="tr-credit-calendar-cell" role="gridcell" aria-label={cell.date}>
              <time datetime={cell.date}>{cell.day}</time>
              <div class="tr-credit-calendar-events">
                {#each cell.events as event (event.id)}
                  <article class={`tr-credit-calendar-event tr-credit-calendar-event--${event.type} tr-credit-calendar-event--${event.status}`} title={`${event.institutionName} · ${event.label} · ${event.statusLabel}`} aria-label={`${event.institutionName} · ${event.label} · ${event.statusLabel}`}>
                    <strong>{event.institutionName}</strong>
                    <span>{event.label}</span>
                  </article>
                {/each}
              </div>
            </div>
          {/each}
        </div>
        </div>
      </ModuleCard>
    </section>
  {:else}
    <div bind:this={weeklyReport} class="tr-credit-weekly-report layout-report layout-report--credit">
      <section aria-labelledby="credit-weekly-title">
        <SectionHeading id="credit-weekly-title" title="授信周报" />
        <p class="tr-credit-export-date">{report.summary.reportDate}</p>
        <div class="tr-metric-grid tr-metric-grid--five">
          <MetricCard label="授信总额" value={formatAmount(report.weeklySummary.totalLimit)} {...weeklyReportChange(report.weeklySummary.totalLimit, report.previousWeeklySummary?.totalLimit, '亿元')} iconComponent={WorkbenchIcon} iconProps={{ name: "credit" }} tone="blue" compact smallIcon />
          <MetricCard label="已用额度" value={formatAmount(report.weeklySummary.totalUsed)} {...weeklyReportChange(report.weeklySummary.totalUsed, report.previousWeeklySummary?.totalUsed, '亿元')} iconComponent={WorkbenchIcon} iconProps={{ name: "funds" }} tone="orange" compact smallIcon />
          <MetricCard label="可用额度" value={formatAmount(report.weeklySummary.totalAvailable)} {...weeklyReportChange(report.weeklySummary.totalAvailable, report.previousWeeklySummary?.totalAvailable, '亿元')} iconComponent={WorkbenchIcon} iconProps={{ name: "check" }} tone="green" compact smallIcon />
          <MetricCard label="新增授信" value={String(report.weeklySummary.addedInstitutionCount)} unit="家" {...weeklyReportChange(report.weeklySummary.addedInstitutionCount, report.previousWeeklySummary?.addedInstitutionCount, '家', 0)} iconComponent={WorkbenchIcon} iconProps={{ name: "calendar" }} tone="purple" compact smallIcon />
          <MetricCard label="到期" value={String(report.weeklySummary.expiredInstitutionCount)} unit="家" {...weeklyReportChange(report.weeklySummary.expiredInstitutionCount, report.previousWeeklySummary?.expiredInstitutionCount, '家', 0)} iconComponent={WorkbenchIcon} iconProps={{ name: "warning" }} tone="red" compact smallIcon />
        </div>
      </section>

      <ModuleCard labelledBy="credit-news-title">
        <PanelHeading id="credit-news-title" title="本周授信快讯" />
        {#if weeklyNews.length === 0}
          <p class="tr-credit-news-empty">本周暂无</p>
        {:else}
          <ol class="tr-credit-news-list">{#each weeklyNews as news}<li>{news}</li>{/each}</ol>
        {/if}
      </ModuleCard>

      <ModuleCard labelledBy="credit-recent-approvals-title">
        <PanelHeading id="credit-recent-approvals-title" title="近期新增授信批复" />
        <div class="tr-table-scroll">
          <table class="tr-data-table tr-credit-approval-table">
            <caption class="sr-only">所选报表日前近6个月新增、续作和扩额授信批复</caption>
            <thead><tr><th>银行名称</th><th>起始到期日</th><th class="is-numeric">授信额度（亿）</th><th>授信明细</th></tr></thead>
            <tbody>
              {#each report.recentApprovals as approval (`${approval.reportDate}:${approval.institutionName}`)}
                <tr>
                  <th scope="row"><span class="tr-credit-bank-event"><span>{approval.institutionName}</span><Badge tone={creditEventTone(approval.eventType)}>{creditEventLabel(approval.eventType)}</Badge></span></th>
                  <td>{formatCreditPeriod(approval)}</td>
                  <td class="is-numeric">{formatAmount(approval.currentAmount)}</td>
                  <td class="tr-credit-approval-details">{formatApprovalDetails(approval)}</td>
                </tr>
              {:else}
                <tr><td class="tr-empty-cell" colspan="4">近6个月无新增、续作或扩额授信批复</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      </ModuleCard>

      <ModuleCard labelledBy="credit-detail-title">
        <PanelHeading id="credit-detail-title" title="授信明细" />
        <div class="tr-table-scroll">
          <table class="tr-data-table tr-credit-weekly-detail-table">
            <caption class="sr-only">授信额度明细</caption>
            <thead>
              <tr><th rowspan="2">银行性质</th><th rowspan="2">银行名称</th><th colspan="3" class="is-centered">授信额度</th></tr>
              <tr><th class="is-numeric">总额度（亿）</th><th class="is-numeric">可用额度（亿）</th><th class="is-numeric">使用率</th></tr>
            </thead>
            <tbody>
              {#each weeklyCreditDetailGroups as group (group.institutionType)}
                {#each group.institutions as institution, index (institution.institutionName)}
                  <tr>
                    {#if index === 0}<th rowspan={group.institutions.length} scope="rowgroup">{group.institutionType}</th>{/if}
                    <th scope="row">{institution.institutionName}</th>
                    <td class="is-numeric">{formatAmount(institution.totalLimit)}</td>
                    <td class="is-numeric">{formatAmount(institution.availableAmount)}</td>
                    <td class="is-numeric">{institution.utilization == null ? "—" : `${institution.utilization.toFixed(1)}%`}</td>
                  </tr>
                {/each}
              {:else}
                <tr><td class="tr-empty-cell" colspan="5">暂无已获批的周报授信明细</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      </ModuleCard>
    </div>
  {/if}
</div>
