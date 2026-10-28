<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { onMount } from "svelte";

  import "../../bond-ledger.css";

  import {
    renderBondScaleReturnTrend,
    renderHoldingDistribution,
    renderMaturityDistribution,
  } from "../../charts/bond-ledger";
  import ChartHost from "../../components/ChartHost.svelte";
  import MetricCard from "../../components/MetricCard.svelte";
  import MetricIcon from "../../components/MetricIcon.svelte";
  import ModuleCard from "../../components/ModuleCard.svelte";
  import { exportReportImage } from "../../export";
  import {
    emptyBondLedgerReport,
    previousBusinessWeekRange,
    weekRange,
  } from "$lib/bond-ledger/analytics";
  import {
    calendarDays,
    calendarDaysWithLedgerStatus,
    monthLabel,
    monthStart,
    resolveAvailableRange,
    shiftMonth,
  } from "$lib/bond-ledger/calendar";
  import {
    formatDecimalPercent,
    formatMultiple,
    formatSignedWan,
    formatYears,
    formatYi,
  } from "$lib/bond-ledger/format";
  import type {
    BondLedgerReport,
    LedgerTrendAccount,
  } from "$lib/bond-ledger/types";
  import {
    archiveBondLedgerFile,
    deleteRemoteBondLedger,
    downloadRemoteBondLedger,
    listRemoteBondLedgers,
    loadBondLedgerReport,
    type RemoteBondLedgerFile,
  } from "$lib/bond-ledger/upload";
  import { currentReportDate } from "../../report-date";
  import { globalMessages } from "$lib/global-messages";
  import { portal } from "$lib/portal";
  import type { MetricIconName } from "../../view-model";
  import PanelHeading from "$lib/trading-research/PanelHeading.svelte";
  interface Props {
    embedded?: boolean;
  }

  let { embedded = false }: Props = $props();

  const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
  const INITIAL_REPORT_DATE = currentReportDate();
  const INITIAL_WEEK_RANGE = weekRange(INITIAL_REPORT_DATE);
  const METRIC_TONES = [
    "blue",
    "teal",
    "purple",
    "orange",
    "red",
    "cyan",
  ] as const;
  const TREND_ACCOUNT_OPTIONS: Array<{
    value: LedgerTrendAccount;
    label: string;
  }> = [
    { value: "all", label: "全部" },
    { value: "trading", label: "交易户" },
    { value: "available", label: "可供户" },
  ];

  let analytics: BondLedgerReport = $state(emptyBondLedgerReport());
  let remoteFiles = $state<RemoteBondLedgerFile[]>([]);
  let databaseLedgerDates = $state<string[]>([]);
  let startDate = $state(INITIAL_WEEK_RANGE.startDate);
  let endDate = $state(INITIAL_WEEK_RANGE.endDate);
  let loadingRecords = $state(true);
  let uploading = $state(false);
  let deleting = $state(false);
  let rangeOpen = $state(false);
  let rangePhase: "start" | "end" = $state("start");
  let rangeMonthLeft = $state(monthStart(INITIAL_WEEK_RANGE.startDate));
  let managementMonth = $state(monthStart(INITIAL_REPORT_DATE));
  let selectedManagedDate = $state("");
  let reuploadTarget = "";
  let exporting = $state(false);
  let exportLabel = $state("导出图片");
  let exportTimer: number | null = null;
  let syncGeneration = 0;
  let trendAccount: LedgerTrendAccount = $state("all");
  let batchInput = $state<HTMLInputElement>(null!);
  let reuploadInput = $state<HTMLInputElement>(null!);
  let managementDialog = $state<Modal>(null!);
  let reportSurface = $state<HTMLElement>(null!);


  onMount(() => {
    void refreshReport(true);
    return () => {
      if (exportTimer !== null) window.clearTimeout(exportTimer);
    };
  });

  async function refreshReport(allowFallback: boolean): Promise<void> {
    const generation = ++syncGeneration;
    const syncMessageId = loadingRecords
      ? ""
      : globalMessages.info("正在读取二级池数据", {
          key: "bond-ledger-sync",
          title: "数据刷新中",
          duration: 30_000,
        });
    try {
      const inventory = await listRemoteBondLedgers();
      if (generation !== syncGeneration) return;
      remoteFiles = inventory.files;
      databaseLedgerDates = inventory.databaseDates;
      const previousWeek = previousBusinessWeekRange(currentReportDate());
      const resolved = resolveAvailableRange(
        databaseLedgerDates,
        startDate,
        endDate,
        previousWeek.startDate,
        previousWeek.endDate,
      );
      if (!resolved) {
        analytics = emptyBondLedgerReport();
        return;
      }
      if (resolved.fellBack && allowFallback) {
        startDate = resolved.startDate;
        endDate = resolved.endDate;
        rangeMonthLeft = monthStart(startDate);
        globalMessages.warning(
          `所选范围无线上台账，已回退至上周一到上周五：${startDate}—${endDate}`,
          {
            key: "bond-ledger-range-fallback",
            title: "日期范围已调整",
            duration: 6000,
          },
        );
      }
      if (generation !== syncGeneration) return;
      analytics = await loadBondLedgerReport(startDate, endDate);
    } catch (error) {
      if (generation !== syncGeneration) return;
      globalMessages.error(
        error instanceof Error ? error.message : String(error),
        { key: "bond-ledger-error", title: "二级池读取失败", duration: 8000 },
      );
      analytics = emptyBondLedgerReport();
    } finally {
      if (generation === syncGeneration) {
        loadingRecords = false;
        if (syncMessageId) globalMessages.dismiss(syncMessageId);
      }
    }
  }

  async function refreshLedgerInventory(): Promise<void> {
    const inventory = await listRemoteBondLedgers();
    remoteFiles = inventory.files;
    databaseLedgerDates = inventory.databaseDates;
  }

  async function handleFiles(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    const target = input === reuploadInput ? reuploadTarget : "";
    input.value = "";
    reuploadTarget = "";
    if (!files.length || uploading) return;
    uploading = true;
    const errors: string[] = [];
    let successCount = 0;
    let latestUploadedDate = "";
    for (const [index, file] of files.entries()) {
      globalMessages.info(
        `正在上传 ${index + 1}/${files.length}：${file.name}`,
        {
          key: "bond-ledger-operation",
          title: "台账处理中",
          duration: 120_000,
        },
      );
      try {
        const imported = await archiveBondLedgerFile(file, target || undefined);
        successCount += 1;
        if (imported.reportDate > latestUploadedDate) {
          latestUploadedDate = imported.reportDate;
        }
      } catch (error) {
        errors.push(
          `${file.name}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    try {
      await refreshLedgerInventory();
      if (latestUploadedDate) {
        managementMonth = monthStart(latestUploadedDate);
        selectedManagedDate = latestUploadedDate;
      }
      if (
        latestUploadedDate &&
        isWithin(latestUploadedDate, startDate, endDate)
      ) {
        await refreshReport(false);
      } else if (successCount) {
        await refreshReport(true);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      uploading = false;
    }
    const successMessage = successCount
      ? `已完成 ${successCount} 份 Excel 的 R2 归档和数据库导入`
      : "";
    if (errors.length) {
      globalMessages.error(
        [successMessage, errors.join("；")].filter(Boolean).join("；"),
        {
          key: "bond-ledger-operation",
          title: successCount ? "部分台账未完成" : "台账导入失败",
          duration: 10_000,
        },
      );
    } else if (successMessage) {
      globalMessages.success(successMessage, {
        key: "bond-ledger-operation",
        title: "台账导入完成",
        duration: 6000,
      });
    }
  }

  async function removeRemoteLedger(remote: RemoteBondLedgerFile): Promise<void> {
    if (deleting) return;
    const confirmed = window.confirm(
      `删除 ${remote.date} 的二级池数据库数据？原始 Excel 仍保留在 R2 归档。`,
    );
    if (!confirmed) return;
    deleting = true;
    try {
      await deleteRemoteBondLedger(remote.date);
      await refreshLedgerInventory();
      selectedManagedDate = "";
      globalMessages.success(`已删除 ${remote.date} 线上台账`, {
        key: "bond-ledger-operation",
        title: "台账已删除",
      });
      await refreshReport(true);
    } catch (error) {
      globalMessages.error(
        error instanceof Error ? error.message : String(error),
        { key: "bond-ledger-operation", title: "台账删除失败" },
      );
    } finally {
      deleting = false;
    }
  }

  async function openManagement(): Promise<void> {
    managementDialog.showModal();
    try {
      await refreshLedgerInventory();
      const latestDate = databaseLedgerDates.at(-1);
      if (latestDate) {
        managementMonth = monthStart(latestDate);
        selectedManagedDate = latestDate;
      }
    } catch (error) {
      globalMessages.error(
        error instanceof Error ? error.message : String(error),
        { key: "bond-ledger-operation", title: "台账列表读取失败" },
      );
    }
  }

  function openBatchUpload(): void {
    reuploadTarget = "";
    batchInput.click();
  }

  function openReupload(date: string): void {
    reuploadTarget = date;
    reuploadInput.click();
  }

  async function downloadManagedFile(
    remote: RemoteBondLedgerFile,
  ): Promise<void> {
    try {
      await downloadRemoteBondLedger(remote);
    } catch (error) {
      globalMessages.error(
        error instanceof Error ? error.message : String(error),
        { key: "bond-ledger-operation", title: "台账下载失败" },
      );
    }
  }

  function openRangePicker(event: MouseEvent): void {
    event.stopPropagation();
    rangeMonthLeft = monthStart(startDate || currentReportDate());
    rangePhase = "start";
    rangeOpen = !rangeOpen;
  }

  function closeRangeFromWindow(event: MouseEvent): void {
    const target = event.target;
    if (
      rangeOpen &&
      target instanceof Element &&
      !target.closest(".ledger-range-picker")
    ) {
      rangeOpen = false;
    }
  }

  function selectRangeDate(date: string): void {
    if (rangePhase === "start") {
      startDate = date;
      endDate = date;
      rangePhase = "end";
      return;
    }
    if (date < startDate) {
      endDate = startDate;
      startDate = date;
    } else {
      endDate = date;
    }
    rangeOpen = false;
    void refreshReport(true);
  }

  async function exportImage(): Promise<void> {
    if (!analytics.hasData || exporting) return;
    exporting = true;
    exportLabel = "正在导出";
    try {
      await exportReportImage(reportSurface, endDate, {
        captureClass: true,
        filename: `资金管理部-二级池-${startDate}至${endDate}.png`,
      });
      globalMessages.success("二级池图片已导出", {
        key: "bond-ledger-export",
        title: "导出完成",
      });
    } catch (error) {
      console.error("导出二级池失败", error);
      globalMessages.error(
        error instanceof Error ? error.message : String(error),
        { key: "bond-ledger-export", title: "导出失败" },
      );
    } finally {
      exportTimer = window.setTimeout(() => {
        exporting = false;
        exportLabel = "导出图片";
      }, 1200);
    }
  }

  function remoteForDate(date: string): RemoteBondLedgerFile | null {
    return remoteFiles.find((file) => file.date === date) ?? null;
  }

  function isSelectedDate(date: string): boolean {
    return isWithin(date, startDate, endDate);
  }

  function isWithin(date: string, start: string, end: string): boolean {
    return Boolean(start && end && date >= start && date <= end);
  }

  function deltaClass(value: number | null): string {
    return value === null || value === 0
      ? "tone-flat"
      : value > 0
        ? "tone-up"
        : "tone-down";
  }

  function signedMetric(
    value: number | null,
    divisor: number,
    digits: number,
    unit: string,
  ): { value: string; unit: string } {
    if (value === null || !Number.isFinite(value)) {
      return { value: "—", unit: "" };
    }
    return {
      value: `${sign(value)}${(Math.abs(value) / divisor).toFixed(digits)}`,
      unit: ` ${unit}`,
    };
  }

  function sign(value: number): string {
    return value > 0 ? "+" : value < 0 ? "−" : "";
  }

  function weeklyPercentageDelta(value: number | null): {
    detail: string;
    detailPrefix: string;
    detailSuffix: string;
    detailTone: string;
  } {
    const detail = signedMetric(value, 0.01, 2, "pct");
    return {
      detail: detail.value,
      detailPrefix: "较上周 ",
      detailSuffix: detail.unit,
      detailTone: deltaClass(value),
    };
  }

  function formatDrawdown(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return "—";
    return value === 0 ? "0.00%" : `−${(value * 100).toFixed(2)}%`;
  }

  function drawdownPeriod(
    peakDate: string | null,
    troughDate: string | null,
  ): string {
    if (!troughDate) return "区间内未出现回撤";
    return `${peakDate ? shortDate(peakDate) : "区间起点"} - ${shortDate(troughDate)}`;
  }

  function shortDate(value: string): string {
    return value.slice(5).replace("-", "/");
  }
  let current = $derived(analytics.currentPerformance);
  let rangeMonths = $derived([rangeMonthLeft, shiftMonth(rangeMonthLeft, 1)]);
  let managedFile =
    $derived(remoteFiles.find((file) => file.date === selectedManagedDate) ?? null);
  let managementCalendarDays = $derived(calendarDaysWithLedgerStatus(
    managementMonth,
    databaseLedgerDates,
  ));
  let selectedManagedDateHasLedger = $derived(databaseLedgerDates.includes(
    selectedManagedDate,
  ));
  let trendPoints =
    $derived(trendAccount === "all"
      ? analytics.performanceTrend
      : analytics.accountPerformanceTrends[trendAccount]);
  let trendReturnLabel =
    $derived(trendAccount === "all" ? "年化收益率" : "年化收益贡献");
  let metricCards = $derived([
    {
      label: "当前规模",
      value: formatYi(current?.marketValue ?? null),
      detail: signedMetric(
        analytics.metricDeltas.marketValue,
        100_000_000,
        2,
        "亿元",
      ),
      delta: analytics.metricDeltas.marketValue,
      icon: "bank" as MetricIconName,
    },
    {
      label: "杠杆率",
      value: formatMultiple(current?.leverage ?? null),
      detail: signedMetric(analytics.metricDeltas.leverage, 1, 2, "倍"),
      delta: analytics.metricDeltas.leverage,
      icon: "leverage" as MetricIconName,
    },
    {
      label: "修正久期",
      value: formatYears(current?.modifiedDuration ?? null),
      detail: signedMetric(
        analytics.metricDeltas.modifiedDuration,
        1,
        2,
        "年",
      ),
      delta: analytics.metricDeltas.modifiedDuration,
      icon: "bond" as MetricIconName,
    },
    {
      label: "年化收益率",
      value: formatDecimalPercent(analytics.ytdAnnualizedReturn),
      detail: signedMetric(
        analytics.metricDeltas.ytdAnnualizedReturn,
        0.01,
        2,
        "pct",
      ),
      delta: analytics.metricDeltas.ytdAnnualizedReturn,
      icon: "equity" as MetricIconName,
    },
    {
      label: "本周营收",
      value: formatSignedWan(analytics.rangeProfit),
      detail: signedMetric(
        analytics.metricDeltas.rangeProfit,
        10_000,
        1,
        "万元",
      ),
      delta: analytics.metricDeltas.rangeProfit,
      icon: "profit" as MetricIconName,
    },
    {
      label: "本周交易",
      value: `${analytics.transactionCount} 只`,
      detail: signedMetric(
        analytics.metricDeltas.transactionCount,
        1,
        0,
        "只",
      ),
      delta: analytics.metricDeltas.transactionCount,
      icon: "trade" as MetricIconName,
    },
  ]);
  let returnRiskCards = $derived([
    {
      label: "收益率（含免税）",
      value: formatDecimalPercent(current?.ytdAnnualizedReturn ?? null),
      ...weeklyPercentageDelta(
        analytics.metricDeltas.reportedYtdAnnualizedReturn,
      ),
      tone: "teal" as const,
      icon: "profit" as MetricIconName,
    },
    {
      label: "收益率（不含免税）",
      value: formatDecimalPercent(current?.ytdExTaxAnnualizedReturn ?? null),
      ...weeklyPercentageDelta(
        analytics.metricDeltas.reportedYtdExTaxAnnualizedReturn,
      ),
      tone: "blue" as const,
      icon: "equity" as MetricIconName,
    },
    {
      label: "波动率",
      value: formatDecimalPercent(
        analytics.returnRiskMetrics.annualizedVolatility,
      ),
      ...weeklyPercentageDelta(
        analytics.metricDeltas.annualizedVolatility,
      ),
      tone: "purple" as const,
      icon: "equity" as MetricIconName,
    },
    {
      label: "最大回撤",
      value: formatDrawdown(analytics.returnRiskMetrics.maxDrawdown),
      detail: drawdownPeriod(
        analytics.returnRiskMetrics.maxDrawdownPeakDate,
        analytics.returnRiskMetrics.maxDrawdownTroughDate,
      ),
      detailPrefix: "",
      detailSuffix: "",
      detailTone: "",
      tone: "red" as const,
      icon: "bond" as MetricIconName,
    },
  ]);
</script>

<svelte:window onclick={closeRangeFromWindow} />

<svelte:head>
  <title>{embedded ? "二级池 · 交易研究工作台" : "二级池 · 资金管理部"}</title>
  <meta name="description" content="二级资金池" />
  <meta name="theme-color" content="#f6f8fb" />
</svelte:head>

<div class:ledger-shell--embedded={embedded} class="ledger-shell">
  <div bind:this={reportSurface} class="ledger-report">
    <header class="ledger-masthead">
      <div class="ledger-title-block">
        <a class="ledger-back" href="/" aria-label="返回市场研究门户">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m12.5 4-6 6 6 6" />
          </svg>
        </a>
        <h1>
          <span>资金管理部</span>
          <span class="ledger-title-dot" aria-hidden="true">•</span>
          <span class="ledger-title-subject">二级池</span>
        </h1>
      </div>

      <div
        class="ledger-actions"
        aria-label="台账、日期范围与导出控制"
        use:portal={embedded ? "#tr-topbar-actions" : null}
      >
        <div class="ledger-range-picker">
          <Button data-ui-owner="lib-pages-BondLedgerPage-svelte" variant="outline"
            class={"ui-button ledger-range-trigger"}
            type="button"
            aria-label="选择统计日期范围"
            aria-expanded={rangeOpen}
            onclick={openRangePicker}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 6.5h12M6.5 3v3M13.5 3v3M4 4.5h12v12H4z" />
            </svg>
            <time datetime={startDate}>{startDate}</time>
            <span aria-hidden="true">—</span>
            <time datetime={endDate}>{endDate}</time>
          </Button>
          {#if rangeOpen}
            <div class="ledger-range-popover" role="dialog" aria-label="选择统计日期范围" tabindex="-1">
              <div class="range-calendar-nav">
                <Button data-ui-owner="lib-pages-BondLedgerPage-svelte" variant="outline" class={"ui-button"} type="button" aria-label="向前一个月" onclick={() => (rangeMonthLeft = shiftMonth(rangeMonthLeft, -1))}>‹</Button>
                <strong>{rangePhase === "start" ? "选择起始日期" : "选择结束日期"}</strong>
                <Button data-ui-owner="lib-pages-BondLedgerPage-svelte" variant="outline" class={"ui-button"} type="button" aria-label="向后一个月" onclick={() => (rangeMonthLeft = shiftMonth(rangeMonthLeft, 1))}>›</Button>
              </div>
              <div class="range-calendar-pair">
                {#each rangeMonths as month (month)}
                  <section class="mini-calendar" aria-label={monthLabel(month)}>
                    <h2>{monthLabel(month)}</h2>
                    <div class="calendar-weekdays" aria-hidden="true">
                      {#each WEEKDAYS as weekday}<span>{weekday}</span>{/each}
                    </div>
                    <div class="calendar-grid">
                      {#each calendarDays(month) as day (day.date)}
                        <Button data-ui-owner="lib-pages-BondLedgerPage-svelte" variant="ghost" class={["ui-button ledger-range-day", !day.inMonth && "outside", isSelectedDate(day.date) && "in-range", (day.date === startDate || day.date === endDate) && "endpoint"]} aria-pressed={isSelectedDate(day.date)}
                          type="button"



                          disabled={!day.inMonth}
                          aria-label={day.date}
                          onclick={() => selectRangeDate(day.date)}
                        >{day.day}</Button>
                      {/each}
                    </div>
                  </section>
                {/each}
              </div>
            </div>
          {/if}
        </div>

        <Button permission="bond.ledger:import|bond.ledger:delete" data-ui-owner="lib-pages-BondLedgerPage-svelte" variant="outline" class={"ui-button ledger-management-button"} type="button" onclick={openManagement}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3.5 5.5h13v11h-13zM6 3.5h8v2M6.5 9h7M6.5 12.5h7" />
          </svg>
          <span>台账管理</span>
        </Button>
        <Button data-ui-owner="lib-pages-BondLedgerPage-svelte" variant="default"

          class={["ui-button  export-button", exporting && "is-exporting"]}
          type="button"
          disabled={!analytics.hasData || loadingRecords || exporting}
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
    </header>

    {#if loadingRecords}
      <section class="ledger-loading" aria-live="polite">
        <span class="loading-orbit" aria-hidden="true"></span>
        <strong>正在读取二级池数据</strong>
      </section>
    {:else if !analytics.hasData}
      <section class="ledger-empty">
        <div class="ledger-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 48 48">
            <path d="M10 6h21l7 7v29H10z" />
            <path d="M31 6v8h8M16 23h16M16 29h16M16 35h10" />
          </svg>
        </div>
        <h2>数据库暂无二级池数据</h2>
        <Button permission="bond.ledger:import|bond.ledger:delete" data-ui-owner="lib-pages-BondLedgerPage-svelte" variant="outline" class={"ui-button"} type="button" onclick={openManagement}>打开台账管理</Button>
      </section>
    {:else}
      <section class="ledger-main">
        <section class="ledger-metrics" aria-label="二级池核心指标">
          {#each metricCards as card, index (card.label)}
            <MetricCard
              label={card.label}
              value={card.value}
              detail={card.detail.value}
              detailSuffix={card.detail.unit}
              detailTone={deltaClass(card.delta)}
              tone={METRIC_TONES[index] ?? "primary"}
              iconComponent={MetricIcon}
              iconProps={{ icon: card.icon }}
              iconPosition="start"
            />
          {/each}
        </section>

        <div class="ledger-performance-grid">
          <ModuleCard class="ledger-panel ledger-panel--trend" labelledBy="return-trend-title">
            <PanelHeading id="return-trend-title" title="规模&收益率走势">
              <div class="ledger-trend-toolbar">
                <div class="ledger-account-filter" role="radiogroup" aria-label="账户范围">
                  {#each TREND_ACCOUNT_OPTIONS as option (option.value)}
                    <label class:active={trendAccount === option.value}>
                      <input class="ui-radio "
                        type="radio"
                        name="ledger-trend-account"
                        value={option.value}
                        bind:group={trendAccount}
                      />
                      <span>{option.label}</span>
                    </label>
                  {/each}
                </div>
                <div class="ledger-trend-legend" role="list" aria-label="图例">
                  <span role="listitem"><i class="ledger-legend-line ledger-legend-line--scale" aria-hidden="true"></i>规模</span>
                  <span role="listitem"><i class="ledger-legend-line ledger-legend-line--return" aria-hidden="true"></i>{trendReturnLabel}</span>
                  <span role="listitem"><i class="ledger-legend-line ledger-legend-line--range" aria-hidden="true"></i>所选区间</span>
                </div>
              </div>
            </PanelHeading>
            <ChartHost
              renderer={renderBondScaleReturnTrend}
              args={[trendPoints, startDate, endDate, trendAccount]}
              ariaLabel={`二级池${TREND_ACCOUNT_OPTIONS.find((option) => option.value === trendAccount)?.label ?? "全部"}规模与${trendReturnLabel}走势`}
              className="ledger-chart ledger-chart--trend"
            />
          </ModuleCard>

          <ModuleCard class="ledger-panel ledger-panel--risk" labelledBy="return-risk-title">
            <PanelHeading id="return-risk-title" title="收益与风险指标" />
            <div class="ledger-return-risk-grid">
              {#each returnRiskCards as card (card.label)}
                <MetricCard
                  label={card.label}
                  value={card.value}
                  detail={card.detail}
                  detailPrefix={card.detailPrefix}
                  detailSuffix={card.detailSuffix}
                  detailTone={card.detailTone}
                  tone={card.tone}
                  iconComponent={MetricIcon}
                  iconProps={{ icon: card.icon }}
                  iconPosition="start"
                  compact
                />
              {/each}
            </div>
          </ModuleCard>
        </div>

        <div class="ledger-chart-grid">

          <ModuleCard class="ledger-panel" labelledBy="holding-type-title">
            <PanelHeading id="holding-type-title" title="持仓分布" />
            <ChartHost
              renderer={renderHoldingDistribution}
              args={[analytics.holdingTypes]}
              ariaLabel="持仓分布饼图"
              className="ledger-chart ledger-chart--category"
            />
          </ModuleCard>

          <ModuleCard class="ledger-panel" labelledBy="maturity-title">
            <PanelHeading id="maturity-title" title="期限分布" />
            <ChartHost
              renderer={renderMaturityDistribution}
              args={[analytics.maturityBuckets]}
              ariaLabel="持仓剩余期限分布图"
              className="ledger-chart ledger-chart--maturity"
            />
          </ModuleCard>
        </div>

        <ModuleCard class="ledger-panel" labelledBy="transactions-title">
          <PanelHeading id="transactions-title" title="成交明细">
            <div class="transaction-summary" aria-label="成交汇总">
              <span><i class="transaction-dot transaction-dot--buy"></i>买入 <strong>{formatYi(analytics.transactionTotals.买入)}</strong></span>
              <span><i class="transaction-dot transaction-dot--sell"></i>卖出 <strong>{formatYi(analytics.transactionTotals.卖出)}</strong></span>
              <span><i class="transaction-dot transaction-dot--maturity"></i>到期 <strong>{formatYi(analytics.transactionTotals.到期)}</strong></span>
            </div>
          </PanelHeading>
          <div class="ledger-table-wrap">
            <table class="ledger-table ledger-table--transactions">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>方向</th>
                  <th>债券代码</th>
                  <th>债券名称</th>
                  <th>债券类型</th>
                  <th>成交面额</th>
                  <th>实现损益</th>
                </tr>
              </thead>
              <tbody>
                {#each analytics.transactions as transaction, index (`${transaction.date}-${transaction.code}-${transaction.side}-${index}`)}
                  <tr>
                    <td>{transaction.date}</td>
                    <td><span class={`transaction-side transaction-side--${transaction.side === "买入" ? "buy" : transaction.side === "卖出" ? "sell" : "maturity"}`}>{transaction.side}</span></td>
                    <td>{transaction.code}</td>
                    <th scope="row">{transaction.name}</th>
                    <td>{transaction.category}</td>
                    <td>{formatYi(transaction.faceAmount)}</td>
                    <td class={deltaClass(transaction.realizedProfit)}>{transaction.realizedProfit === null ? "-" : formatSignedWan(transaction.realizedProfit)}</td>
                  </tr>
                {:else}
                  <tr class="ledger-table-empty"><td colspan="7">所选范围暂无成交</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
        </ModuleCard>

      </section>
    {/if}
  </div>
</div>

<input
  bind:this={batchInput}
  class="sr-only"
  type="file"
  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  multiple
  disabled={uploading}
  onchange={handleFiles}
/>
<input
  bind:this={reuploadInput}
  class="sr-only"
  type="file"
  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  disabled={uploading}
  onchange={handleFiles}
/>

<Modal bind:this={managementDialog}  aria-labelledby="ledger-management-title">
<div class="dialog-body ledger-management-dialog">
  <div class="ledger-management-content">
    <header>
      <h2 id="ledger-management-title">台账管理</h2>
      <Button data-ui-owner="lib-pages-BondLedgerPage-svelte" variant="outline" class={"ui-button"} type="button" aria-label="关闭台账管理" onclick={() => managementDialog.close()}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
      </Button>
    </header>
    <div class="ledger-management-toolbar">
      <Button permission="bond.ledger:import" data-ui-owner="lib-pages-BondLedgerPage-svelte" variant="default" class={"ui-button  ledger-upload-primary"} type="button" disabled={uploading} onclick={openBatchUpload}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 13V3m0 0L6.5 6.5M10 3l3.5 3.5M4 12.5V17h12v-4.5" /></svg>
        <span>{uploading ? "正在上传" : "批量上传 Excel"}</span>
      </Button>
      <span>数据库共 {databaseLedgerDates.length} 个报表日</span>
    </div>
    <div class="management-calendar-nav">
      <Button data-ui-owner="lib-pages-BondLedgerPage-svelte" variant="outline" class={"ui-button"} type="button" aria-label="上一个月" onclick={() => (managementMonth = shiftMonth(managementMonth, -1))}>‹</Button>
      <strong>{monthLabel(managementMonth)}</strong>
      <Button data-ui-owner="lib-pages-BondLedgerPage-svelte" variant="outline" class={"ui-button"} type="button" aria-label="下一个月" onclick={() => (managementMonth = shiftMonth(managementMonth, 1))}>›</Button>
    </div>
    <section class="management-calendar" aria-label={monthLabel(managementMonth)}>
      <div class="calendar-weekdays" aria-hidden="true">
        {#each WEEKDAYS as weekday}<span>{weekday}</span>{/each}
      </div>
      <div class="calendar-grid">
        {#each managementCalendarDays as day (day.date)}
          <Button data-ui-owner="lib-pages-BondLedgerPage-svelte" variant={day.date === selectedManagedDate ? "default" : "ghost"} class={["ui-button", !day.inMonth && "outside", day.hasLedger && "available"]} aria-pressed={day.date === selectedManagedDate}
            type="button"



            disabled={!day.inMonth || !day.hasLedger}
            aria-label={day.hasLedger ? `${day.date} 数据库有台账，查看管理操作` : `${day.date} 数据库无台账`}
            onclick={() => (selectedManagedDate = day.date)}
          >
            <span>{day.day}</span>
            <span class="sr-only">{day.hasLedger ? "有台账" : "无台账"}</span>
          </Button>
        {/each}
      </div>
    </section>
    <section class="ledger-management-detail" aria-live="polite">
      {#if managedFile}
        <div>
          <strong>{managedFile.date}</strong>
          <span>{managedFile.fileName} · {(managedFile.size / 1024).toFixed(0)} KB</span>
        </div>
        <div class="ledger-management-actions">
          <Button data-ui-owner="lib-pages-BondLedgerPage-svelte" variant="outline" class={"ui-button"} type="button" onclick={() => downloadManagedFile(managedFile)}>下载</Button>
          <Button permission="bond.ledger:import" data-ui-owner="lib-pages-BondLedgerPage-svelte" variant="outline" class={"ui-button"} type="button" disabled={uploading} onclick={() => openReupload(managedFile.date)}>重新上传</Button>
          <Button permission="bond.ledger:delete" data-ui-owner="lib-pages-BondLedgerPage-svelte" variant="destructive" class={"ui-button  danger"} type="button" disabled={deleting} onclick={() => removeRemoteLedger(managedFile)}>删除</Button>
        </div>
      {:else if selectedManagedDate && selectedManagedDateHasLedger}
        <div>
          <strong>{selectedManagedDate}</strong>
          <span>数据库已有台账，暂无原始文件管理信息</span>
        </div>
      {:else}
        <strong>请选择有台账日期</strong>
      {/if}
    </section>
  </div>
</div>
</Modal>
