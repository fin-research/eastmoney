<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import CausalGraph from "$lib/components/CausalGraph.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { isAiRequestCancelled } from "$lib/ai-client.svelte";
  import { describeChain, MOVE_GLYPH, type KnowledgeGraphResponse } from "$lib/knowledge-graph";

  const WINDOWS = [7, 14, 30] as const;
  const HOT_NODES = 12;

  let days = $state<(typeof WINDOWS)[number]>(14);
  let graph = $state<KnowledgeGraphResponse | null>(null);
  let loading = $state(true);
  let errorMessage = $state("");
  let focusKey = $state("");
  let selectedEdge = $state<number | null>(null);
  let selectedChain = $state<number | null>(null);
  let request: AbortController | null = null;

  const hotNodes = $derived(graph?.nodes.slice(0, HOT_NODES) ?? []);
  const chainEdges = $derived(
    graph && selectedChain !== null ? new Set(graph.chains[selectedChain]?.edges ?? []) : null,
  );
  const edge = $derived(graph && selectedEdge !== null ? (graph.edges[selectedEdge] ?? null) : null);
  const nodeLabel = (key: string): string => graph?.nodes.find((node) => node.key === key)?.label ?? key;

  onMount(() => void load());
  onDestroy(() => request?.abort());

  async function load(): Promise<void> {
    request?.abort();
    const mine = new AbortController();
    request = mine;
    loading = true;
    errorMessage = "";
    focusKey = "";
    selectedEdge = null;
    selectedChain = null;
    try {
      const response = await fetch(`/api/rag/knowledge-graph?days=${days}`, {
        signal: mine.signal,
        headers: { Accept: "application/json" },
      });
      const payload = (await response.json()) as KnowledgeGraphResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error || "传导图读取失败");
      graph = payload;
    } catch (error) {
      if (!isAiRequestCancelled(error)) {
        graph = null;
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (request === mine) loading = false;
    }
  }

  function selectDays(value: (typeof WINDOWS)[number]): void {
    if (value === days) return;
    days = value;
    void load();
  }

  function toggleNode(key: string): void {
    focusKey = focusKey === key ? "" : key;
    selectedChain = null;
  }

  function toggleChain(index: number): void {
    selectedChain = selectedChain === index ? null : index;
    focusKey = "";
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
</script>

<section class="hotspot-page hotspot-page--embedded" aria-label="市场热点传导图">
  <div class="graph-toolbar">
    <div class="graph-windows" role="group" aria-label="时间窗">
      {#each WINDOWS as value (value)}
        <Button variant="outline" class="ui-button graph-window" type="button" aria-pressed={days === value}
          onclick={() => selectDays(value)}>近 {value} 天</Button>
      {/each}
    </div>
    {#if graph}
      <span class="graph-counts">
        {graph.coverage.claimCount} 条主张 · {graph.coverage.claimArticleCount}/{graph.coverage.articleCount} 篇{graph.coverage.truncated ? " · 已截断" : ""}
      </span>
    {/if}
  </div>

  {#if loading}
    <p class="graph-state" aria-live="polite">正在读取传导图</p>
  {:else if errorMessage}
    <div class="graph-state" role="alert">
      <p>{errorMessage}</p>
      <Button variant="outline" class="ui-button" type="button" onclick={() => void load()}>重新读取</Button>
    </div>
  {:else if graph}
    {#if graph.edges.length === 0}
      <p class="graph-state">所选时间窗内暂无因果传导数据</p>
    {:else}
      <div class="graph-chips" role="group" aria-label="热点节点">
        {#each hotNodes as node (node.key)}
          <Button variant="outline" class="ui-button graph-chip" type="button" aria-pressed={focusKey === node.key}
            onclick={() => toggleNode(node.key)}>{node.label}</Button>
        {/each}
      </div>

      <div class="graph-body">
        <CausalGraph {graph} {focusKey} {chainEdges} {selectedEdge}
          onSelectEdge={(index) => (selectedEdge = index)} onSelectNode={toggleNode} />
      </div>

      <div class="graph-side">
        {#if graph.chains.length > 0}
          <section class="graph-chains" aria-label="传导链">
            <h2>传导链 <span>{graph.chains.length}</span></h2>
            <ol>
              {#each graph.chains as chain, index (index)}
                <li>
                  <Button variant="ghost" class="ui-button graph-chain" type="button" aria-pressed={selectedChain === index}
                    onclick={() => toggleChain(index)}>{describeChain(graph, chain)}</Button>
                </li>
              {/each}
            </ol>
          </section>
        {/if}

        {#if edge}
          <section class="graph-claims" aria-label="边的研报主张">
            <h2>{nodeLabel(edge.source)}{MOVE_GLYPH[edge.sourceMove]} → {nodeLabel(edge.target)}{MOVE_GLYPH[edge.effectMove]}
              {#if edge.contested}<span class="graph-conflict">多空冲突</span>{/if}
            </h2>
            <ul>
              {#each edge.claims as claim, claimIndex (`${claim.articleId}|${claimIndex}`)}
                <li>
                  <span class="graph-claim-meta">{claim.basis === "observed" ? "已发生" : "预期"} · {claim.author || "未署名"} · {formatTime(claim.publishedAt)}</span>
                  <strong>{claim.title}</strong>
                  <p>{claim.mechanism}</p>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
      </div>
    {/if}
  {/if}
</section>

<style>
  .hotspot-page {
    position: relative;
    display: grid;
    width: 100%;
    height: 100%;
    min-height: 600px;
    grid-template-rows: auto auto minmax(0, 1fr) auto;
    gap: 10px;
    padding: 14px 24px 18px;
    color: var(--text-1);
    background: var(--bg-page);
  }

  .graph-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
  }

  .graph-windows,
  .graph-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  :global(.graph-window),
  :global(.graph-chip) {
    min-height: 44px;
    padding: 0 14px;
    font-size: 0.875rem;
  }

  :global(.graph-window[aria-pressed="true"]),
  :global(.graph-chip[aria-pressed="true"]) {
    border-color: var(--brand-deep);
    background: var(--brand-soft);
    color: var(--text-1);
  }

  .graph-counts {
    color: var(--text-2);
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
  }

  .graph-state {
    grid-row: 2 / -1;
    display: grid;
    align-self: center;
    justify-items: center;
    gap: 10px;
    color: var(--text-2);
    font-size: 1rem;
  }

  .graph-body {
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-card);
    background: var(--bg-card);
    box-shadow: var(--shadow-card);
  }

  .graph-side {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
    gap: 12px;
    max-height: 34dvh;
    overflow-y: auto;
  }

  .graph-side h2 {
    margin: 0 0 6px;
    font-size: 1rem;
  }

  .graph-side h2 span {
    color: var(--text-3);
    font-size: 0.875rem;
    font-weight: normal;
  }

  .graph-chains ol,
  .graph-claims ul {
    display: grid;
    margin: 0;
    padding: 0;
    gap: 6px;
    list-style: none;
  }

  :global(.graph-chain) {
    display: block;
    min-height: 44px;
    width: 100%;
    padding: 6px 10px;
    text-align: left;
    white-space: normal;
    font-size: 1rem;
  }

  :global(.graph-chain[aria-pressed="true"]) {
    background: var(--brand-soft);
  }

  .graph-claims li {
    display: grid;
    gap: 2px;
  }

  .graph-claim-meta {
    color: var(--text-3);
    font-size: 0.75rem;
  }

  .graph-claims p {
    margin: 0;
    color: var(--text-2);
    font-size: 1rem;
    line-height: 1.55;
  }

  .graph-conflict {
    margin-left: 8px;
    color: var(--color-error-content);
    font-size: 0.875rem;
  }

  @media (max-width: 520px) {
    .hotspot-page {
      height: auto;
      min-height: 100%;
      padding: 10px;
    }

    .graph-body {
      height: 360px;
    }
  }
</style>
