<script lang="ts">
  import { layoutGraph } from "$lib/graph-layout";
  import { MOVE_GLYPH, type KgEdge, type KnowledgeGraphResponse } from "$lib/knowledge-graph";

  interface Props {
    graph: KnowledgeGraphResponse;
    highlightArticleIds?: Set<string>;
    selectedEdge?: number | null;
    onSelectEdge: (index: number | null) => void;
  }

  const MAX_EDGES = 40;

  let { graph, highlightArticleIds = new Set<string>(), selectedEdge = null, onSelectEdge }: Props = $props();

  const edges = $derived(graph.edges.slice(0, MAX_EDGES));
  const nodeKeys = $derived(new Set(edges.flatMap((edge) => [edge.source, edge.target])));
  const nodes = $derived(graph.nodes.filter((node) => nodeKeys.has(node.key)));
  const layout = $derived(layoutGraph(nodes, edges));
  const labels = $derived(new Map(nodes.map((node) => [node.key, node.label])));
  const maxWeight = $derived(Math.max(0.0001, ...edges.map((edge) => edge.weight)));
  const highlighting = $derived(highlightArticleIds.size > 0);

  function isHighlighted(edge: KgEdge): boolean {
    return edge.articleIds.some((id) => highlightArticleIds.has(id));
  }

  function path(edge: KgEdge): string {
    const from = layout.nodes.get(edge.source);
    const to = layout.nodes.get(edge.target);
    if (!from || !to) return "";
    const forward = to.x > from.x;
    const startX = forward ? from.x + layout.nodeWidth : from.x;
    const endX = forward ? to.x : to.x + layout.nodeWidth;
    const startY = from.y + layout.nodeHeight / 2;
    const endY = to.y + layout.nodeHeight / 2;
    const bend = forward ? (endX - startX) / 2 : 72;
    const sign = forward ? 1 : to.x === from.x ? 1 : -1;
    return `M${startX} ${startY} C${startX + bend * sign} ${startY} ${endX - bend * sign} ${endY} ${endX} ${endY}`;
  }

  function midpoint(edge: KgEdge): { x: number; y: number } {
    const from = layout.nodes.get(edge.source);
    const to = layout.nodes.get(edge.target);
    if (!from || !to) return { x: 0, y: 0 };
    return {
      x: (from.x + to.x + layout.nodeWidth) / 2 + (to.x > from.x ? 0 : layout.nodeWidth / 2),
      y: (from.y + to.y + layout.nodeHeight) / 2,
    };
  }

  function strokeWidth(edge: KgEdge): number {
    return 1.2 + (edge.weight / maxWeight) * 4.2;
  }

  function edgeLabel(edge: KgEdge): string {
    const source = labels.get(edge.source) ?? edge.source;
    const target = labels.get(edge.target) ?? edge.target;
    const status = edge.contested ? "，多空冲突" : "";
    return `${source}${MOVE_GLYPH[edge.sourceMove]} 传导至 ${target}${MOVE_GLYPH[edge.effectMove]}，${edge.articleIds.length} 篇研报${status}`;
  }

  function activate(event: KeyboardEvent, index: number): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelectEdge(selectedEdge === index ? null : index);
  }
</script>

<div class="causal-graph">
  <svg
    viewBox={`0 0 ${layout.width} ${layout.height}`}
    width={layout.width}
    height={layout.height}
    role="group"
    aria-label="研报因果传导图"
  >
    <defs>
      <marker id="causal-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" orient="auto">
        <path d="M0 0 10 5 0 10z" fill="context-stroke" />
      </marker>
    </defs>

    {#each edges as edge, index (`${edge.source}|${edge.sourceMove}|${edge.target}|${edge.effectMove}`)}
      {@const lit = isHighlighted(edge)}
      {@const mid = midpoint(edge)}
      <g
        class="edge"
        class:contested={edge.contested}
        class:expected={edge.observed === 0}
        class:thin={edge.authorCount < 2}
        class:selected={selectedEdge === index}
        class:dim={highlighting && !lit}
        role="button"
        tabindex="0"
        aria-pressed={selectedEdge === index}
        aria-label={edgeLabel(edge)}
        onclick={() => onSelectEdge(selectedEdge === index ? null : index)}
        onkeydown={(event) => activate(event, index)}
      >
        <path class="hit" d={path(edge)} />
        <path class="line" d={path(edge)} stroke-width={strokeWidth(edge)} marker-end="url(#causal-arrow)" />
        <text class="move" x={mid.x} y={mid.y - 6} text-anchor="middle">
          {MOVE_GLYPH[edge.sourceMove]}→{MOVE_GLYPH[edge.effectMove]}
        </text>
      </g>
    {/each}

    {#each nodes as node (node.key)}
      {@const place = layout.nodes.get(node.key)}
      {#if place}
        <g class={`node node--${node.kind}`} transform={`translate(${place.x} ${place.y})`}>
          <rect width={layout.nodeWidth} height={layout.nodeHeight} rx="8" />
          <text x={layout.nodeWidth / 2} y={layout.nodeHeight / 2 + 5} text-anchor="middle">{node.label}</text>
          <title>{node.label} · {node.articleCount} 篇</title>
        </g>
      {/if}
    {/each}
  </svg>
</div>

<style>
  .causal-graph {
    width: 100%;
    height: 100%;
    overflow: auto;
    padding: 4px;
  }

  svg {
    display: block;
    max-width: none;
    margin: 0 auto;
  }

  .node rect {
    fill: var(--bg-card);
    stroke: var(--border-color);
    stroke-width: 1.2;
  }

  .node text {
    fill: var(--text-1);
    font-size: 0.9375rem;
    font-weight: bold;
  }

  .node--policy rect { stroke: var(--brand-deep); }
  .node--macro rect { stroke: var(--color-warning-content); }
  .node--market rect { stroke: var(--color-success-content); }
  .node--sector rect { stroke: var(--business-purple); }
  .node--event rect { stroke: var(--text-3); }

  .edge {
    cursor: pointer;
  }

  .edge:focus,
  .edge:focus-visible {
    outline: none !important;
  }

  .edge .hit {
    fill: none;
    stroke: transparent;
    stroke-width: 18;
  }

  .edge .line {
    fill: none;
    stroke: var(--brand-deep);
    stroke-linecap: round;
    opacity: 0.78;
  }

  .edge.expected .line {
    stroke-dasharray: 7 5;
  }

  .edge.thin .line {
    opacity: 0.4;
  }

  .edge.contested .line {
    stroke: var(--color-error-content);
  }

  .edge.dim .line,
  .edge.dim .move {
    opacity: 0.12;
  }

  .edge:hover .line,
  .edge:focus-visible .line,
  .edge.selected .line {
    opacity: 1;
  }

  .edge:focus-visible .line {
    stroke-width: 6;
  }

  .edge.selected .line {
    stroke: var(--text-1);
  }

  .move {
    fill: var(--text-2);
    font-size: 0.875rem;
    font-weight: bold;
    paint-order: stroke;
    stroke: var(--bg-card);
    stroke-width: 4;
    pointer-events: none;
  }

  @media (prefers-reduced-motion: no-preference) {
    .edge .line {
      transition: opacity 160ms ease;
    }
  }
</style>
