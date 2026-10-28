<script lang="ts">
  import { NativeSelect } from "$lib/components/ui/native-select/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { onMount } from "svelte";

  import "../../layout-report.css";

  import {
    renderFinancingDriverContributions,
    renderIssuanceShapRadar,
  } from "../../charts/financing-model";
  import ChartHost from "../../components/ChartHost.svelte";
  import ModuleCard from "../../components/ModuleCard.svelte";
  import MetricCard from "../../components/MetricCard.svelte";
  import InstitutionLogo from "$lib/components/InstitutionLogo.svelte";
  import PanelHeading from "$lib/trading-research/PanelHeading.svelte";
  import {
    conclusionSchema,
    sellSideSummaryBody,
    sellSidePayloadSchema,
    timingDecisionHistorySchema,
    timingDecisionRecordSchema,
    type FinancingModelConclusion,
    type TimingDecisionRecord,
  } from "$lib/financing-model";
  import { globalMessages } from "$lib/global-messages";
  import { isAiRequestCancelled, useAiClient } from "$lib/ai-client.svelte";
  import { portal } from "$lib/portal";
  import { permissionVisibility } from "$lib/permission-visibility";
  import { issuanceBusinessMetricsSchema, parseIssuanceReport as parseFinancingModelReport, type IssuanceReport as FinancingModelReport } from "$lib/issuance-model";
  import { groupIssuanceShap, groupMlpContributions, selectIssuanceShapDrivers, issuanceDecisionLabel, issuanceDecisionNarrative } from "$lib/issuance-presentation";
  import { issuanceFeatureName, renderIssuanceForecast, renderIssuanceProductComparison } from "../../charts/issuance-model";
  interface Props {
    embedded?: boolean;
  }

  let { embedded = false }: Props = $props();
  const aiClient = useAiClient();
  const allowed = permissionVisibility();

  let report = $state<FinancingModelReport | null>(null);
  let businessMetrics = $state<NonNullable<FinancingModelReport["business_metrics"]> | null>(null);
  let loading = $state(true);
  let loadingVersion = $state(false);
  let saving = $state(false);
  let savingSellSide = $state(false);
  let savingDecision = $state(false);
  let generatingResearch = $state(false);
  let editingSellSide = $state(false);
  let editingDecision = $state(false);
  let futureWindowDetailsOpen = $state(false);
  let errorMessage = $state("");
  let editNarrative = $state("");
  let editSellSideSummary = $state("");
  let editDecisionRunId = "";
  let editDecisionAction = $state("");
  let editDecisionOutcome = $state("");
  let selectedRunId = $state("");
  let decisionHistory = $state<TimingDecisionRecord[]>([]);
  let conclusionTimer: ReturnType<typeof setTimeout> | null = null;
  let conclusionRevision = 0;
  let savedConclusionRevision = 0;
  let conclusionSavePromise: Promise<boolean> | null = null;
  let metricsController: AbortController | null = null;

  onMount(() => {
    void loadReport();
    void loadDecisionHistory();
    return () => {
      clearConclusionTimer();
      metricsController?.abort();
    };
  });

  function clearConclusionTimer(): void {
    if (conclusionTimer !== null) clearTimeout(conclusionTimer);
    conclusionTimer = null;
  }

  async function loadReport(): Promise<void> {
    loading = true;
    errorMessage = "";
    try {
      const reportResponse = await fetch("/api/financing-model", {
        headers: { Accept: "application/json" },
      });
      const reportPayload = await reportResponse.json();
      if (!reportResponse.ok) {
        throw new Error(reportPayload.error || "融资择时模型读取失败");
      }
      applyReport(parseFinancingModelReport(reportPayload));
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  async function loadDecisionHistory(): Promise<void> {
    try {
      const response = await fetch("/api/financing-model/decisions", {
        headers: { Accept: "application/json" },
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "择时决策记录读取失败");
      decisionHistory = timingDecisionHistorySchema.parse(payload);
    } catch (error) {
      globalMessages.error(
        error instanceof Error ? error.message : String(error),
        { key: "financing-model-decisions", title: "择时决策记录读取失败" },
      );
    }
  }

  async function loadBusinessMetrics(runId: string): Promise<void> {
    const controller = new AbortController();
    metricsController = controller;
    try {
      const response = await fetch(
        `/api/financing-model/business-metrics?run=${encodeURIComponent(runId)}`,
        { headers: { Accept: "application/json" }, signal: controller.signal },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "业务指标读取失败");
      if (!controller.signal.aborted && report?.snapshot.run_id === runId) {
        businessMetrics = issuanceBusinessMetricsSchema.parse(payload);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        globalMessages.error(
          error instanceof Error ? error.message : String(error),
          { key: "financing-model-business-metrics", title: "业务指标读取失败" },
        );
      }
    } finally {
      if (metricsController === controller) metricsController = null;
    }
  }

  function applyReport(nextReport: FinancingModelReport): void {
    clearConclusionTimer();
    metricsController?.abort();
    report = nextReport;
    businessMetrics = nextReport.business_metrics ?? null;
    if (nextReport.business_metrics === undefined) {
      void loadBusinessMetrics(nextReport.snapshot.run_id);
    }
    selectedRunId = nextReport.snapshot.run_id;
    futureWindowDetailsOpen = false;
    editingSellSide = false;
    editNarrative = nextReport.conclusion.edited
      ? nextReport.conclusion.narrative
      : nextReport.model_status.status !== 'active' ? '数据不满足要求，暂停预测'
      : issuanceDecisionNarrative(nextReport.snapshot) ?? nextReport.conclusion.narrative;
    conclusionRevision = 0;
    savedConclusionRevision = 0;
    resetSellSideEditor();
    closeDecisionEditor();
  }

  async function loadVersion(event: Event): Promise<void> {
    if (!report || loadingVersion) return;
    const nextRunId = (event.currentTarget as HTMLSelectElement).value;
    if (!nextRunId || nextRunId === report.snapshot.run_id) return;
    const previousRunId = report.snapshot.run_id;
    loadingVersion = true;
    try {
      if (conclusionSavePromise) await conclusionSavePromise;
      if (conclusionRevision > savedConclusionRevision && !(await saveConclusion())) {
        selectedRunId = previousRunId;
        return;
      }
      selectedRunId = nextRunId;
      const response = await fetch(
        `/api/financing-model?run=${encodeURIComponent(nextRunId)}`,
        { headers: { Accept: "application/json" } },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "融资择时模型版本读取失败");
      }
      applyReport(parseFinancingModelReport(payload));
    } catch (error) {
      selectedRunId = previousRunId;
      globalMessages.error(
        error instanceof Error ? error.message : String(error),
        { key: "financing-model-version", title: "版本切换失败" },
      );
    } finally {
      loadingVersion = false;
    }
  }

  function scheduleConclusionSave(delay = 650): void {
    clearConclusionTimer();
    conclusionTimer = setTimeout(() => { void saveConclusion(); }, delay);
  }

  function onConclusionInput(): void {
    conclusionRevision += 1;
    scheduleConclusionSave();
  }

  function resetSellSideEditor(): void {
    editSellSideSummary = report?.sellSide?.logicSummary ?? "";
  }

  function openSellSideEditor(): void {
    resetSellSideEditor();
    editingSellSide = true;
  }

  function openDecisionEditor(record?: TimingDecisionRecord): void {
    if (!snapshot) return;
    const current =
      record ??
      decisionHistory.find((item) => item.runId === snapshot?.run_id);
    editDecisionRunId = current?.runId ?? snapshot.run_id;
    editDecisionAction = current?.decisionAction ?? "";
    editDecisionOutcome = current?.outcome ?? "";
    editingDecision = true;
  }

  function closeDecisionEditor(): void {
    editingDecision = false;
    editDecisionRunId = "";
    editDecisionAction = "";
    editDecisionOutcome = "";
  }

  async function saveDecision(): Promise<void> {
    if (!editDecisionRunId || savingDecision) return;
    savingDecision = true;
    try {
      const response = await fetch("/api/financing-model/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: editDecisionRunId,
          decisionAction: editDecisionAction,
          outcome: editDecisionOutcome,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "择时决策记录保存失败");
      const saved = timingDecisionRecordSchema.parse(payload);
      decisionHistory = [
        saved,
        ...decisionHistory.filter((item) => item.runId !== saved.runId),
      ].sort((left, right) => right.decisionDate.localeCompare(left.decisionDate));
      closeDecisionEditor();
      globalMessages.success("择时决策记录已保存", {
        key: "financing-model-decision",
        title: "保存完成",
      });
    } catch (error) {
      globalMessages.error(
        error instanceof Error ? error.message : String(error),
        { key: "financing-model-decision", title: "决策记录保存失败" },
      );
    } finally {
      savingDecision = false;
    }
  }

  async function saveConclusion(): Promise<boolean> {
    clearConclusionTimer();
    if (!report || !$allowed('model.conclusion:update')) return false;
    if (conclusionSavePromise) return conclusionSavePromise;
    if (conclusionRevision <= savedConclusionRevision) return true;
    const text = editNarrative.trim();
    if (!text) {
      globalMessages.error("结论不能为空", { key: "financing-model-conclusion", title: "结论保存失败" });
      return false;
    }
    const runId = report.snapshot.run_id;
    const revision = conclusionRevision;
    const verdict = report.conclusion.edited ? report.conclusion.verdict
      : modelSuspended ? '暂停预测' : issuanceDecisionLabel(report.snapshot.decision.action) ?? report.conclusion.verdict;
    const preferredWindow = report.conclusion.edited || !modelSuspended ? report.conclusion.preferredWindow : '';
    saving = true;
    conclusionSavePromise = (async () => {
      let succeeded = false;
      try {
        const response = await fetch("/api/financing-model/conclusion", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId, verdict, preferredWindow, narrative: text }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "整体结论保存失败");
        const conclusion: FinancingModelConclusion = conclusionSchema.parse(payload);
        if (report?.snapshot.run_id === runId) report = { ...report, conclusion };
        savedConclusionRevision = revision;
        succeeded = true;
        return true;
      } catch (error) {
        globalMessages.error(
          error instanceof Error ? error.message : String(error),
          { key: "financing-model-conclusion", title: "结论保存失败" },
        );
        return false;
      } finally {
        saving = false;
        conclusionSavePromise = null;
        if (succeeded && conclusionRevision > savedConclusionRevision) scheduleConclusionSave(0);
      }
    })();
    return conclusionSavePromise;
  }

  async function generateResearch(): Promise<void> {
    if (!report || modelSuspended || generatingResearch) return;
    generatingResearch = true;
    try {
      const sellSide = await aiClient.run({
        title: "融资择时 · 卖方观点",
        url: "/api/financing-model/sell-side",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: report.snapshot.run_id }),
        },
        parse: (value) => sellSidePayloadSchema.parse(value),
        resultText: value => [value.logicSummary, ...value.views.map(view => `${view.institution} · ${view.title}\n${view.summary}\n${view.implication}`)].join('\n\n'),
      });
      report = { ...report, sellSide };
      editingSellSide = false;
      resetSellSideEditor();
    } catch (error) {
      if (!isAiRequestCancelled(error)) globalMessages.error(
        error instanceof Error ? error.message : String(error),
        {
          key: "financing-model-research",
          title: "卖方观点生成失败",
          duration: 10_000,
        },
      );
    } finally {
      generatingResearch = false;
    }
  }

  async function saveSellSideSummary(): Promise<void> {
    if (!report?.sellSide || savingSellSide) return;
    savingSellSide = true;
    try {
      const response = await fetch("/api/financing-model/sell-side", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: report.snapshot.run_id,
          logicSummary: editSellSideSummary,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "卖方观点保存失败");
      const sellSide = sellSidePayloadSchema.parse(payload);
      report = { ...report, sellSide };
      editingSellSide = false;
      resetSellSideEditor();
      globalMessages.success("卖方观点已保存", {
        key: "financing-model-research-revision",
        title: "保存完成",
      });
    } catch (error) {
      globalMessages.error(
        error instanceof Error ? error.message : String(error),
        {
          key: "financing-model-research-revision",
          title: "卖方观点保存失败",
        },
      );
    } finally {
      savingSellSide = false;
    }
  }

  function formatSigned(value: number, digits: number): string {
    const normalized = Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value;
    return `${normalized >= 0 ? "+" : ""}${normalized.toFixed(digits)}`;
  }

  function formatNullable(value: number | null | undefined, digits: number): string {
    return value === null || value === undefined ? "—" : value.toFixed(digits);
  }

  function formatRatioPercent(value: number | null | undefined): string {
    return value === null || value === undefined ? "—" : (value * 100).toFixed(2);
  }

  function displayDate(value: string): string {
    const [year, month, day] = value.split("-");
    return `${year}年${Number(month)}月${Number(day)}日`;
  }


  let snapshot = $derived(report?.snapshot ?? null);
  let modelSuspended = $derived(report?.model_status.status !== 'active');
  let versions = $derived(report?.versions ?? []);
  let recommendation = $derived(!modelSuspended && snapshot ? issuanceDecisionLabel(snapshot.decision.action) : null);
  let recommendationTone = $derived(recommendation === "尽快发行" ? "strong_buy" : recommendation === "等待" ? "neutral" : "wait");
  let isMlpAttribution = $derived(snapshot?.explanation?.method === 'relu_path_integrated_gradients');
  let driverGroups = $derived(isMlpAttribution
    ? groupMlpContributions(snapshot?.explanation?.features ?? [])
    : groupIssuanceShap(snapshot?.explanation?.features ?? []));
  let contributionTotal = $derived(driverGroups.reduce((sum, row) => sum + row.net_bp, 0));
  let marketDrivers = $derived.by(() => {
    if (isMlpAttribution) return driverGroups.map(row => ({display_name: row.display_name, shap: row.net_bp, value: null}));
    const merged = new Map<string, { display_name:string; shap:number; value:number|null }>();
    for (const row of selectIssuanceShapDrivers(snapshot?.explanation?.features ?? [])) {
      const name = issuanceFeatureName(row.feature);
      const existing = merged.get(name);
      merged.set(name, { display_name:name, shap:(existing?.shap ?? 0)+row.shap_bp,
        value:existing ? null : row.value });
    }
    return [...merged.values()].sort((left,right)=>Math.abs(right.shap)-Math.abs(left.shap));
  });
  let current = $derived(snapshot?.forecast[0]);
  let validationMetrics = $derived(snapshot ? (() => {
    const first = snapshot.forecast[0];
    const year = Number(snapshot.as_of_date.slice(0,4));
    const observed = snapshot.validation.metrics.find(row => row.year === year && row.lead_days === 30);
    return [
      {label:"训练样本",value:first ? String(first.market_training_samples) : "—"},
      {label:"训练截止",value:first?.market_train_label_end ?? "—"},
      {label:`${year}检验样本`,value:observed ? String(observed.samples) : "—"},
      {label:`${year}预测命中率（±5bp）`,value:observed?.hit_rate_5bp == null ? "—" : `${(observed.hit_rate_5bp*100).toFixed(1)}%`},
      {label:"平均误差",value:observed ? `${observed.mae_bp.toFixed(1)} bp` : "—"},
    ];
  })() : []);
</script>

<svelte:head>
  <title>{embedded ? "融资择时模型 · 交易研究工作台" : "债券融资择时模型 · 资金管理部"}</title>
  <meta
    name="description"
    content="债券融资择时模型结构化指标、未来窗口、驱动因素与卖方观点"
  />
</svelte:head>

{#snippet versionActions(portalTarget: string | null)}
  <div
    class="model-actions layout-report-screen-only"
    use:portal={portalTarget}
  >
    {#if snapshot}
      <label class="model-version-control">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4 6.5h12M6.5 3v3M13.5 3v3M4 4.5h12v12H4z" />
        </svg>
        <span>日期版本</span>
        <NativeSelect data-ui-owner="lib-pages-FinancingModelPage-svelte" class={"ui-select"}
          aria-label="融资择时模型日期版本"
          value={selectedRunId}
          onchange={loadVersion}
          disabled={loadingVersion}
        >
          {#each versions as version (version.runId)}
            <option value={version.runId}>{version.asOfDate}</option>
          {/each}
        </NativeSelect>
      </label>
    {/if}
  </div>
{/snippet}

{#snippet standaloneHeader()}
  <a class="skip-link" href="#financing-model-report">跳至报告正文</a>
  <header class="model-header">
    <div class="model-title-block">
      <a class="model-back" href="/" aria-label="返回市场研究门户">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="m12.5 4-6 6 6 6" />
        </svg>
      </a>
      <h1>
        <span>资金管理部</span>
        <span class="model-title-dot" aria-hidden="true">•</span>
        <span class="model-title-subject">债券融资择时模型</span>
      </h1>
    </div>
    {@render versionActions(null)}
  </header>
{/snippet}

{#snippet reportContents()}
  {#if loading}
    <section id="financing-model-report" class="loading-state" aria-busy="true">
      <span class="spinner" aria-hidden="true"></span>
      <p>正在读取融资择时模型数据</p>
    </section>
  {:else if errorMessage}
    <section id="financing-model-report" class="error-state">
      <h2>模型数据暂不可用</h2>
      <p>{errorMessage}</p>
      <Button data-ui-owner="lib-pages-FinancingModelPage-svelte" variant="outline" class={"ui-button"} type="button" onclick={loadReport}>重新读取</Button>
    </section>
  {:else if report && snapshot}
    <section id="financing-model-report" class="report-stack">
      <section class="overview-stack" aria-label="整体结论与业务指标">
        <ModuleCard class="conclusion-card" labelledBy="overall-conclusion-title">
          <div class="conclusion-heading-row">
            <PanelHeading id="overall-conclusion-title" title="整体结论" />
            {#if recommendation}
              <span class={`recommendation-badge recommendation-badge--${recommendationTone}`}>{recommendation}</span>
            {/if}
          </div>
          <div class="issuance-summary">
            <div class="issuance-product">
              <span>债券品种</span>
              <strong>{snapshot.terms.rating} {snapshot.terms.tenor}年期{snapshot.terms.bond_type}</strong>
            </div>
            {#if modelSuspended}<p role="status">数据不满足要求，暂停预测</p>
            {:else}<MetricCard label="预测发行利率" value={formatNullable(current?.coupon_percent, 2)} unit="%" tone="blue" compact />{/if}
          </div>
          <Textarea
            data-ui-owner="lib-pages-FinancingModelPage-svelte"
            class="conclusion-textarea"
            aria-label="整体结论"
            bind:value={editNarrative}
            maxlength={4000}
            rows={4}
            readonly={!$allowed('model.conclusion:update')}
            oninput={onConclusionInput}
            onblur={() => { void saveConclusion(); }}
          />
        </ModuleCard>

        <ModuleCard class="business-card" labelledBy="business-title">
          <PanelHeading id="business-title" title="业务指标" />
          <div class="business-metric-grid">
            <MetricCard label="LCR" value={formatRatioPercent(businessMetrics?.lcr?.value_ratio)} unit={businessMetrics?.lcr ? "%" : ""} tone="teal" compact
              detail={businessMetrics?.lcr?.historical_percentile == null ? "—" : `历史P${businessMetrics.lcr.historical_percentile.toFixed(1)}`} />
            <MetricCard label="NSFR" value={formatRatioPercent(businessMetrics?.nsfr?.value_ratio)} unit={businessMetrics?.nsfr ? "%" : ""} tone="blue" compact
              detail={businessMetrics?.nsfr?.historical_percentile == null ? "—" : `历史P${businessMetrics.nsfr.historical_percentile.toFixed(1)}`} />
            <MetricCard label="资金缺口" value={formatNullable(businessMetrics?.funding_gap?.value_yi,1)} unit={businessMetrics?.funding_gap ? "亿元" : ""} tone="orange" compact
              detail={businessMetrics?.funding_gap?.historical_percentile == null ? "—" : `历史P${businessMetrics.funding_gap.historical_percentile.toFixed(1)}`} />
            <MetricCard label="主体利差" value={formatNullable(businessMetrics?.issuer_spread?.spread_bp, 2)} unit={businessMetrics?.issuer_spread?.spread_bp === null || !businessMetrics?.issuer_spread ? "" : "bp"} tone="purple" compact
              detail={businessMetrics?.issuer_spread?.historical_percentile == null ? "—" : `历史P${businessMetrics.issuer_spread.historical_percentile.toFixed(1)}`} />
          </div>
        </ModuleCard>
      </section>

      {#if !modelSuspended}
      <section aria-label="四品种对比">
        <ModuleCard class="chart-card" labelledBy="product-title">
          <PanelHeading id="product-title" title="四品种对比" />
          <ChartHost renderer={renderIssuanceProductComparison} args={[snapshot.product_scenarios]}
            ariaLabel="3年与5年公募债和次级债预计票面对比" className="product-comparison-chart" />
        </ModuleCard>
      </section>

      <section aria-label="因子贡献">
        <ModuleCard class="factor-panel" labelledBy="factor-contribution-title">
          <PanelHeading id="factor-contribution-title" title="因子贡献" />
          {#if isMlpAttribution && snapshot.explanation}
            <dl class="contribution-reconciliation" aria-label="路径积分贡献对账">
              <div><dt>模型基值</dt><dd>{snapshot.explanation.base_coupon_bp.toFixed(3)} bp</dd></div>
              <div><dt>全部贡献</dt><dd>{contributionTotal >= 0 ? '+' : ''}{contributionTotal.toFixed(3)} bp</dd></div>
              <div><dt>预测发行利率</dt><dd>{snapshot.explanation.prediction_coupon_bp.toFixed(3)} bp</dd></div>
            </dl>
          {/if}
          <div class="driver-grid">
            <ChartHost renderer={renderIssuanceShapRadar} args={[driverGroups]} ariaLabel="票面预测因子贡献雷达图" className="driver-radar-chart" />
            <ChartHost renderer={renderFinancingDriverContributions} args={[marketDrivers, "coupon"]}
              ariaLabel={isMlpAttribution ? `路径积分贡献：${driverGroups.map(row => `${row.display_name} ${row.net_bp.toFixed(3)} bp`).join("，")}` : "当前票面预测因子贡献条形图"} className="driver-contribution-chart" />
          </div>
          {#if isMlpAttribution && snapshot.explanation}
            <details class="contribution-details">
              <summary>路径积分明细（{snapshot.explanation.features.length}项）</summary>
              <div class="table-scroll"><table>
                <thead><tr><th>编码因子</th><th>输入值</th><th>贡献 bp</th></tr></thead>
                <tbody>{#each snapshot.explanation.features as row}
                  <tr><td>{issuanceFeatureName(row.feature)}</td><td>{row.value === null ? '缺失（训练插补）' : row.value}</td><td>{row.shap_bp >= 0 ? '+' : ''}{row.shap_bp.toFixed(6)}</td></tr>
                {/each}</tbody>
              </table></div>
            </details>
          {/if}
        </ModuleCard>
      </section>

      <section class="supporting-grid" aria-label="未来发行窗口与模型验证">
        <ModuleCard class="forecast-panel" labelledBy="window-title">
          <PanelHeading id="window-title" title="未来发行窗口" controlsBesideTitle>
            <Button data-ui-owner="lib-pages-FinancingModelPage-svelte" variant="ghost"
              class={"ui-button  window-details-toggle"}
              type="button"
              aria-label={futureWindowDetailsOpen ? "收起未来发行窗口明细" : "展开未来发行窗口明细"}
              aria-expanded={futureWindowDetailsOpen}
              aria-controls="forecast-window-details"
              onclick={() => (futureWindowDetailsOpen = !futureWindowDetailsOpen)}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7.5 5 5 5-5" /></svg>
            </Button>
          </PanelHeading>
            <ChartHost
              renderer={renderIssuanceForecast}
              args={[snapshot.forecast]}
              ariaLabel="未来发行票面预测"
              className="forecast-chart"
            />
            <div
              id="forecast-window-details"
              class="forecast-table-wrap"
              hidden={!futureWindowDetailsOpen}
            >
              <table class="forecast-table">
                <caption>未来发行窗口明细</caption>
                <thead>
                  <tr>
                    <th scope="col">日期</th>
                    <th scope="col">预计票面</th>
                  </tr>
                </thead>
                <tbody>
                  {#each snapshot.forecast as point}
                    <tr>
                      <th scope="row">{displayDate(point.date)}</th>
                      <td>{formatNullable(point.coupon_percent,2)}%</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
        </ModuleCard>
        <ModuleCard class="validation-panel" labelledBy="validation-title">
          <PanelHeading id="validation-title" title="模型验证" />
          <dl class="validation-grid">
            {#each validationMetrics as metric}
              <div>
                <dt>{metric.label}</dt>
                <dd>{metric.value}</dd>
              </div>
            {/each}
            </dl>
        </ModuleCard>
      </section>

      {/if}
      <ModuleCard class="decision-history-section" labelledBy="decision-history-title">
        <PanelHeading id="decision-history-title" title="历史择时决策记录" controlsBesideTitle>
          {#if !editingDecision}
            <Button permission="model.decision:create" data-ui-owner="lib-pages-FinancingModelPage-svelte" variant="ghost" class={"ui-button  icon-button"} type="button" aria-label="录入当前决策" onclick={() => openDecisionEditor()}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>
            </Button>
          {/if}
        </PanelHeading>

        {#if editingDecision}
          <form class="decision-editor" onsubmit={(event) => { event.preventDefault(); saveDecision(); }}>
            <label>
              <span>决策操作</span>
              <Textarea data-ui-owner="lib-pages-FinancingModelPage-svelte" class={"ui-textarea"} bind:value={editDecisionAction} maxlength={1000} rows={3} required></Textarea>
            </label>
            <label>
              <span>结果</span>
              <Textarea data-ui-owner="lib-pages-FinancingModelPage-svelte" class={"ui-textarea"} bind:value={editDecisionOutcome} maxlength={2000} rows={3}></Textarea>
            </label>
            <div class="editor-actions">
              <Button data-ui-owner="lib-pages-FinancingModelPage-svelte" variant="outline" class={"ui-button secondary-button"} type="button" onclick={closeDecisionEditor}>取消</Button>
              <Button data-ui-owner="lib-pages-FinancingModelPage-svelte" variant="default" class={"ui-button  primary-button"} type="submit" disabled={savingDecision}>
                {savingDecision ? "保存中" : "保存"}
              </Button>
            </div>
          </form>
        {/if}

        <div class="decision-table-wrap">
          <table class="decision-table">
            <thead>
              <tr>
                <th scope="col">日期</th>
                <th scope="col">发行建议</th>
                <th scope="col">决策操作</th>
                <th scope="col">结果</th>
              </tr>
            </thead>
            <tbody>
              {#each decisionHistory as record}
                <tr>
                  <th scope="row">{displayDate(record.decisionDate)}</th>
                  <td>
                    <span class={`recommendation-badge recommendation-badge--${record.recommendation}`}>
                      {record.recommendationLabel}
                    </span>
                  </td>
                  <td>{record.decisionAction}</td>
                  <td>
                    <div class="decision-result-cell">
                      <span>{record.outcome || "—"}</span>
                      <Button permission="model.decision:create" data-ui-owner="lib-pages-FinancingModelPage-svelte" variant="ghost" class={"ui-button  icon-button"} type="button" aria-label={`编辑${record.decisionDate}择时决策记录`} onclick={() => openDecisionEditor(record)}>
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17l-1 3ZM14.5 7.5l3 3" />
                        </svg>
                      </Button>
                    </div>
                  </td>
                </tr>
              {:else}
                <tr>
                  <td class="decision-empty" colspan="4">暂无决策记录</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </ModuleCard>

      <ModuleCard class="sell-side-section" labelledBy="sell-side-title">
        <PanelHeading id="sell-side-title" title="卖方观点" controlsBesideTitle>
          <div class="section-actions heading-icon-actions">
            {#if report.sellSide && !editingSellSide}
              <Button permission="model.sell_side:update" data-ui-owner="lib-pages-FinancingModelPage-svelte" variant="ghost" class={"ui-button  icon-button"} type="button" aria-label="编辑卖方逻辑汇总" onclick={openSellSideEditor}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17l-1 3ZM14.5 7.5l3 3" />
                </svg>
              </Button>
            {/if}
            <Button permission="model.sell_side:generate" data-ui-owner="lib-pages-FinancingModelPage-svelte" variant="default" class={["ui-button  icon-button ai-generate-button", generatingResearch && "is-loading"]}  type="button" onclick={generateResearch} disabled={modelSuspended || generatingResearch || savingSellSide}
              aria-label={generatingResearch ? "AI 生成中" : report.sellSide ? "重新生成卖方观点" : "生成卖方观点"}
              aria-busy={generatingResearch}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="m10 2 1.1 4.2L15 8l-3.9 1.8L10 14l-1.1-4.2L5 8l3.9-1.8L10 2Z" />
                <path d="m16 13 .6 2.1 1.9.9-1.9.9L16 19l-.6-2.1-1.9-.9 1.9-.9L16 13Z" />
              </svg>
            </Button>
          </div>
        </PanelHeading>

        {#if report.sellSide}
          <div class="sell-side-summary-card">
            {#if editingSellSide}
              <form onsubmit={(event) => { event.preventDefault(); saveSellSideSummary(); }}>
                <label>
                  <span>卖方逻辑汇总</span>
                  <Textarea data-ui-owner="lib-pages-FinancingModelPage-svelte" class={"ui-textarea"} bind:value={editSellSideSummary} maxlength={4000} rows={6} required></Textarea>
                </label>
                <div class="editor-actions">
                  <Button data-ui-owner="lib-pages-FinancingModelPage-svelte" variant="outline" class={"ui-button secondary-button"} type="button" onclick={() => (editingSellSide = false)}>取消</Button>
                  <Button data-ui-owner="lib-pages-FinancingModelPage-svelte" variant="default" class={"ui-button  primary-button"} type="submit" disabled={savingSellSide}>{savingSellSide ? "保存中" : "保存"}</Button>
                </div>
              </form>
            {:else}
              <p>{report.sellSide.logicSummary}</p>
            {/if}
          </div>
          <div class={`sell-side-grid sell-side-grid--${report.sellSide.views.length}`}>
            {#each report.sellSide.views as view}
              <article class="sell-side-card">
                <div class="sell-side-institution">
                  <InstitutionLogo institution={view.institution} />
                  <strong>{view.institution}</strong>
                </div>
                <p>{sellSideSummaryBody(view.summary, view.institution)}</p>
                <div class="implication">
                  <strong>对发行的含义</strong>
                  <span>{view.implication}</span>
                </div>
              </article>
            {/each}
          </div>
        {:else}
          <div class="research-empty">
            <p>尚未生成卖方观点。</p>
          </div>
        {/if}
      </ModuleCard>

    </section>
  {/if}
{/snippet}

{#if embedded}
  {@render versionActions("#tr-topbar-actions")}
  {@render reportContents()}
{:else}
  <main class="financing-model-page layout-report layout-report--financing">
    {@render standaloneHeader()}
    {@render reportContents()}
  </main>
{/if}

<style>
  .financing-model-page {
    width: 100%;
    max-width: 1080px;
    min-height: 100dvh;
    margin-inline: auto;
    padding: 12px 16px 28px;
    color: var(--text-1);
    background: var(--bg-page);
  }

  .skip-link {
    position: fixed;
    z-index: 20;
    top: 8px;
    left: 8px;
    padding: 10px 14px;
    border-radius: var(--radius-control);
    color: #fff;
    background: var(--color-primary);
    transform: translateY(-150%);
  }

  .skip-link:focus {
    transform: translateY(0);
  }

  .model-header,
  .report-stack,
  .loading-state,
  .error-state {
    width: 100%;
  }

  .model-header {
    position: relative;
    z-index: 10;
    display: flex;
    min-height: 64px;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 4px 2px 12px;
    border-bottom: 1px solid var(--border-color);
  }

  .model-title-block,
  .model-actions,
  .model-version-control,
  .editor-actions,
  .section-actions {
    display: flex;
    align-items: center;
  }

  .model-title-block {
    min-width: 0;
    gap: 10px;
  }

  .model-title-block h1 {
    display: flex;
    min-width: 0;
    align-items: baseline;
    gap: 9px;
    margin: 0;
    color: var(--text-2);
    font-size: 1.5rem;
    font-weight: bolder;
    letter-spacing: -0.025em;
  }

  .model-title-dot {
    color: color-mix(in srgb, var(--brand) 72%, var(--text-muted));
  }

  .model-title-subject {
    color: var(--brand-deep);
  }

  .model-back {
    display: grid;
    width: 44px;
    height: 44px;
    flex: 0 0 auto;
    place-items: center;
    border: 1px solid var(--line);
    border-radius: var(--radius-control);
    color: var(--brand-deep);
    background: var(--surface);
    box-shadow: var(--shadow-card);
    text-decoration: none;
    transition:
      border-color 160ms ease,
      background 160ms ease;
  }

  .model-back:hover {
    border-color: var(--brand);
    background: var(--brand-soft);
  }

  .model-back svg,
  .model-version-control svg {
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.9;
  }

  .model-back svg {
    width: 20px;
  }

  .model-actions {
    flex: 0 0 auto;
    gap: 8px;
  }

  .model-version-control {
    min-height: 44px;
    gap: 8px;
    color: var(--text-2);
  }

  .model-version-control svg {
    width: 18px;
    flex: 0 0 18px;
  }

  .model-version-control span {
    font-weight: bold;
    white-space: nowrap;
  }

  :global(.model-version-control select[data-ui-owner="lib-pages-FinancingModelPage-svelte"]) {
    width: auto;
    min-width: 12.5rem;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  .report-stack {
    display: grid;
    gap: 16px;
  }

  .sell-side-summary-card,
  .sell-side-card {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-inner);
    background: var(--surface);
  }

  .section-actions {
    justify-content: space-between;
    gap: 10px;
  }

  :global(.text-button[data-ui-owner="lib-pages-FinancingModelPage-svelte"]) {
    padding: 0 10px;
  }

  :global(.icon-button[data-ui-owner="lib-pages-FinancingModelPage-svelte"]) {
    display: grid;
    width: 44px;
    height: 44px;
    flex: 0 0 auto;
    place-items: center;
  }

  :global(.icon-button[data-ui-owner="lib-pages-FinancingModelPage-svelte"] svg) {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.9;
  }

  :global(.conclusion-card) form,
  :global(.conclusion-card) label,
  .sell-side-summary-card form,
  .sell-side-summary-card label {
    display: grid;
    gap: 7px;
  }

  :global(.conclusion-card) form,
  .sell-side-summary-card form {
    gap: 11px;
    margin-top: 12px;
  }

  :global(.conclusion-card) label > span,
  .sell-side-summary-card label > span {
    font-size: 0.875rem;
    font-weight: bold;
  }

  :global(.conclusion-card input[data-ui-owner="lib-pages-FinancingModelPage-svelte"]),
  :global(.conclusion-card textarea[data-ui-owner="lib-pages-FinancingModelPage-svelte"]),
  :global(.sell-side-summary-card textarea[data-ui-owner="lib-pages-FinancingModelPage-svelte"]) {
    width: 100%;
    padding: 9px 11px;
  }

  :global(.conclusion-card textarea[data-ui-owner="lib-pages-FinancingModelPage-svelte"]),
  :global(.sell-side-summary-card textarea[data-ui-owner="lib-pages-FinancingModelPage-svelte"]) {
    resize: vertical;
    min-height: 124px;
  }

  .editor-actions {
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  }

  :global(.editor-actions .text-button[data-ui-owner="lib-pages-FinancingModelPage-svelte"]) {
    margin-right: auto;
  }

  :global(.primary-button[data-ui-owner="lib-pages-FinancingModelPage-svelte"]),
  :global(.secondary-button[data-ui-owner="lib-pages-FinancingModelPage-svelte"]) {
    padding: 0 16px;
  }

  :global(.window-details-toggle[data-ui-owner="lib-pages-FinancingModelPage-svelte"]) {
    display: grid;
    width: 44px;
    height: 44px;
    margin-left: -4px;
    place-items: center;
  }

  :global(.window-details-toggle[data-ui-owner="lib-pages-FinancingModelPage-svelte"] svg) {
    width: 18px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 2;
    transition: transform 180ms ease;
  }

  :global(.window-details-toggle[data-ui-owner="lib-pages-FinancingModelPage-svelte"][aria-expanded="true"] svg) {
    transform: rotate(180deg);
  }

  .driver-grid,
  .product-layout,
  .supporting-grid {
    display: grid;
    gap: 16px;
  }

  .contribution-details { margin-top: 16px; }
  .contribution-details summary { cursor: pointer; }
  .contribution-details .table-scroll { overflow-x: auto; max-height: 400px; margin-top: 16px; }
  .contribution-details table { width: 100%; border-collapse: collapse; }
  .contribution-details th, .contribution-details td { padding: 8px; text-align: right; border-bottom: 1px solid var(--line); }
  .contribution-details th:first-child, .contribution-details td:first-child { text-align: left; }

  .contribution-reconciliation {
    display: flex;
    flex-wrap: wrap;
    gap: 16px 32px;
    margin: 16px 0;
  }

  .contribution-reconciliation dt { color: var(--text-2); }
  .contribution-reconciliation dd { margin: 4px 0 0; font-weight: bold; }

  .driver-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .product-layout {
    grid-template-columns: minmax(0, 3fr) minmax(0, 1fr);
  }

  .supporting-grid {
    grid-template-columns: minmax(0, 3fr) minmax(0, 1fr);
  }

  .window-card-body {
    display: grid;
    min-height: 220px;
    grid-template-columns: minmax(0, 1fr);
    align-items: center;
    gap: 18px;
  }

  :global(.window-gauge) {
    width: 100%;
    height: 210px;
  }

  .window-decision {
    display: grid;
    justify-items: start;
    gap: 12px;
  }

  .window-decision h3 {
    margin: 0;
    color: var(--text-1);
    font-size: 1.5rem;
    font-weight: bolder;
  }

  .window-decision p,
  :global(.conclusion-card) p,
  :global(.product-result) p {
    margin: 0;
    color: var(--text-2);
    font-size: 1rem;
    line-height: 1.65;
  }

  .window-decision p strong {
    color: #173b78;
    font-weight: bolder;
    white-space: nowrap;
  }

  .recommendation-badge {
    display: inline-flex;
    min-height: 32px;
    align-items: center;
    padding: 5px 12px;
    border: 1px solid currentColor;
    border-radius: 999px;
    font-size: 0.875rem;
    font-weight: bold;
    line-height: 1;
    white-space: nowrap;
  }

  .recommendation-badge--strong_buy {
    color: #067647;
    background: #ecfdf3;
  }

  .recommendation-badge--neutral {
    color: #b54708;
    background: #fff7ed;
  }

  .recommendation-badge--wait {
    color: #b42318;
    background: #fef3f2;
  }

  .report-stack :global(.conclusion-card) {
    display: grid;
    align-content: start;
    gap: 12px;
    border-color: color-mix(in srgb, var(--brand) 28%, var(--line));
  }

  .overview-stack {
    display: grid;
    gap: 16px;
  }

  .conclusion-heading-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .conclusion-heading-row :global(.tr-panel-heading) {
    margin-bottom: 0;
  }

  .issuance-summary {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(180px, 220px);
    gap: 14px;
  }

  .issuance-product {
    display: grid;
    align-content: center;
    gap: 6px;
    padding: 12px 16px;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-inner);
    background: color-mix(in srgb, var(--brand-soft) 28%, var(--surface));
  }

  .issuance-product span {
    color: var(--text-2);
    font-size: 0.875rem;
  }

  .issuance-product strong {
    font-size: 1.25rem;
    font-weight: bold;
  }

  :global(.conclusion-textarea[data-ui-owner="lib-pages-FinancingModelPage-svelte"]) {
    width: 100%;
    min-height: 112px;
    resize: vertical;
    line-height: 1.65;
    background: var(--surface);
  }

  :global(.conclusion-textarea[data-ui-owner="lib-pages-FinancingModelPage-svelte"]:read-only) {
    cursor: default;
    border-color: var(--border-color);
  }

  .report-stack :global(.chart-card) {
    min-width: 0;
  }

  .report-stack :global(.factor-panel) {
    min-width: 0;
  }

  :global(.driver-radar-chart),
  :global(.driver-contribution-chart) {
    width: 100%;
    height: 320px;
    margin-top: 8px;
  }

  .business-section {
    display: grid;
  }

  .business-metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }

  :global(.product-comparison-chart) {
    width: 100%;
    height: 280px;
    margin-top: 8px;
  }

  .report-stack :global(.product-result) {
    gap: 0;
    display: flex;
    flex-direction: column;
    border-color: color-mix(in srgb, var(--brand) 30%, var(--line));
    background: color-mix(in srgb, var(--brand-soft) 32%, var(--surface));
  }

  .product-result-body {
    display: grid;
    align-content: center;
    justify-items: start;
    flex: 1;
    gap: 16px;
    padding-block: 16px;
  }

  .product-result-metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    width: 100%;
    gap: 16px;
    margin: 0;
    padding-top: 16px;
    border-top: 1px solid var(--border-color);
  }

  .product-result-metrics dt {
    color: var(--text-2);
    font-size: 0.875rem;
  }

  .product-result-metrics dd {
    margin: 4px 0 0;
    color: var(--brand-deep);
    font-size: 1.25rem;
    font-weight: bold;
    font-variant-numeric: tabular-nums;
  }

  .product-result-metrics dd span { font-size: 0.875rem; }

  .product-result-name {
    color: #173b78;
    font-size: 1.5rem;
    font-weight: bolder;
  }

  .report-stack :global(.forecast-panel) {
    min-width: 0;
  }

  .report-stack :global(.validation-panel) {
    display: grid;
    align-content: start;
    gap: 14px;
  }

  .validation-grid {
    display: grid;
    gap: 0;
    margin: 0;
  }

  .validation-grid > div {
    display: flex;
    min-width: 0;
    min-height: 48px;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-block: 4px;
    border-bottom: 1px solid var(--border-color);
  }

  .validation-grid > div:last-child { border-bottom: 0; }

  .validation-grid dt {
    color: var(--text-2);
    font-size: 0.875rem;
    white-space: nowrap;
  }

  .validation-grid dd {
    margin: 0;
    color: var(--brand-deep);
    font-size: 1.125rem;
    font-weight: bold;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  :global(.forecast-chart) {
    width: 100%;
    height: 310px;
  }

  .forecast-table-wrap {
    max-width: 100%;
    margin-top: 12px;
    overflow-x: auto;
    border: 1px solid var(--border-color);
    border-radius: 8px;
  }

  .forecast-table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }

  .forecast-table caption {
    padding: 10px 12px;
    color: #173b78;
    text-align: left;
    font-weight: bold;
  }

  .forecast-table th,
  .forecast-table td {
    padding: 9px 12px;
    border-top: 1px solid var(--border-color);
    text-align: right;
    white-space: nowrap;
  }

  .forecast-table thead th {
    color: var(--text-3);
    background: #f4f7fb;
    font-size: 0.8125rem;
  }

  .forecast-table th:first-child,
  .forecast-table td:first-child {
    text-align: left;
  }

  .forecast-table tbody th {
    color: var(--text-2);
    font-weight: normal;
  }

  .decision-editor {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 14px;
    padding: 14px;
    border: 1px solid color-mix(in srgb, var(--brand) 24%, var(--line));
    border-radius: var(--radius-inner);
    background: color-mix(in srgb, var(--brand-soft) 24%, var(--surface));
  }

  .decision-editor label {
    display: grid;
    gap: 7px;
  }

  .decision-editor label > span {
    font-weight: bold;
  }

  :global(.decision-editor textarea[data-ui-owner="lib-pages-FinancingModelPage-svelte"]) {
    width: 100%;
    padding: 9px 11px;
    resize: vertical;
    min-height: 92px;
  }

  .decision-editor .editor-actions {
    grid-column: 1 / -1;
  }

  .decision-table-wrap {
    max-width: 100%;
    overflow-x: auto;
    border: 1px solid var(--border-color);
    border-radius: 8px;
  }

  .decision-table {
    width: 100%;
    min-width: 900px;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }

  .decision-table th,
  .decision-table td {
    padding: 11px 12px;
    border-top: 1px solid var(--border-color);
    text-align: left;
    vertical-align: middle;
  }

  .decision-table thead th {
    border-top: 0;
    color: var(--text-3);
    background: #f4f7fb;
  }

  .decision-table tbody th {
    color: var(--text-2);
    font-weight: normal;
    white-space: nowrap;
  }

  .decision-table th:nth-child(1),
  .decision-table td:nth-child(1) {
    width: 150px;
  }

  .decision-table th:nth-child(2),
  .decision-table td:nth-child(2),
  .decision-table th:nth-child(3),
  .decision-table td:nth-child(3) {
    width: 128px;
  }

  .decision-result-cell {
    display: flex;
    min-width: 220px;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .decision-empty {
    height: 88px;
    color: var(--text-2);
    text-align: center !important;
  }

  .section-actions.heading-icon-actions { flex-wrap: nowrap; }

  :global(.ai-generate-button[data-ui-owner="lib-pages-FinancingModelPage-svelte"]) { padding: 3px; }
  :global(.ai-generate-button[data-ui-owner="lib-pages-FinancingModelPage-svelte"] svg) { width: 16px; height: 16px; stroke-width: 1.5; }
  :global(.ai-generate-button[data-ui-owner="lib-pages-FinancingModelPage-svelte"].is-loading svg) { animation: spin 1.2s linear infinite; }

  .sell-side-summary-card {
    padding: 18px;
    border-color: color-mix(in srgb, var(--brand) 24%, var(--line));
    background: color-mix(in srgb, var(--brand-soft) 32%, var(--surface));
  }

  .sell-side-summary-card p {
    width: 100%;
    margin: 0;
    line-height: 1.65;
  }

  .sell-side-summary-card form {
    margin-top: 0;
  }

  .sell-side-grid {
    display: grid;
    grid-template-columns: repeat(var(--sell-side-columns), minmax(0, 1fr));
    gap: 12px;
    margin-top: 14px;
  }

  .sell-side-grid--3 {
    --sell-side-columns: 3;
  }

  .sell-side-grid--4 {
    --sell-side-columns: 4;
  }

  .sell-side-grid--5 {
    --sell-side-columns: 5;
  }

  .sell-side-card {
    display: grid;
    min-width: 0;
    grid-row: span 3;
    grid-template-rows: subgrid;
    gap: 0;
    overflow: hidden;
    border-color: color-mix(in srgb, var(--brand) 22%, var(--line));
    box-shadow: var(--shadow-card);
  }

  .sell-side-institution {
    display: flex;
    min-height: 48px;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--brand) 16%, var(--line));
    color: var(--brand-deep);
    background: color-mix(in srgb, var(--brand-soft) 52%, var(--surface));
    font-size: 1rem;
  }

  .sell-side-institution strong {
    min-width: 0;
    line-height: 1.35;
  }

  .sell-side-card p {
    margin: 0;
    padding: 15px 16px 16px;
    line-height: 1.65;
  }

  .implication {
    display: grid;
    align-content: start;
    gap: 5px;
    padding: 13px 16px 15px;
    border-top: 1px solid color-mix(in srgb, var(--brand) 14%, var(--line));
    color: var(--text-2);
    background: color-mix(in srgb, var(--panel) 54%, var(--surface));
  }

  .implication strong {
    color: #173b78;
    font-size: 0.875rem;
  }

  .research-empty {
    display: grid;
    min-height: 120px;
    place-items: center;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-inner);
    color: var(--text-2);
    background: color-mix(in srgb, var(--panel) 42%, var(--surface));
    text-align: center;
  }

  .research-empty p {
    margin: 0;
  }

  .loading-state,
  .error-state {
    display: grid;
    min-height: 50vh;
    place-items: center;
    align-content: center;
    gap: 12px;
    text-align: center;
  }

  .loading-state p,
  .error-state p,
  .error-state h2 {
    margin: 0;
  }

  .spinner {
    width: 36px;
    height: 36px;
    border: 3px solid #d8e2f0;
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  :global(.error-state button[data-ui-owner="lib-pages-FinancingModelPage-svelte"]) {
    padding: 0 16px;
  }

  :global(button[data-ui-owner="lib-pages-FinancingModelPage-svelte"]:focus-visible),
  a:focus-visible,
  :global(input[data-ui-owner="lib-pages-FinancingModelPage-svelte"]:focus-visible),
  :global(select[data-ui-owner="lib-pages-FinancingModelPage-svelte"]:focus-visible),
  :global(textarea[data-ui-owner="lib-pages-FinancingModelPage-svelte"]:focus-visible) {
    outline: 3px solid color-mix(in srgb, var(--color-primary) 34%, transparent);
    outline-offset: 2px;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @supports not (grid-template-rows: subgrid) {
    .sell-side-card {
      grid-template-rows: auto 1fr auto;
    }
  }

  @media (max-width: 1500px) {
    .sell-side-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .sell-side-grid--3 .sell-side-card:last-child,
    .sell-side-grid--5 .sell-side-card:last-child {
      grid-column: 1 / -1;
    }
  }

  @media (max-width: 1080px) {
    .model-header {
      align-items: flex-start;
      flex-direction: column;
    }

    .model-actions {
      width: 100%;
      justify-content: flex-end;
    }

    .driver-grid,
    .product-layout,
    .supporting-grid {
      grid-template-columns: 1fr;
    }

    .business-metric-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 720px) {
    .financing-model-page {
      padding: 8px max(10px, env(safe-area-inset-right, 0px)) 24px
        max(10px, env(safe-area-inset-left, 0px));
    }

    .model-title-block h1 {
      font-size: 1.125rem;
    }

    .model-actions {
      display: flex;
    }

    .model-version-control {
      width: 100%;
      min-width: 0;
    }

    :global(.model-version-control select[data-ui-owner="lib-pages-FinancingModelPage-svelte"]) {
      min-width: 0;
      flex: 1;
    }

    .driver-grid,
    .business-metric-grid {
      grid-template-columns: 1fr;
    }

    .decision-editor {
      grid-template-columns: 1fr;
    }

    .decision-editor .editor-actions {
      grid-column: auto;
    }

    .window-card-body {
      grid-template-columns: 1fr;
      gap: 0;
    min-height: 220px;
    }

    .issuance-summary {
      grid-template-columns: 1fr;
    }

    .window-decision {
      justify-items: start;
      text-align: left;
    }

    .section-actions {
      flex-wrap: wrap;
      justify-content: flex-end;
    }


    .sell-side-grid {
      grid-template-columns: 1fr;
    }

    .sell-side-grid .sell-side-card:last-child {
      grid-column: auto;
    }

    :global(.forecast-chart) {
      height: 280px;
    }
  }

  @media (max-width: 520px) {
    .model-version-control span {
      display: none;
    }

    .validation-grid {
      grid-template-columns: 1fr;
    }
  }

  @media print {
    .model-header {
      align-items: center;
      flex-direction: row;
    min-height: 64px;
    }

    .driver-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .product-layout {
      grid-template-columns: minmax(0, 3fr) minmax(0, 1fr);
    }

    .supporting-grid {
      grid-template-columns: minmax(0, 3fr) minmax(0, 1fr);
    }

    .business-metric-grid {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }

    .sell-side-grid--3 {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .sell-side-grid--4 {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }

    .sell-side-grid--5 {
      grid-template-columns: repeat(5, minmax(0, 1fr));
    }

    .sell-side-grid .sell-side-card:last-child {
      grid-column: auto;
    }

    .report-stack > section,
    :global(.report-stack > .tr-panel) {
      break-inside: avoid-page;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .model-back,
    :global(.icon-button[data-ui-owner="lib-pages-FinancingModelPage-svelte"]),
    :global(.window-details-toggle[data-ui-owner="lib-pages-FinancingModelPage-svelte"]),
    :global(.window-details-toggle[data-ui-owner="lib-pages-FinancingModelPage-svelte"] svg) {
      transition: none;
    }

    .spinner,
    :global(.ai-generate-button[data-ui-owner="lib-pages-FinancingModelPage-svelte"].is-loading svg) { animation: none; }
  }
</style>
