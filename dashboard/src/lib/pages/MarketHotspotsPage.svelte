<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import Modal from '$lib/components/Modal.svelte';
  import * as Popover from '$lib/components/ui/popover/index.js';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import { Input } from "$lib/components/ui/input/index.js";
  import { onDestroy, onMount } from "svelte";
  import { isAiRequestCancelled, useAiClient } from "$lib/ai-client.svelte";

  import WordCloud from "$lib/components/WordCloud.svelte";
  import type {
    Hotspot,
    HotspotApiResponse,
    HotspotGenerationScope,
    HotspotScope,
  } from "$lib/hotspots";
  interface Props {
    embedded?: boolean;
  }

  let { embedded = false }: Props = $props();
  const aiClient = useAiClient();

  let scopeMode: "rolling" | "range" = $state("rolling");
  let rollingCount = $state(20);
  let startDate = $state(offsetShanghaiDate(-7));
  let endDate = $state(shanghaiDate(new Date()));
  let data = $state<HotspotApiResponse | null>(null);
  let selected = $state<Hotspot | null>(null);
  let loading = $state(true);
  let regenerating = $state(false);
  let errorMessage = $state("");
  let request: AbortController | null = null;
  let configurationOpen = $state(false);

  let scopeLabel =
    $derived(data?.scope.mode === "rolling"
      ? `最近 ${data.scope.rollingCount} 篇`
      : data?.scope.mode === "range"
        ? `${data.scope.startDate} 至 ${data.scope.endDate}`
        : "尚未生成");

  onMount(loadLatestHotspots);
  onDestroy(() => request?.abort());

  async function loadLatestHotspots(): Promise<void> {
    request?.abort();
    request = new AbortController();
    loading = !data;
    regenerating = false;
    errorMessage = "";
    try {
      const response = await fetch("/api/rag/hotspots", {
        signal: request.signal,
        headers: { Accept: "application/json" },
      });
      const payload = (await response.json()) as HotspotApiResponse & {
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "热点快照读取失败");
      data = payload;
      syncScopeControls(payload.scope);
      selected = null;
    } catch (error) {
      if (!isAiRequestCancelled(error)) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    } finally {
      loading = false;
      regenerating = false;
    }
  }

  async function generateHotspots(scope: HotspotGenerationScope): Promise<void> {
    request?.abort();
    request = new AbortController();
    loading = !data;
    regenerating = true;
    errorMessage = "";
    try {
      const payload = await aiClient.run({
        title: "市场热点",
        url: "/api/rag/hotspots",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(scope),
        },
        signal: request.signal,
        parse: (value) => value as HotspotApiResponse,
        resultText: value => [value.marketSummary, ...value.hotspots.map(item => `${item.keyword}\n${item.explanation}`)].filter(Boolean).join('\n\n'),
      });
      data = payload;
      syncScopeControls(payload.scope);
      selected = null;
    } catch (error) {
      if (!isAiRequestCancelled(error)) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    } finally {
      loading = false;
      regenerating = false;
    }
  }

  function selectHotspot(hotspot: Hotspot): void {
    selected = hotspot;
  }

  function applyConfiguration(): void {
    let scope: HotspotGenerationScope;
    if (scopeMode === "rolling") {
      rollingCount = Math.min(100, Math.max(8, Math.round(rollingCount || 20)));
      scope = { mode: "rolling", rollingCount };
    } else {
      if (!startDate || !endDate || startDate > endDate) {
        errorMessage = "开始日期不能晚于结束日期";
        return;
      }
      scope = { mode: "range", startDate, endDate };
    }
    configurationOpen = false;
    selected = null;
    void generateHotspots(scope);
  }

  function regenerateCurrentScope(): void {
    void generateHotspots(data ? generationScope(data.scope) : draftScope());
  }

  function openConfiguration(): void {
    if (data) syncScopeControls(data.scope);
    errorMessage = "";
    configurationOpen = true;
  }

  function closeConfiguration(): void {
    configurationOpen = false;
  }


  function closeDetails(): void {
    selected = null;
  }

  function syncScopeControls(scope: HotspotScope): void {
    scopeMode = scope.mode;
    if (scope.mode === "rolling") {
      rollingCount = scope.rollingCount;
    } else {
      startDate = scope.startDate;
      endDate = scope.endDate;
    }
  }

  function generationScope(scope: HotspotScope): HotspotGenerationScope {
    return scope.mode === "rolling"
      ? { mode: "rolling", rollingCount: scope.rollingCount }
      : {
          mode: "range",
          startDate: scope.startDate,
          endDate: scope.endDate,
        };
  }

  function draftScope(): HotspotGenerationScope {
    return scopeMode === "rolling"
      ? {
          mode: "rolling",
          rollingCount: Math.min(100, Math.max(8, Math.round(rollingCount || 20))),
        }
      : { mode: "range", startDate, endDate };
  }

  function formatGeneratedAt(value: string): string {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(value));
  }

  function shanghaiDate(value: Date): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value);
  }

  function offsetShanghaiDate(days: number): string {
    const value = new Date();
    value.setUTCDate(value.getUTCDate() + days);
    return shanghaiDate(value);
  }

  function confidenceLabel(confidence: Hotspot["confidence"]): string {
    return { high: "高置信", medium: "中置信", low: "低置信" }[confidence];
  }
</script>



<svelte:head>
{#if !embedded}
  <title>市场热点图谱 · 资金管理部</title>
  <meta
    name="description"
    content="市场热点图谱"
  />
  <meta name="theme-color" content="#f6f8fb" />
{/if}
</svelte:head>

<div class="hotspot-page" class:hotspot-page--embedded={embedded}>
  <header class="hotspot-header">
    {#if !embedded}
    <div class="brand-block">
      <Button data-ui-owner="lib-pages-MarketHotspotsPage-svelte" variant="ghost" class={"ui-button  back-link"} href="/" aria-label="返回市场研究门户">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m15 18-6-6 6-6" />
        </svg>
      </Button>
      <div>
        <div class="eyebrow">
          <span class="live-dot" aria-hidden="true"></span>
          AI RESEARCH SIGNALS
        </div>
        <h1>市场热点图谱</h1>
      </div>
    </div>

    {/if}
    <div class="header-controls" aria-label="热点控制">
      <Popover.Root bind:open={configurationOpen} onOpenChange={(open) => { if (open) openConfiguration(); }}>
        <Popover.Trigger>
          {#snippet child({ props })}
        <Button data-ui-owner="lib-pages-MarketHotspotsPage-svelte" variant="outline"
          permission="research.hotspot:generate" class={"ui-button scope-button"} {...props}
          aria-label={`证据范围：${scopeLabel}`}
          type="button"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M7 14v6" />
          </svg>
          <span><span class="scope-label">证据范围</span>{scopeLabel}</span>
        </Button>
          {/snippet}
        </Popover.Trigger>
        <Popover.Content role="dialog" align="end" sideOffset={12} class="w-auto max-w-[calc(100vw-2rem)] p-0 gap-0" aria-label="配置热点证据范围">
          <div id="hotspot-scope-panel" class="scope-panel">
            <div class="scope-panel__header">
              <div>
                <h2>配置证据范围</h2>
              </div>
              <Button data-ui-owner="lib-pages-MarketHotspotsPage-svelte" variant="outline" class={"ui-button"} type="button" aria-label="关闭配置" onclick={closeConfiguration}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </Button>
            </div>
            <Tabs.Root bind:value={() => scopeMode, (value) => scopeMode = value as "rolling" | "range"}>
              <Tabs.List class="mt-4 w-full" aria-label="范围模式">
                <Tabs.Trigger value="rolling" class="flex-1 min-h-11">滚动篇数</Tabs.Trigger>
                <Tabs.Trigger value="range" class="flex-1 min-h-11">日期范围</Tabs.Trigger>
              </Tabs.List>
              <Tabs.Content value="rolling">
              <label class="scope-field">
                <span>最近文章数</span>
                <div class="number-field">
                  <Input data-ui-owner="lib-pages-MarketHotspotsPage-svelte" class={"ui-input"}
                    type="number"
                    min="8"
                    max="100"
                    step="1"
                    bind:value={rollingCount}
                  />
                  <span>篇</span>
                </div>
              </label>
              </Tabs.Content>
              <Tabs.Content value="range">
              <div class="range-fields">
                <label class="scope-field">
                  <span>开始日期</span>
                  <Input data-ui-owner="lib-pages-MarketHotspotsPage-svelte" class={"ui-input"} type="date" bind:value={startDate} />
                </label>
                <label class="scope-field">
                  <span>结束日期</span>
                  <Input data-ui-owner="lib-pages-MarketHotspotsPage-svelte" class={"ui-input"} type="date" bind:value={endDate} />
                </label>
              </div>
              </Tabs.Content>
            </Tabs.Root>
            <Button permission="research.hotspot:generate" data-ui-owner="lib-pages-MarketHotspotsPage-svelte" variant="outline" class={"ui-button apply-scope-button"} type="button" onclick={applyConfiguration}>
              应用并生成热点
            </Button>
          </div>
        </Popover.Content>
      </Popover.Root>
      <Button permission="research.hotspot:generate" data-ui-owner="lib-pages-MarketHotspotsPage-svelte" variant="default"
        class={"ui-button  regenerate-button"}
        type="button"
        disabled={loading || regenerating}
        onclick={regenerateCurrentScope}
      >
        <svg class:spinning={regenerating} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 11a8 8 0 1 0-2.3 5.7" />
          <path d="M20 4v7h-7" />
        </svg>
        <span>{regenerating ? "AI 聚合中" : "重新生成"}</span>
      </Button>
    </div>
  </header>

  <svelte:element this={embedded ? "section" : "main"} class="hotspot-stage">
    {#if loading}
      <section class="state-card loading-card" aria-live="polite">
        <span class="loading-ring" aria-hidden="true"></span>
        <div>
          <strong>{regenerating ? "正在按所选范围生成热点" : "正在读取最近一次生成的热点"}</strong>
        </div>
      </section>
    {:else if errorMessage}
      <section class="state-card error-card" role="alert">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 9v4m0 4h.01" />
          <path d="M10.3 3.7 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z" />
        </svg>
        <div>
          <strong>热点暂时无法生成</strong>
          <p>{errorMessage}</p>
        </div>
        <Button data-ui-owner="lib-pages-MarketHotspotsPage-svelte" variant="outline" class={"ui-button"} type="button" onclick={loadLatestHotspots}>重新读取</Button>
      </section>
    {:else if data}
      <section class="cloud-panel" aria-labelledby="cloud-heading">
        <div class="summary-meta">
          <time datetime={data.generatedAt}>{formatGeneratedAt(data.generatedAt)} 生成</time>
        </div>
        <div class="market-summary">
          <div class="summary-heading">
            <span>热点概览</span>
            <h2 id="cloud-heading">{data.marketSummary}</h2>
          </div>
        </div>

        <div class="cloud-canvas">
          <WordCloud
            items={data.hotspots}
            selectedKeyword={selected?.keyword ?? ""}
            onSelect={selectHotspot}
          />
        </div>
      </section>

      {#if selected}
        <Modal open aria-label={`${selected.keyword}热点详情`} onclose={closeDetails} class="hotspot-detail-dialog p-0 gap-0 min-w-0 w-[min(30rem,calc(100vw-2rem))] sm:max-w-[30rem]">
        <div class="detail-panel">
          <div class="detail-header">
            <div>
              <span class={`confidence confidence--${selected.confidence}`}>
                {confidenceLabel(selected.confidence)}
              </span>
              <span class="source-label">{selected.sourceLabel}</span>
              <p>热点强度 <strong>{selected.heat}</strong></p>
            </div>
            <Button data-ui-owner="lib-pages-MarketHotspotsPage-svelte" variant="outline" class={"ui-button"} type="button" aria-label="关闭热点详情" onclick={closeDetails}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </Button>
          </div>

          <div class="detail-scroll">
            <h2>{selected.keyword}</h2>
            {#if selected.aliases.length > 0}
              <div class="aliases" aria-label="同义表达">
                {#each selected.aliases as alias}<span>{alias}</span>{/each}
              </div>
            {/if}
            <p class="explanation">{selected.explanation}</p>

            <section class="detail-section">
              <h3>资产传导</h3>
              <dl class="impact-grid">
                <div><dt>固收</dt><dd>{selected.assetImpacts.fixedIncome}</dd></div>
                <div><dt>权益</dt><dd>{selected.assetImpacts.equities}</dd></div>
              </dl>
            </section>

            {#if selected.conflicts.length > 0}
              <section class="detail-section conflict-section">
                <h3>证据冲突</h3>
                <ul class="conflict-list">
                  {#each selected.conflicts as conflict}<li>{conflict}</li>{/each}
                </ul>
              </section>
            {/if}

            <section class="detail-section">
              <h3>核心驱动</h3>
              <ul class="driver-list">
                {#each selected.drivers as driver}<li>{driver}</li>{/each}
              </ul>
            </section>

            <section class="detail-section">
              <h3>证据索引 <span>{selected.evidence.length}</span></h3>
              <ol class="evidence-list">
                {#each selected.evidence as evidence}
                  <li>
                    <span>{evidence.articleId}</span>
                    <p>{evidence.evidence}</p>
                  </li>
                {/each}
              </ol>
            </section>
          </div>
        </div>
        </Modal>
      {/if}
    {/if}
  </svelte:element>
</div>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  .hotspot-page {
    --ink: var(--text-1);
    --text-muted: var(--text-3);
    --line: var(--border-color);
    --surface: var(--bg-card);
    position: fixed;
    inset: 0;
    width: auto;
    height: auto;
    min-height: 600px;
    overflow: hidden;
    color: var(--ink);
    background: var(--bg-page);
  }

  .hotspot-page::before {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(color-mix(in srgb, var(--brand) 7%, transparent) 1px, transparent 1px),
      linear-gradient(90deg, color-mix(in srgb, var(--brand) 7%, transparent) 1px, transparent 1px);
    background-size: 48px 48px;
    mask-image: linear-gradient(to bottom, black, transparent 88%);
    content: "";
    pointer-events: none;
  }

  .hotspot-header {
    position: relative;
    z-index: 20;
    display: flex;
    height: 82px;
    align-items: center;
    justify-content: space-between;
    padding: 0 30px;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
    backdrop-filter: none;
  }

  .brand-block,
  .header-controls,
  .eyebrow,
  :global(.scope-button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]),
  :global(.regenerate-button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]),
  .summary-meta,
  .detail-header,
  .aliases {
    display: flex;
    align-items: center;
  }

  .brand-block {
    gap: 14px;
  }

  :global(.back-link[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]),
  :global(.detail-header button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]) {
    display: grid;
    width: 44px;
    height: 44px;
    padding: 0;
    place-items: center;
    border: 1px solid var(--line);
    border-radius: 10px;
    color: var(--text-2);
    background: var(--bg-page);
    cursor: pointer;
    transition:
      border-color 180ms ease,
      background 180ms ease,
      color 180ms ease;
  }

  :global(.back-link[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]:hover),
  :global(.back-link[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]:focus-visible),
  :global(.detail-header button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]:hover),
  :global(.detail-header button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]:focus-visible) {
    border-color: var(--brand);
    color: var(--text-1);
    background: var(--brand-soft);
    outline: 2px solid var(--brand-deep);
    outline-offset: 2px;
  }

  :global(.back-link[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"] svg),
  .detail-header svg,
  :global(.scope-button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"] svg),
  .scope-panel__header svg,
  :global(.regenerate-button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"] svg),
  .error-card svg {
    width: 22px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.8;
  }

  .eyebrow {
    gap: 7px;
    margin-bottom: 3px;
    color: var(--text-3);
    font-size: 0.875rem;
    font-weight: bold;
    letter-spacing: 0.16em;
  }

  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #6ed6bd;
    box-shadow: 0 0 0 5px rgba(110, 214, 189, 0.09);
  }

  h1,
  h2,
  h3,
  p {
    margin: 0;
  }

  h1 {
    font-size: 1.25rem;
    font-weight: bold;
    letter-spacing: 0.03em;
  }

  .header-controls {
    gap: 10px;
  }


  :global(.scope-button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]) {
    gap: 9px;
    padding: 0 13px;
    text-align: left;
  }

  :global(.scope-button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"] > span) {
    display: grid;
    gap: 1px;
    font-size: 0.875rem;
    font-weight: bold;
    white-space: nowrap;
  }

  .scope-label {
    color: var(--text-3);
    font-size: 0.75rem;
    font-weight: bold;
    letter-spacing: 0.08em;
  }


  .scope-panel {
    width: min(400px, calc(100vw - 32px));
    max-height: min(70dvh, var(--bits-popover-content-available-height));
    overflow-y: auto;
    padding: 18px;
  }

  .scope-panel__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
  }

  .scope-panel__header span {
    color: var(--text-3);
    font-size: 0.875rem;
    font-weight: bold;
    letter-spacing: 0.14em;
  }

  .scope-panel__header h2 {
    margin-top: 3px;
    font-size: 1.125rem;
  }

  :global(.scope-panel__header button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]) {
    display: grid;
    width: 36px;
    padding: 0;
    place-items: center;
  }


  .scope-field,
  .range-fields {
    display: grid;
  }

  .scope-field {
    gap: 7px;
    margin-top: 16px;
    color: var(--text-2);
    font-size: 0.875rem;
    font-weight: bold;
  }

  :global(.scope-field input[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]) {
    width: 100%;
    padding: 0 11px;
    font-weight: normal;
  }

  .number-field {
    position: relative;
  }

  :global(.number-field input[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]) {
    padding-right: 42px;
  }

  .number-field > span {
    position: absolute;
    top: 50%;
    right: 13px;
    color: var(--text-3);
    transform: translateY(-50%);
  }

  .range-fields {
    grid-template-columns: 1fr 1fr;
    gap: 0 10px;
  }

  :global(.apply-scope-button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]) {
    width: 100%;
    margin-top: 18px;
  }

  :global(.regenerate-button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]) {
    gap: 8px;
    padding: 0 16px;
  }

  :global(.regenerate-button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"] .spinning) {
    animation: spin 900ms linear infinite;
  }

  .hotspot-stage {
    position: relative;
    z-index: 2;
    height: calc(100dvh - 82px);
    min-height: 518px;
    overflow: hidden;
  }

  .cloud-panel,
  .cloud-canvas {
    width: 100%;
    height: 100%;
  }

  .cloud-panel {
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    gap: 8px;
    padding: 8px 24px 22px;
  }

  .market-summary {
    z-index: 4;
    display: flex;
    min-height: 78px;
    padding: 14px 18px;
    border: 1px solid var(--line);
    border-radius: var(--radius-card);
    background: var(--surface);
    box-shadow: var(--shadow-card);
    backdrop-filter: none;
  }

  .summary-heading {
    display: grid;
    width: 100%;
    min-width: 0;
    grid-template-columns: clamp(112px, 9vw, 176px) minmax(0, 1fr);
    align-items: stretch;
    gap: 18px;
  }

  .summary-heading > span {
    display: grid;
    border-radius: var(--radius-tag);
    background: var(--brand-soft);
    min-height: 48px;
    place-items: center;
    color: var(--brand-deep);
    font-size: 0.875rem;
    font-weight: bolder;
    line-height: 1.45;
    letter-spacing: 0.12em;
    text-align: center;
  }

  .summary-heading h2 {
    display: flex;
    min-width: 0;
    align-items: center;
    color: var(--text-1);
    font-size: 1rem;
    font-weight: normal;
    line-height: 1.65;
    overflow-wrap: anywhere;
    white-space: normal;
  }

  .summary-meta {
    position: relative;
    z-index: 4;
    justify-content: flex-end;
    min-height: 16px;
    padding-right: 2px;
    color: var(--text-3);
    font-size: 0.75rem;
    line-height: 1.5;
    font-variant-numeric: tabular-nums;
  }

  .cloud-canvas {
    min-height: 0;
  }


  .detail-panel {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: min(76dvh, 800px);
    min-height: 0;
    overflow: hidden;
    background: var(--surface);
  }

  .detail-header {
    min-height: 72px;
    flex: 0 0 auto;
    justify-content: space-between;
    padding: 13px 16px;
    border-bottom: 1px solid var(--line);
  }

  .detail-header > div {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .detail-header p {
    color: var(--text-muted);
    font-size: 1rem;
  }

  .detail-header p strong {
    margin-left: 4px;
    color: var(--color-warning-content);
    font-size: 1rem;
  }

  .confidence {
    padding: 4px 8px;
    border-radius: var(--radius-tag);
    font-size: 0.875rem;
    font-weight: bold;
  }

  .source-label {
    padding: 4px 8px;
    border: 1px solid var(--line);
    border-radius: var(--radius-tag);
    color: var(--text-3);
    font-size: 0.875rem;
    font-weight: bold;
  }

  .confidence--high {
    color: var(--color-success-content);
    background: var(--color-success);
  }

  .confidence--medium {
    color: var(--color-info-content);
    background: var(--color-info);
  }

  .confidence--low {
    color: var(--business-purple);
    background: color-mix(in srgb, var(--business-purple) 8%, var(--surface));
  }

  .detail-scroll {
    flex: 1;
    min-height: 0;
    padding: 22px 20px 32px;
    overflow-y: auto;
    scrollbar-color: var(--border-strong) transparent;
    scrollbar-width: thin;
  }

  .detail-scroll > h2 {
    color: var(--text-1);
    font-size: 1.5rem;
    font-weight: bolder;
    line-height: 1.2;
    letter-spacing: -0.02em;
  }

  .aliases {
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }

  .aliases span {
    padding: 3px 7px;
    border: 1px solid var(--line);
    border-radius: var(--radius-tag);
    color: var(--brand-deep);
    font-size: 0.875rem;
  }

  .explanation {
    margin-top: 20px;
    color: var(--text-2);
    font-size: 1rem;
    line-height: 1.82;
  }

  .detail-section {
    margin-top: 26px;
    padding-top: 18px;
    border-top: 1px solid var(--line);
  }

  .detail-section h3 {
    margin-bottom: 12px;
    color: var(--text-2);
    font-size: 1rem;
    font-weight: bold;
    letter-spacing: 0.13em;
  }

  .detail-section h3 span {
    margin-left: 4px;
    color: var(--color-warning-content);
  }

  .impact-grid {
    display: grid;
    gap: 9px;
    margin: 0;
  }

  .impact-grid div {
    display: grid;
    grid-template-columns: 66px 1fr;
    gap: 10px;
    padding: 10px 11px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg-page);
  }

  .impact-grid dt {
    color: var(--brand-deep);
    font-size: 0.875rem;
    font-weight: bold;
  }

  .impact-grid dd {
    margin: 0;
    color: var(--text-2);
    font-size: 1rem;
    line-height: 1.65;
  }

  .driver-list,
  .conflict-list,
  .evidence-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .driver-list {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
  }

  .driver-list li {
    padding: 6px 9px;
    border-radius: 6px;
    color: var(--color-warning-content);
    background: var(--color-warning);
    font-size: 0.875rem;
  }

  .conflict-list {
    display: grid;
    gap: 8px;
  }

  .conflict-list li {
    padding: 9px 11px;
    border-left: 2px solid var(--color-error-content);
    color: var(--color-error-content);
    background: var(--color-error);
    font-size: 0.875rem;
    line-height: 1.65;
  }

  .evidence-list {
    display: grid;
    gap: 10px;
  }

  .evidence-list li {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 5px;
    padding: 11px 12px;
    border-left: 1px solid var(--line);
    background: var(--bg-page);
  }

  .evidence-list span {
    min-width: 0;
    color: var(--brand-deep);
    font-size: 0.75rem;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }

  .evidence-list p {
    min-width: 0;
    color: var(--text-2);
    font-size: 1rem;
    line-height: 1.65;
  }

  .state-card {
    position: absolute;
    top: 50%;
    left: 50%;
    display: flex;
    width: min(480px, calc(100vw - 32px));
    min-height: 130px;
    align-items: center;
    gap: 18px;
    padding: 24px;
    border: 1px solid var(--line);
    border-radius: var(--radius-card);
    background: var(--surface);
    box-shadow: var(--shadow-card);
    transform: translate(-50%, -50%);
  }

  .state-card strong {
    font-size: 1rem;
  }

  .state-card p {
    margin-top: 7px;
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .loading-ring {
    width: 38px;
    height: 38px;
    flex: 0 0 auto;
    border: 2px solid rgba(119, 189, 251, 0.2);
    border-top-color: var(--brand);
    border-radius: 50%;
    animation: spin 900ms linear infinite;
  }

  .error-card {
    flex-wrap: wrap;
  }

  .error-card > svg {
    width: 32px;
    color: var(--color-error-content);
  }

  .error-card > div {
    flex: 1;
  }

  :global(.error-card button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]) {
    padding: 0 13px;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }


  @media (max-width: 860px) {
    .hotspot-page {
      min-height: 520px;
    }

    .hotspot-header {
      height: auto;
      min-height: 76px;
      padding: 10px 14px;
    }

    .eyebrow,
    .scope-label {
      display: none;
    }

    h1 {
      font-size: 1.125rem;
    }

    .brand-block {
      gap: 9px;
    }

    :global(.scope-button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]) {
      padding: 0 9px;
    }

    :global(.scope-button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"] > span) {
      font-size: 0.875rem;
    }


    :global(.regenerate-button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]) {
      width: 44px;
      padding: 0;
      justify-content: center;
    }

    :global(.regenerate-button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"] span) {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
    }

    .hotspot-stage {
      height: calc(100dvh - 76px);
      min-height: 444px;
    }

    .market-summary {
      padding: 11px 12px;
    min-height: 78px;
    }

    .summary-heading {
      grid-template-columns: 82px minmax(0, 1fr);
      gap: 10px;
    }

    .summary-heading h2 {
      font-size: 1rem;
      line-height: 1.55;
    }

    .summary-meta {
      font-size: 0.75rem;
    }

    .cloud-panel {
      gap: 6px;
      padding: 6px 10px 12px;
    }


    .detail-scroll {
      max-height: calc(min(74dvh, 660px) - 72px);
    }
  }

  @media (max-width: 520px) {
    .hotspot-header {
      gap: 8px;
      min-height: 76px;
    }

    :global(.back-link[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]) {
      width: 40px;
      height: 40px;
    }

    .header-controls {
      gap: 6px;
    }

    .summary-heading {
      grid-template-columns: 68px minmax(0, 1fr);
      gap: 8px;
    }

    .impact-grid div {
      grid-template-columns: 58px 1fr;
    }
  }


  @media (prefers-reduced-motion: reduce) {
    :global(.regenerate-button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"] .spinning),
    .loading-ring {
      animation-duration: 1.8s;
    }

    .detail-panel,
    :global(.back-link[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]),
    :global(.scope-button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]),
    .scope-panel,
    :global(.regenerate-button[data-ui-owner="lib-pages-MarketHotspotsPage-svelte"]) {
      transition: none;
      animation: none;
    }
  }

  .hotspot-page--embedded { position: relative; inset: auto; width: 100%; height: 100%; min-height: 600px; }
  .hotspot-page--embedded .hotspot-header { justify-content: flex-end; height: 82px; }
  .hotspot-page--embedded .hotspot-stage { height: calc(100% - 82px); }
  .hotspot-page--embedded .state-card { width: min(480px, calc(100% - 32px)); }

  @media (max-width: 860px) {
    .hotspot-page--embedded .detail-scroll { max-height: none; }
  }
  @media (max-width: 520px) {
    .hotspot-page--embedded { height: auto; min-height: 100%; }
    .hotspot-page--embedded .hotspot-stage { height: auto; min-height: 0; }
    .hotspot-page--embedded .cloud-panel { height: auto; grid-template-rows: auto auto 360px; }
    .range-fields { grid-template-columns: minmax(0, 1fr); }
    .summary-heading { grid-template-columns: minmax(0, 1fr); }
    .summary-heading > span { justify-self: start; min-height: 32px; padding: 4px 12px; letter-spacing: 0; }
  }
  @media (min-width: 901px) {
    :global(.hotspot-detail-dialog) { width: 42rem; max-width: calc(100vw - 3rem); }
    .detail-section { margin-top: 20px; padding-top: 14px; }
    .explanation { margin-top: 16px; }
  }
</style>
