<script lang="ts">

  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import PageHeader from '$lib/workbench/PageHeader.svelte';
  import { onDestroy, onMount, tick } from "svelte";

  import { fetchReport, generateMarketBriefing, saveMarketReport } from "./api";
  import { permissionVisibility } from "$lib/permission-visibility";
  import FocusEditor from "./components/FocusEditor.svelte";
  import ChartHost from "./components/ChartHost.svelte";
  import CoreMetrics from "./components/CoreMetrics.svelte";
  import EquityStats from "./components/EquityStats.svelte";
  import EquityValues from "./components/EquityValues.svelte";
  import FundMetrics from "./components/FundMetrics.svelte";
  import PrimaryTable from "./components/PrimaryTable.svelte";
  import SecondaryTable from "./components/SecondaryTable.svelte";
  import SummaryStrip from "./components/SummaryStrip.svelte";
  import { plainTextToFocusHtml } from "./focus-editor";
  import TextReport from "./components/TextReport.svelte";
  import { exportReportImage } from "./export";
  import { chineseDateParts } from "./formatters";
  import { globalMessages } from "./lib/global-messages";
  import { isAiRequestCancelled, useAiClient } from "./lib/ai-client.svelte";
  import { deriveReport, type ReportDerived } from "./report-view";
  import {
    pathnameForReportView,
    reportViewFromPathname,
    type ReportView,
  } from "./report-route";
  import type {
    MarketBriefing,
    MarketReportResource,
    MarketReportResourceIssue,
    MarketReportSnapshot,
  } from "./types";
  import {
    comparableSummaryItems,
    comparableTenorRows,
    inventorySummaryItems,
    omoSummaryItems,
    primarySummaryItems,
  } from "./view-model";

  type ChartRenderers = typeof import("./charts");
  const EMPTY_DERIVED: ReportDerived = {
    omoHistory: [],
    funds: [],
    governmentBonds: [],
    margin: {
      data_date: null,
      total: null,
      total_change: null,
      financing: null,
      financing_change: null,
      securities_lending: null,
      securities_lending_change: null,
    },
    primary: [],
    comparable: [],
    inventory: [],
  };
  let reportSurface = $state<HTMLElement>(null!);
  const aiClient = useAiClient();
  let dateInput = $state<HTMLInputElement>(null!);
  let selectedDate = $state("");
  let data = $state<MarketReportSnapshot | null>(null);
  let charts = $state<ChartRenderers | null>(null);
  let loading = $state(true);
  let errorMessage = $state("");
  let exporting = $state(false);
  let exportLabel = $state("导出图片");
  let activeRequest: AbortController | null = null;
  let activeView: ReportView = $state("visual");
  const allowed = permissionVisibility();
  let focusText = $state("");
  let generating = $state(false);
  let generatedBriefing = $state<MarketBriefing | null>(null);
  let briefingRequest: AbortController | null = null;
  let resourceIssues = $state<MarketReportResourceIssue[]>([]);

  let reportDerived = $derived(data ? deriveReport(data) : EMPTY_DERIVED);
  let missingResources = $derived(resourceIssues.map((issue) => issue.resource));
  let dateParts = $derived(data
    ? chineseDateParts(data.report_date)
    : { date: "—", weekday: "—" });
  $effect(() => {
    if (data) {
      document.title = `${data.report_date} · 资金管理部 • 市场点评`;
    }
  });

  onMount(async () => {
    activeView = reportViewFromPathname(window.location.pathname);
    try {
      selectedDate = new URLSearchParams(window.location.search).get("date") ?? "";
      await loadReport(false);
    } catch (error) {
      showError(error);
    }
  });

  onDestroy(() => {
    activeRequest?.abort();
    briefingRequest?.abort();
  });

  async function loadReport(refresh: boolean): Promise<void> {
    if (exporting || generating) return;
    generatedBriefing = null;
    activeRequest?.abort();
    const request = new AbortController();
    activeRequest = request;
    const requestedDate = selectedDate;
    loading = true;
    data = null;
    errorMessage = "";
    resourceIssues = [];
    try {
      const [loaded, chartModule] = await Promise.all([
        fetchReport(requestedDate, refresh, request.signal),
        import("./charts"),
      ]);
      if (request.signal.aborted || selectedDate !== requestedDate) return;
      const report = loaded.report;
      data = report;
      selectedDate = report.report_date;
      resourceIssues = loaded.resourceIssues;
      focusText = report.focus_text;
      charts = chartModule;
      loading = false;
      if (resourceIssues.length) {
        globalMessages.warning(
          `部分数据暂缺：${resourceIssues.map((issue) => issue.label).join("、")}`,
          { key: "market-report-partial-data", duration: 8000 },
        );
      }
    } catch (error) {
      if (activeRequest === request && !request.signal.aborted) {
        showError(error);
      }
    }
  }

  function hasResourceIssue(...resources: MarketReportResource[]): boolean {
    return resources.some((resource) =>
      resourceIssues.some((issue) => issue.resource === resource)
    );
  }

  function openDatePicker(): void {
    try {
      dateInput.showPicker?.();
    } catch {
      // The native input click remains available where showPicker is unsupported.
    }
  }

  async function generateFocus(): Promise<void> {
    if (!data || generating || exporting) return;
    const reportDate = data.report_date;
    const request = new AbortController();
    briefingRequest?.abort();
    briefingRequest = request;
    generatedBriefing = null;
    generating = true;
    try {
      const result = await generateMarketBriefing(aiClient, reportDate, request.signal);
      if (request.signal.aborted || data?.report_date !== reportDate) return;
      generatedBriefing = result;
      focusText = `1、${result.stock}\n2、${result.bond}`;
    } catch (error) {
      if (!request.signal.aborted && !isAiRequestCancelled(error)) globalMessages.error(
        `今日聚焦生成失败：${error instanceof Error ? error.message : String(error)}`,
        { key: "market-focus-generate" },
      );
    } finally {
      if (briefingRequest === request) generating = false;
    }
  }

  async function exportImage(): Promise<void> {
    if (!data || exporting || generating) return;
    exporting = true;
    exportLabel = "正在导出";
    const report = $state.snapshot(data);
    const focus = focusText;
    const canSave = $allowed("research.market_report:update");
    try {
      await tick();
      const [image, archive] = await Promise.allSettled([
        exportReportImage(reportSurface, report.report_date, { captureClass: true }),
        canSave ? saveMarketReport(report, focus) : Promise.resolve(null),
      ]);
      if (archive.status === "fulfilled" && archive.value && data?.report_date === report.report_date) {
        data = archive.value;
      }
      if (image.status === "fulfilled" && archive.status === "fulfilled") {
        globalMessages.success(`${report.report_date} 图片已导出${canSave ? "，报告已保存" : ""}`, { key: "market-report-export" });
      } else {
        const messages = [
          image.status === "fulfilled" ? "图片已导出" : `图片导出失败：${String(image.reason)}`,
          ...(canSave ? [archive.status === "fulfilled" ? "报告已保存" : `报告保存失败：${String(archive.reason)}`] : []),
        ];
        globalMessages.error(messages.join("；"), { key: "market-report-export" });
      }
    } finally {
      exporting = false;
      exportLabel = "导出图片";
    }
  }

  function showError(error: unknown): void {
    loading = false;
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  function selectView(view: ReportView): void {
    activeView = view;
    const pathname = pathnameForReportView(view);
    if (window.location.pathname !== pathname) {
      window.history.pushState(null, "", `${pathname}${selectedDate ? `?date=${selectedDate}` : ""}`);
    }
  }

  function handlePopState(): void {
    activeView = reportViewFromPathname(window.location.pathname);
  }
</script>

<svelte:window onpopstate={handlePopState} />

<svelte:head>
  <meta name="theme-color" content="#f6f8fb" />
</svelte:head>

<div class="page-shell">
  <main bind:this={reportSurface} id="report-surface">
    <PageHeader section={{ label: '市场点评', href: '/market-briefing' }}
      tabs={[
        { id: 'visual', label: '可视化', href: `/market-briefing${selectedDate ? `?date=${selectedDate}` : ''}` },
        { id: 'text', label: '文字版', href: `/market-briefing/text${selectedDate ? `?date=${selectedDate}` : ''}` },
      ]} activeTabId={activeView} tabsDisabled={exporting || generating} onTabNavigate={(tab) => selectView(tab.id as ReportView)}>
      {#snippet actions()}
        <div class="masthead-controls" aria-label="报告控制">
          <div class="titlebar-actions">
          <Button data-ui-owner="App-svelte" variant="outline"

            class={["ui-button refresh-button", loading && "is-loading"]}
            type="button"
            disabled={loading || exporting || generating}
            onclick={() => loadReport(true)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M16.4 6.1A7 7 0 1 0 17 11" />
              <path d="M16.5 2.7v4h-4" />
            </svg>
            <span>刷新</span>
          </Button>
          <Button data-ui-owner="App-svelte" variant="default"

            class={["ui-button  export-button", exporting && "is-exporting"]}
            type="button"
            disabled={!data || loading || exporting || generating}
            onclick={exportImage}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 3v9" />
              <path d="m6.5 8.7 3.5 3.6 3.5-3.6" />
              <path d="M4 14.5v2h12v-2" />
            </svg>
            <span>{exportLabel}</span>
          </Button>
        </div>
        <label class="hero-date">
          <span class="sr-only">选择报告日期</span>
          <Input data-ui-owner="App-svelte"
            bind:ref={dateInput}
            class={"ui-input hero-date__input"}
            type="date"
            aria-label="选择报告日期"
            disabled={exporting || generating}
            bind:value={selectedDate}
            onclick={openDatePicker}
            onchange={() => loadReport(false)}
          />
          <time
            class="hero-date__display"
            datetime={data?.report_date ?? ""}
            aria-hidden="true"
          >
            <span class="hero-date__value">{dateParts.date}</span>
            <span class="hero-date__weekday">{dateParts.weekday}</span>
          </time>
        </label>
      </div>
      {/snippet}
    </PageHeader>
    <div class="report-export-heading"><strong>资金管理部 · 市场点评</strong><time datetime={data?.report_date}>{dateParts.date} {dateParts.weekday}</time></div>

    {#if loading}
      <div class="loading-state" role="status" aria-live="polite">
        <span class="loading-orbit" aria-hidden="true"></span>
        <div>
          <strong>正在加载市场点评</strong>
        </div>
      </div>
    {:else if errorMessage}
      <div class="error-state" role="alert">
        <span class="error-index">!</span>
        <div>
          <strong>报告暂时无法加载</strong>
          <p>{errorMessage}</p>
        </div>
        <Button data-ui-owner="App-svelte" variant="outline" size="sm"
          class={"ui-button "}
          type="button"
          onclick={() => loadReport(true)}>重新尝试</Button
        >
      </div>
    {:else if data && charts}
      {#if activeView === "visual"}
        <div
          id="visual-report-panel"
          class="visual-report-view"
          role="region"
          aria-label="可视化"
        >
          <div class="core-metrics" aria-label="核心市场指标">
            <CoreMetrics {data} {reportDerived} {missingResources} />
          </div>
          <div class="report-content">
        <section class="dashboard-panel panel--focus" aria-labelledby="focus-title">
          <header class="panel-heading">
            <span class="panel-index">01</span>
            <h2 id="focus-title">今日聚焦</h2>
            <Button permission="research.market_report:generate" variant="default" size="icon"
              class={["focus-generate-button ai-generate-button", generating && "is-loading"]}
              aria-label={generating ? "AI 生成中" : "重新生成今日聚焦"} aria-busy={generating}
              disabled={generating || exporting} onclick={generateFocus}>
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="m10 2 1.1 4.2L15 8l-3.9 1.8L10 14l-1.1-4.2L5 8l3.9-1.8L10 2Z" />
                <path d="m16 13 .6 2.1 1.9.9-1.9.9L16 19l-.6-2.1-1.9-.9 1.9-.9L16 13Z" />
              </svg>
            </Button>
          </header>
          {#if $allowed("research.market_report:update") || $allowed("research.market_report:generate")}
            <FocusEditor reportDate={data.report_date} initialText={focusText}
              finalizedAt={data.finalized_at ?? data.generated_at} {generating} {generatedBriefing}
              disabled={exporting || !$allowed("research.market_report:update")}
              onTextChange={(value) => focusText = value} onBriefingApplied={() => generatedBriefing = null} />
          {:else}
            <div class="focus-editor" aria-label="今日聚焦">{@html plainTextToFocusHtml(focusText)}</div>
          {/if}
        </section>

        <section class="dashboard-panel panel--omo" aria-labelledby="omo-title">
          <header class="panel-heading">
            <span class="panel-index">02</span>
            <h2 id="omo-title">公开市场操作</h2>
          </header>
          {#if hasResourceIssue("omo")}
            <div class="module-data-missing" role="status">公开市场操作数据缺失</div>
          {:else}
            <ChartHost
              id="omo-chart"
              renderer={charts.renderOmo}
              args={[reportDerived.omoHistory]}
              ariaLabel="近十个操作日公开市场操作柱状图"
            />
            <div class="summary-strip" aria-label="公开市场操作汇总">
              <SummaryStrip
                items={omoSummaryItems(reportDerived.omoHistory, data.report_date)}
              />
            </div>
          {/if}
        </section>

        <section class="dashboard-panel panel--rates" aria-labelledby="rates-title">
          <header class="panel-heading">
            <span class="panel-index">03</span>
            <h2 id="rates-title">固收市场</h2>
          </header>
          {#if hasResourceIssue("fundingDr", "fundingDibo", "governmentBonds", "futures")}
            <div class="module-data-warning" role="status">
              {#if hasResourceIssue("fundingDr", "fundingDibo")}
                <span>资金利率数据缺失</span>
              {/if}
              {#if hasResourceIssue("governmentBonds")}
                <span>利率债成交数据缺失</span>
              {/if}
              {#if hasResourceIssue("futures")}
                <span>国债期货数据缺失</span>
              {/if}
            </div>
          {/if}
          <div class="indicator-grid">
            <FundMetrics metrics={reportDerived.funds} />
          </div>
          {#if !hasResourceIssue("governmentBonds")}
            <ChartHost
              id="government-chart"
              renderer={charts.renderGovernmentCurve}
              args={[reportDerived.governmentBonds]}
              ariaLabel="关键期限国债收益率曲线"
            />
          {/if}
        </section>

        <section class="dashboard-panel panel--equity" aria-labelledby="equity-title">
          <header class="panel-heading">
            <span class="panel-index">04</span>
            <h2 id="equity-title">权益市场</h2>
          </header>
          {#if hasResourceIssue("industry", "margin", "stock")}
            <div class="module-data-warning" role="status">
              {#if hasResourceIssue("industry")}
                <span>权益及行业行情数据缺失</span>
              {/if}
              {#if hasResourceIssue("margin")}
                <span>融资融券数据缺失</span>
              {/if}
              {#if hasResourceIssue("stock")}
                <span>A股收评数据缺失</span>
              {/if}
            </div>
          {/if}
          <div class="equity-stage">
            <div class="equity-dial-stage">
              <ChartHost
                id="equity-chart"
                renderer={charts.renderEquityGauges}
                args={[data.equities]}
                ariaLabel="A股四个主要指数收盘仪表盘"
              />
              <ChartHost
                id="equity-chart-mobile"
                renderer={charts.renderEquityGaugesMobile}
                args={[data.equities]}
                ariaLabel="A股四个主要指数收盘仪表盘"
              />
              <div class="equity-values" aria-label="A股指数点数与涨跌幅">
                <EquityValues points={data.equities} />
              </div>
            </div>
            <div class="stat-grid">
              <EquityStats {data} margin={reportDerived.margin} />
            </div>
            <div class="equity-heatmap-stage">
              <span class="equity-heatmap-label">申万一级行业</span>
              <ChartHost
                id="industry-chart"
                renderer={charts.renderIndustryTreemap}
                args={[data.industries]}
                className="chart-host chart-host--heatmap"
                ariaLabel="申万一级行业涨跌与总市值矩形树图"
              />
            </div>
          </div>
        </section>

        <section class="dashboard-panel panel--primary" aria-labelledby="primary-title">
          <header class="panel-heading">
            <span class="panel-index">05</span>
            <h2 id="primary-title">一级发行</h2>
          </header>
          {#if hasResourceIssue("primary")}
            <div class="module-data-missing" role="status">一级发行数据缺失</div>
          {:else}
            <div class="data-list" aria-label="一级发行列表">
              <PrimaryTable points={reportDerived.primary} />
            </div>
            <div class="summary-strip" aria-label="一级发行汇总">
              <SummaryStrip items={primarySummaryItems(data.primary_summary)} />
            </div>
          {/if}
        </section>

        <section
          class="dashboard-panel panel--comparable"
          aria-labelledby="comparable-title"
        >
          <header class="panel-heading">
            <span class="panel-index">06</span>
            <h2 id="comparable-title">二级行情</h2>
          </header>
          {#if hasResourceIssue("todayTrades", "bondInfos")}
            <div class="module-data-missing" role="status">可比债成交数据缺失</div>
          {:else}
            <div
              class="data-list"
              aria-label="1年、2年、3年和5年可比证券公司债列表"
            >
              <SecondaryTable
                headers={["期限", "债券", "发行人", "成交"]}
                rows={comparableTenorRows(reportDerived.comparable)}
                emptyText="今日暂无公募债成交"
              />
            </div>
            <div class="summary-strip" aria-label="二级行情汇总">
              <SummaryStrip items={comparableSummaryItems(reportDerived.comparable)} />
            </div>
          {/if}
        </section>

        <section
          class="dashboard-panel panel--inventory"
          aria-labelledby="inventory-title"
        >
          <header class="panel-heading">
            <span class="panel-index">07</span>
            <h2 id="inventory-title">东财债券</h2>
          </header>
          {#if hasResourceIssue("favoriteQuotes", "bondInfos")}
            <div class="module-data-missing" role="status">东财债券数据缺失</div>
          {:else}
            <ChartHost
              id="inventory-chart"
              renderer={charts.renderInventory}
              args={[reportDerived.inventory]}
              ariaLabel="东财存量债估值期限结构"
            />
            <div class="summary-strip" aria-label="东财债券汇总">
              <SummaryStrip items={inventorySummaryItems(reportDerived.inventory)} />
            </div>
          {/if}
        </section>
          </div>
        </div>
      {:else}
        <div
          id="text-report-panel"
          class="text-report-view"
          role="region"
          aria-label="文字版"
        >
          <TextReport data={data} {focusText} {missingResources} readonly />
        </div>
      {/if}
    {/if}
  </main>
</div>

<style>
  #report-surface { grid-template-rows: auto minmax(0, 1fr); }
  .report-export-heading { display: none; }
  :global(.is-export-capture) .report-export-heading { display: flex; align-items: center; justify-content: space-between; min-height: 44px; font-size: 1.5rem; }
  .page-shell :global(.page-header__meta .titlebar-actions) { display: flex; width: auto; }
  .page-shell :global(.page-header) { padding-inline: 2px; flex: 0 0 auto; }
  .page-shell :global(.page-header__meta .masthead-controls) { flex-wrap: wrap; justify-content: flex-end; margin: 0; }
  :global(.is-export-capture .page-header) { display: none; }
</style>
