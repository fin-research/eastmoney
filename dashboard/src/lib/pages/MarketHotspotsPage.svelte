<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import ChartHost from "../../components/ChartHost.svelte";
  import {
    focusKnowledgeNode,
    KIND_STYLE,
    renderKnowledgeGraph,
    resetKnowledgeGraphView,
    zoomKnowledgeGraph,
    type GraphView,
  } from "../../charts/knowledge-graph";
  import TimeRangeSlider from "$lib/components/TimeRangeSlider.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { isAiRequestCancelled } from "$lib/ai-client.svelte";
  import {
    describeChain,
    MOVE_GLYPH,
    tracePaths,
    type KgDay,
    type KgEdge,
    type KnowledgeGraphResponse,
  } from "$lib/knowledge-graph";

  const DEFAULT_DAYS = 14;
  const MIN_DOMAIN = 14;
  const HOT_NODES = 8;
  const LISTED_EDGES = 6;
  const REPLAY_MS = 1600;

  let graph = $state.raw<KnowledgeGraphResponse | null>(null);
  let domain = $state.raw<KgDay[]>([]);
  let range = $state({ from: 0, to: 0 });
  let loading = $state(true);
  let errorMessage = $state("");
  let node = $state("");
  let edgeIndex = $state<number | null>(null);
  let chainIndex = $state<number | null>(null);
  let query = $state("");
  let playing = $state(false);
  let host: HTMLElement | undefined;
  let request: AbortController | null = null;
  let replay: ReturnType<typeof setInterval> | undefined;
  const wired = new WeakSet<object>();

  const view = $derived<GraphView>({ node, edge: edgeIndex, chain: chainIndex });
  const labels = $derived(new Map((graph?.nodes ?? []).map((item) => [item.key, item.label])));
  const label = (key: string): string => labels.get(key) ?? key;
  const hot = $derived([...(graph?.nodes ?? [])].sort((a, b) => b.articleCount - a.articleCount).slice(0, HOT_NODES));
  const hotMax = $derived(Math.max(1, ...hot.map((item) => item.articleCount)));
  const selectedNode = $derived(graph?.nodes.find((item) => item.key === node) ?? null);
  const selectedEdge = $derived(graph && edgeIndex !== null ? (graph.edges[edgeIndex] ?? null) : null);
  const traced = $derived(graph && node ? tracePaths(graph, node) : null);
  const matches = $derived.by(() => {
    const text = query.trim().toLowerCase();
    if (!text || !graph) return [];
    return graph.nodes.filter((item) => item.label.toLowerCase().includes(text)).slice(0, 6);
  });

  function neighbours(direction: "up" | "down"): Array<{ index: number; edge: KgEdge }> {
    if (!graph || !node) return [];
    return graph.edges
      .map((edge, index) => ({ index, edge }))
      .filter(({ edge }) => (direction === "up" ? edge.target === node : edge.source === node))
      .slice(0, LISTED_EDGES);
  }
  const upstream = $derived(neighbours("up"));
  const downstream = $derived(neighbours("down"));

  onMount(() => void load({ days: DEFAULT_DAYS }));
  onDestroy(() => {
    request?.abort();
    stopReplay();
  });

  async function load(window: { days: number } | { start: string; end: string }): Promise<void> {
    request?.abort();
    const mine = new AbortController();
    request = mine;
    loading = true;
    errorMessage = "";
    try {
      const params = new URLSearchParams("days" in window ? { days: String(window.days) } : window);
      const response = await fetch(`/api/rag/knowledge-graph?${params}`, {
        signal: mine.signal,
        headers: { Accept: "application/json" },
      });
      const payload = (await response.json()) as KnowledgeGraphResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error || "传导图读取失败");
      graph = payload;
      if (domain.length === 0) setDomain(payload);
      edgeIndex = null;
      chainIndex = null;
      if (node && !payload.nodes.some((item) => item.key === node)) node = "";
    } catch (error) {
      if (!isAiRequestCancelled(error)) {
        errorMessage = error instanceof Error ? error.message : String(error);
        stopReplay();
      }
    } finally {
      if (request === mine) loading = false;
    }
  }

  /** The slider covers the days from the first claim to today, never fewer than two weeks. */
  function setDomain(payload: KnowledgeGraphResponse): void {
    const timeline = payload.timeline;
    if (timeline.length === 0) return;
    const first = timeline.findIndex((day) => day.claims > 0);
    const start = Math.min(first < 0 ? timeline.length - MIN_DOMAIN : first, timeline.length - MIN_DOMAIN);
    domain = timeline.slice(Math.max(0, start));
    const from = domain.findIndex((day) => day.date === payload.window.start);
    const to = domain.findIndex((day) => day.date === payload.window.end);
    range = { from: Math.max(0, from), to: to < 0 ? domain.length - 1 : to };
  }

  function commit(from: number, to: number): void {
    range = { from, to };
    const start = domain[from]?.date;
    const end = domain[to]?.date;
    if (start && end) void load({ start, end });
  }

  function reload(): void {
    if (domain.length > 0) commit(range.from, range.to);
    else void load({ days: DEFAULT_DAYS });
  }

  function stopReplay(): void {
    clearInterval(replay);
    replay = undefined;
    playing = false;
  }

  function toggleReplay(): void {
    if (playing) return stopReplay();
    if (domain.length === 0) return;
    playing = true;
    if (range.to >= domain.length - 1) commit(0, range.to - range.from);
    replay = setInterval(() => {
      if (loading) return;
      if (range.to >= domain.length - 1) return stopReplay();
      commit(range.from + 1, range.to + 1);
    }, REPLAY_MS);
  }

  function wire(chart: ReturnType<typeof import("../../charts/charting").getChart> & object, element: HTMLElement): void {
    host = element;
    if (wired.has(chart)) return;
    wired.add(chart);
    chart.on("click", (params) => {
      const id = (params.data as { id?: string } | null)?.id;
      if (params.dataType === "node" && id) toggleNode(id);
      else if (params.dataType === "edge") toggleEdge(params.dataIndex);
    });
    chart.getZr().on("click", (event: { target?: unknown }) => {
      if (!event.target) clearSelection();
    });
  }

  function clearSelection(): void {
    node = "";
    edgeIndex = null;
    chainIndex = null;
  }

  function toggleNode(key: string): void {
    node = node === key && edgeIndex === null && chainIndex === null ? "" : key;
    edgeIndex = null;
    chainIndex = null;
  }

  function toggleEdge(index: number): void {
    edgeIndex = edgeIndex === index ? null : index;
    chainIndex = null;
    node = "";
  }

  function toggleChain(index: number): void {
    chainIndex = chainIndex === index ? null : index;
    edgeIndex = null;
    node = "";
  }

  function pick(key: string): void {
    query = "";
    chainIndex = null;
    edgeIndex = null;
    node = key;
    if (host && graph) focusKnowledgeNode(host, key, graph);
  }

  function formatTime(value: string): string {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }

  const edgeText = (edge: KgEdge): string =>
    `${label(edge.source)}${MOVE_GLYPH[edge.sourceMove]} → ${label(edge.target)}${MOVE_GLYPH[edge.effectMove]}`;
</script>

<section class="hotspot-page hotspot-page--embedded" aria-label="市场热点传导图">
  <div class="stage">
    <div class="stage-graph">
      {#if graph && graph.edges.length > 0}
        <ChartHost
          renderer={renderKnowledgeGraph}
          args={[graph, view]}
          onready={wire}
          ariaLabel="研报因果传导图，节点大小表示研报出现次数"
          className="graph-chart"
        />
        <div class="graph-stats" aria-live="polite">
          {graph.coverage.claimCount} 条主张 · {graph.nodes.length} 个节点{graph.coverage.truncated ? " · 已截断" : ""}
        </div>
        <div class="graph-zoom" role="group" aria-label="缩放">
          <Button variant="outline" class="ui-button graph-zoom-button" type="button" aria-label="放大"
            onclick={() => host && zoomKnowledgeGraph(host, 1.35)}>+</Button>
          <Button variant="outline" class="ui-button graph-zoom-button" type="button" aria-label="缩小"
            onclick={() => host && zoomKnowledgeGraph(host, 1 / 1.35)}>−</Button>
          <Button variant="outline" class="ui-button graph-zoom-button" type="button" aria-label="复位"
            onclick={() => host && resetKnowledgeGraphView(host)}>⤢</Button>
        </div>
      {/if}

      {#if errorMessage}
        <div class="graph-state" role="alert">
          <p>{errorMessage}</p>
          <Button variant="outline" class="ui-button" type="button" onclick={reload}>重新读取</Button>
        </div>
      {:else if graph && graph.edges.length === 0 && !loading}
        <p class="graph-state">所选时间范围内暂无因果传导数据</p>
      {:else if loading}
        <p class="graph-state graph-state--loading" aria-live="polite">正在读取传导图</p>
      {/if}
    </div>

    {#if domain.length > 0}
      <div class="stage-range">
        <Button variant="outline" class="ui-button replay" type="button" aria-pressed={playing} onclick={toggleReplay}>
          {playing ? "暂停" : "回放"}
        </Button>
        <div class="stage-slider">
          <TimeRangeSlider days={domain} from={range.from} to={range.to} onchange={commit} />
        </div>
      </div>
    {/if}
  </div>

  <aside class="side" aria-label="节点与传导链">
    <div class="side-search">
      <input
        class="search-input"
        type="search"
        placeholder="搜索节点"
        aria-label="搜索节点"
        autocomplete="off"
        bind:value={query}
        onkeydown={(event) => {
          if (event.key === "Enter" && matches[0]) pick(matches[0].key);
        }}
      />
      {#if matches.length > 0}
        <ul class="search-results" aria-label="搜索结果">
          {#each matches as item (item.key)}
            <li>
              <Button variant="ghost" class="ui-button search-result" type="button" onclick={() => pick(item.key)}>
                <span class="swatch" style:background={KIND_STYLE[item.kind].color}></span>{item.label}
                <span class="count">{item.articleCount}</span>
              </Button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    {#if selectedNode && traced}
      <section class="panel" aria-label="节点详情">
        <h2>
          <span class="swatch" style:background={KIND_STYLE[selectedNode.kind].color}></span>{selectedNode.label}
          <span class="count">{selectedNode.articleCount} 篇</span>
        </h2>
        <p class="meta">
          {KIND_STYLE[selectedNode.kind].name} · 上游 {traced.upstream.size} 条 · 下游 {traced.downstream.size} 条传导路径
        </p>
        {#if upstream.length > 0}
          <h3>上游</h3>
          <ul class="rows">
            {#each upstream as { index, edge } (index)}
              <li>
                <Button variant="ghost" class="ui-button row" type="button" onclick={() => toggleEdge(index)}>
                  {edgeText(edge)}<span class="count">{edge.articleIds.length}</span>
                </Button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if downstream.length > 0}
          <h3>下游</h3>
          <ul class="rows">
            {#each downstream as { index, edge } (index)}
              <li>
                <Button variant="ghost" class="ui-button row" type="button" onclick={() => toggleEdge(index)}>
                  {edgeText(edge)}<span class="count">{edge.articleIds.length}</span>
                </Button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}

    {#if selectedEdge}
      <section class="panel" aria-label="边的研报主张">
        <h2>
          {edgeText(selectedEdge)}
          {#if selectedEdge.contested}<span class="conflict">多空冲突</span>{/if}
        </h2>
        <ul class="claims">
          {#each selectedEdge.claims as claim, claimIndex (`${claim.articleId}|${claimIndex}`)}
            <li>
              <span class="meta">{claim.basis === "observed" ? "已发生" : "预期"} · {claim.author || "未署名"} · {formatTime(claim.publishedAt)}</span>
              <strong>{claim.title}</strong>
              <p>{claim.mechanism}</p>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if hot.length > 0}
      <section class="panel" aria-label="热点节点">
        <h2>热点</h2>
        <ol class="rows">
          {#each hot as item (item.key)}
            <li>
              <Button variant="ghost" class="ui-button row" type="button" aria-pressed={node === item.key}
                onclick={() => pick(item.key)}>
                <span class="swatch" style:background={KIND_STYLE[item.kind].color}></span>
                <span class="row-label">{item.label}</span>
                <span class="heat" style:--heat={`${(item.articleCount / hotMax) * 100}%`}></span>
                <span class="count">{item.articleCount}</span>
              </Button>
            </li>
          {/each}
        </ol>
      </section>
    {/if}

    {#if graph && graph.chains.length > 0}
      <section class="panel" aria-label="传导链">
        <h2>传导链 <span class="count">{graph.chains.length}</span></h2>
        <ol class="rows">
          {#each graph.chains as chain, index (index)}
            <li>
              <Button variant="ghost" class="ui-button row row--chain" type="button" aria-pressed={chainIndex === index}
                onclick={() => toggleChain(index)}>{describeChain(graph, chain)}</Button>
            </li>
          {/each}
        </ol>
      </section>
    {/if}
  </aside>
</section>

<style>
  .hotspot-page {
    display: grid;
    width: 100%;
    height: 100%;
    min-height: 620px;
    grid-template-columns: minmax(0, 1fr) 22rem;
    gap: 14px;
    padding: 14px 24px 18px;
    color: var(--text-1);
    background: var(--bg-page);
  }

  .stage {
    display: grid;
    min-width: 0;
    min-height: 0;
    grid-template-rows: minmax(0, 1fr) auto;
    overflow: hidden;
    border: 1px solid #1c2a44;
    border-radius: var(--radius-card);
    background:
      radial-gradient(120% 90% at 50% 0%, #14213d 0%, #0b1220 62%),
      #0b1220;
    box-shadow: var(--shadow-card);
    color: #e6edf7;
  }

  .stage-graph {
    position: relative;
    min-height: 0;
  }

  :global(.graph-chart) {
    position: absolute;
    inset: 0;
  }

  .graph-stats {
    position: absolute;
    bottom: 12px;
    left: 14px;
    color: #8b9ab3;
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }

  .graph-zoom {
    position: absolute;
    right: 14px;
    bottom: 12px;
    display: grid;
    gap: 6px;
  }

  :global(.graph-zoom-button),
  :global(.replay) {
    min-width: 44px;
    min-height: 44px;
    border-color: #2a3753;
    background: rgba(15, 23, 42, 0.8);
    color: #e6edf7;
    font-size: 1.125rem;
  }

  :global(.graph-zoom-button:hover),
  :global(.replay:hover),
  :global(.replay[aria-pressed="true"]) {
    border-color: #5b9dff;
    background: rgba(91, 157, 255, 0.18);
    color: #ffffff;
  }

  :global(.replay) {
    font-size: 0.875rem;
  }

  .graph-state {
    position: absolute;
    inset: 0;
    display: grid;
    align-content: center;
    justify-items: center;
    gap: 10px;
    margin: 0;
    color: #c4cfe2;
    font-size: 1rem;
    pointer-events: none;
  }

  .graph-state :global(button) {
    pointer-events: auto;
  }

  .graph-state--loading {
    align-content: start;
    padding-top: 14px;
    color: #8b9ab3;
  }

  .stage-range {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 6px;
    padding-left: 14px;
    border-top: 1px solid #1c2a44;
  }

  .stage-slider {
    min-width: 0;
    padding-right: 14px;
  }

  .side {
    display: grid;
    align-content: start;
    gap: 12px;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
  }

  .search-input {
    width: 100%;
    min-height: 44px;
    padding: 0 16px;
    border: 1px solid var(--border-color);
    border-radius: 999px;
    background: var(--bg-card);
    color: var(--text-1);
    font-size: 1rem;
  }

  .search-results {
    display: grid;
    margin: 4px 0 0;
    padding: 4px;
    list-style: none;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-card);
    background: var(--bg-card);
    box-shadow: var(--shadow-card);
  }

  .panel {
    padding: 12px 14px;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-card);
    background: var(--bg-card);
    box-shadow: var(--shadow-card);
  }

  .panel h2 {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0 0 6px;
    font-size: 1.125rem;
  }

  .panel h3 {
    margin: 10px 0 4px;
    color: var(--text-2);
    font-size: 0.875rem;
  }

  .meta {
    margin: 0 0 4px;
    color: var(--text-3);
    font-size: 0.875rem;
  }

  .count {
    margin-left: auto;
    color: var(--text-3);
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
    font-weight: normal;
  }

  .swatch {
    display: inline-block;
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }

  .rows,
  .claims {
    display: grid;
    margin: 0;
    padding: 0;
    gap: 2px;
    list-style: none;
  }

  :global(.row),
  :global(.search-result) {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 44px;
    padding: 6px 10px;
    text-align: left;
    white-space: normal;
    font-size: 1rem;
  }

  :global(.row[aria-pressed="true"]) {
    background: var(--brand-soft);
  }

  .row-label {
    min-width: 0;
    flex: 0 1 auto;
  }

  .heat {
    flex: 1;
    height: 6px;
    min-width: 24px;
    border-radius: 3px;
    background: linear-gradient(90deg, var(--brand-deep) var(--heat), var(--border-color) var(--heat));
  }

  .claims li {
    display: grid;
    gap: 2px;
    padding: 6px 0;
    border-top: 1px solid var(--border-color);
  }

  .claims li:first-child {
    border-top: 0;
  }

  .claims p {
    margin: 0;
    color: var(--text-2);
    font-size: 1rem;
    line-height: 1.55;
  }

  .conflict {
    color: var(--color-error-content);
    font-size: 0.875rem;
  }

  @media (max-width: 960px) {
    .hotspot-page {
      height: auto;
      min-height: 100%;
      grid-template-columns: minmax(0, 1fr);
      padding: 10px;
    }

    .stage {
      grid-template-rows: 62dvh auto;
    }

    .side {
      overflow: visible;
    }
  }
</style>
