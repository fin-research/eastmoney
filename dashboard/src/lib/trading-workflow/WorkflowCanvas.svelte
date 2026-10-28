<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { scrollableRegion } from '../scrollable-region';
  import { ChevronLeft, ChevronRight } from '@lucide/svelte';
  import type { InquiryRow, InquiryDirectory } from './inquiries';
  import type { ShiborRate } from '../../data-contracts';
  import { SvelteFlow } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import WorkflowNodeView from './WorkflowNode.svelte';
  import WorkflowEdgeView from './WorkflowEdge.svelte';
  import { buildGraph, timelineCursor, workflowBranchFrames, type FlowGraph, type FlowNode } from './graph';
  import { isInquiry, products, defaultFlows, type WorkflowConfig, type WorkflowNode, type WorkflowDay, type Product } from './model';
  let { flows = defaultFlows, nodes, day, clockMinutes, editing = false, selectedId = '', onSelect, onMove, onComplete, onBranch, onEnable, onNote, onRows, onRemember, directory, rates, now }: {
    onRows: (id: string, rows: InquiryRow[]) => void; onRemember: (row: InquiryRow) => void; directory: InquiryDirectory; rates: ShiborRate[]; now: Date;
    flows?: WorkflowConfig['flows']; nodes: WorkflowNode[]; day: WorkflowDay; clockMinutes: number; editing?: boolean; selectedId?: string;
    onSelect: (id: string) => void; onMove: (id: string, offset: { x: number; y: number }) => void;
    onComplete: (ids: string[], value: boolean) => void; onBranch: (ids: string[], value: boolean) => void;
    onEnable: (product: Product, value: boolean) => void; onNote: (id: string, value: string) => void;
  } = $props();
  const nodeTypes = { workflow: WorkflowNodeView };
  const edgeTypes = { workflow: WorkflowEdgeView };
  let reducedMotion = $state(false);
  const flowProducts = $derived(products.map(product => ({ ...product, label: flows.find(flow => flow.id === product.id)?.label ?? product.label })));
  const enabledProducts = $derived(flowProducts.filter(product => day.enabled[product.id]));
  let lastStructure = '';
  let animation = 0;
  let animating = false;
  let pendingGraph: FlowGraph | undefined;
  let pendingHeights: Record<string, number> = {};
  let viewportWidth = $state(1040);
  let scrollRegion = $state<HTMLDivElement | null>(null);
  let dragging = $state(false);
  let inquiries = $state<Record<string, boolean>>({});
  let flowNodes = $state.raw<FlowNode[]>([]);
  const branchFrames = $derived(workflowBranchFrames(flowNodes));
  let heights = $state<Record<string, number>>({});
  let graph = $state.raw<FlowGraph>({ nodes: [], edges: [], bases: {}, timeline: [], height: 680, width: 1040, lanes: {} });
  const cursor = $derived(timelineCursor(graph.timeline, clockMinutes));
  $effect(() => {
    const id = selectedId;
    viewportWidth;
    if (!editing || !id || !scrollRegion) return;
    let cancelled = false;
    void tick().then(() => {
      if (!cancelled) Array.from(scrollRegion?.querySelectorAll<HTMLElement>('[data-workflow-node]') ?? [])
        .find(node => node.dataset.workflowNode === id)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    });
    return () => { cancelled = true; };
  });
  function measureHeight(id: string, height: number) {
    if (height <= 0) return;
    // ResizeObserver may deliver the final size during the lane animation.
    // Keep it until the animation finishes instead of losing the measurement.
    if (animating) { pendingHeights[id] = height; return; }
    if (heights[id] !== height) heights = { ...heights, [id]: height };
  }
  function finishAnimation() {
    animating = false;
    const pending = pendingHeights;
    pendingHeights = {};
    if (Object.entries(pending).some(([id, height]) => heights[id] !== height)) heights = { ...heights, ...pending };
  }
  function complete(members: WorkflowNode[]) {
    onComplete(members.map(node => node.id), !members.every(node => day.completed[node.id]));
  }
  function activate(node: WorkflowNode, members: WorkflowNode[]) {
    if (editing) { onSelect(node.id); if (node.kind === 'branch' && !day.branches[node.id]) onBranch([node.id], true); }
    else if (isInquiry(node)) {
      const id = members[0]!.id;
      inquiries = { ...inquiries, [id]: !inquiries[id] };
      const { [id]: removed, ...rest } = heights; heights = rest;
    }
    else if (node.kind === 'branch') onBranch(members.map(item => item.id), !members.some(item => day.branches[item.id]));
    else complete(members);
  }
  function displayGraph(next: FlowGraph, structure: string) {
    // Mount/clock/size updates must not turn a running reveal into an instant swap.
    if (animating && lastStructure === structure && !reducedMotion) { pendingGraph = next; return; }
    pendingGraph = undefined;
    cancelAnimationFrame(animation);
    const animate = lastStructure !== '' && lastStructure !== structure && !reducedMotion;
    lastStructure = structure;
    const previousGraph = graph;
    const old = new Map(flowNodes.map(node => [node.id, node]));
    if (!animate) { graph = next; flowNodes = next.nodes; finishAnimation(); return; }
    animating = true;
    const nextIds = new Set(next.nodes.map(node => node.id));
    const leaving = flowNodes.filter(node => !nextIds.has(node.id));
    const oldEdges = new Map(previousGraph.edges.map(edge => [edge.id, edge]));
    const nextEdgeIds = new Set(next.edges.map(edge => edge.id));
    const edges = [...next.edges, ...previousGraph.edges.filter(edge => !nextEdgeIds.has(edge.id))];
    const start = performance.now();
    function frame(time: number) {
      const progress = Math.min(1, (time - start) / 240), eased = 1 - (1 - progress) ** 3;
      flowNodes = [...next.nodes.map(node => {
        const from = old.get(node.id);
        const width = (from?.data.width ?? node.data.width) + (node.data.width - (from?.data.width ?? node.data.width)) * eased;
        const reveal = (from?.data.reveal ?? (from ? 1 : 0)) * (1 - eased) + eased;
        const x = from?.position.x ?? node.position.x - 24;
        const y = from?.position.y ?? node.position.y;
        return { ...node, style: `opacity: ${reveal};`, position: { x: x + (node.position.x - x) * eased, y: y + (node.position.y - y) * eased },
          width, measured: { ...node.measured, width }, data: { ...node.data, width, reveal } };
      }), ...leaving.map(node => {
        const reveal = (node.data.reveal ?? 1) * (1 - eased);
        return { ...node, draggable: false, style: `opacity: ${reveal}; pointer-events: none;`,
          position: { x: node.position.x - 24 * eased, y: node.position.y }, data: { ...node.data, reveal } };
      })];
      const opacity = new Map(flowNodes.map(node => [node.id, node.data.reveal ?? 1]));
      graph = { ...next, width: Math.max(previousGraph.width, next.width), height: Math.max(previousGraph.height, next.height),
        edges: edges.map(edge => {
          const from = oldEdges.get(edge.id)?.data?.joinY ?? edge.data!.joinY;
          return { ...edge, style: `${edge.style} opacity: ${Math.min(opacity.get(edge.source) ?? 0, opacity.get(edge.target) ?? 0)};`,
            data: { ...edge.data!, joinY: from + (edge.data!.joinY - from) * eased } };
        }) };
      if (progress < 1) animation = requestAnimationFrame(frame);
      else {
        const finalGraph = pendingGraph ?? next;
        pendingGraph = undefined;
        graph = finalGraph; flowNodes = finalGraph.nodes; finishAnimation();
      }
    }
    frame(start);
  }
  $effect(() => {
    const next = buildGraph(nodes, day, { editing, selectedId, clockMinutes: 0, width: viewportWidth, activate, heights, inquiries, measureHeight,
      toggleProduct: product => onEnable(product, !day.enabled[product]), note: onNote, rows: onRows, remember: onRemember, directory, rates, now });
    const structure = JSON.stringify([enabledProducts.map(product => product.id), next.nodes.map(node => node.id)]);
    if (!dragging) untrack(() => displayGraph(next, structure));
  });
  onMount(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => reducedMotion = media.matches; motion(); media.addEventListener('change', motion);
    function locate(event: Event) { document.querySelector<HTMLElement>(`[data-workflow-node="${(event as CustomEvent<string>).detail}"]`)?.scrollIntoView({ block: 'center', behavior: 'instant' }); }
    window.addEventListener('workflow-locate', locate);
    return () => { cancelAnimationFrame(animation); media.removeEventListener('change', motion); window.removeEventListener('workflow-locate', locate); };
  });
</script>

<div class="workflow-diagram" class:editing aria-label="交易流程图">
  <div class="flow-scroll" bind:this={scrollRegion} bind:clientWidth={viewportWidth} role="region" aria-label="流程图滚动区域" use:scrollableRegion>
    <div class="flow-canvas" style:width={`${graph.width}px`} style:height={`${graph.height}px`}>
      <div class="product-categories">
        {#each enabledProducts as product (product.id)}
          <div class="product-category" data-workflow-product={product.id} style:left={`${graph.lanes[product.id]?.x ?? 0}px`} style:width={`${graph.lanes[product.id]?.width ?? 0}px`}>
            <span>{product.label}</span>
          </div>
        {/each}
      </div>
      <svg class="workflow-timeline" width={graph.width} height={graph.height} aria-label="交易时间线" role="img">
        <line class="timeline-axis" x1="88" x2="88" y1="0" y2={graph.height} stroke="#087cff" stroke-width="2" />
        {#if cursor !== null}<line class="current-time-line" x1="88" x2={graph.width - 16} y1={cursor} y2={cursor} stroke="#087cff" stroke-opacity="0.2" stroke-width="1.5" />{/if}
        {#each graph.timeline as mark (mark.time)}
          <g data-timeline-time={mark.time}>
            <line x1="99" x2={Math.max(100, mark.endX)} y1={mark.y} y2={mark.y} stroke="#c8ddf7" stroke-dasharray="3 5" />
            <text x="61" y={mark.y + 5} text-anchor="end">{mark.time}</text>
            <circle cx="88" cy={mark.y} r="9" fill="white" stroke="#087cff" stroke-width="2" />
            <circle cx="88" cy={mark.y} r="5" fill={clockMinutes >= mark.minute ? '#087cff' : 'white'} />
          </g>
        {/each}
        {#if cursor !== null}<circle class="clock-cursor" cx="88" cy={cursor} r="4" fill="#087cff" />{/if}
      </svg>
      {#each branchFrames as frame (frame.id)}
        <div class="branch-frame" data-workflow-branch={frame.id} data-scope={frame.scope} role="group" aria-label={frame.title}
          style:left={`${frame.left}px`} style:top={`${frame.top}px`} style:width={`${frame.width}px`} style:height={`${frame.height}px`} style:opacity={frame.opacity}></div>
      {/each}
      <SvelteFlow bind:nodes={flowNodes} edges={graph.edges} {nodeTypes} {edgeTypes} viewport={{ x: 0, y: 0, zoom: 1 }}
        proOptions={{ hideAttribution: true }} minZoom={1} maxZoom={1} nodesDraggable={editing} nodesConnectable={false} elementsSelectable={false}
        panOnDrag={false} panOnScroll={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false}
        deleteKey={null} nodeDragThreshold={6} preventScrolling={false} nodeExtent={[[114, 0], [graph.width - 24, 10000]]}
        onnodeclick={({ node, event }) => { if (!(event.target as Element)?.closest('.nodrag')) node.data.activate(); }}
        onnodedragstart={() => dragging = true}
        onnodedragstop={({ targetNode }) => {
          if (editing && targetNode && graph.bases[targetNode.id]) {
            const base = graph.bases[targetNode.id]!;
            onMove(targetNode.data.node?.id ?? targetNode.id, { x: Math.round(targetNode.position.x - base.x), y: Math.round(targetNode.position.y - base.y) });
          }
          dragging = false;
        }} />
    </div>
  </div>
  <aside class="product-toggles" aria-label="流程展开与折叠">
    {#each products as product (product.id)}
      <button type="button" class="product-toggle" data-scope={product.id} aria-label={`${day.enabled[product.id] ? '折叠' : '展开'}${product.label}`} aria-expanded={day.enabled[product.id]} onclick={() => onEnable(product.id, !day.enabled[product.id])}>
        <span class="product-dot" aria-hidden="true"></span><span>{product.label}</span>{#if day.enabled[product.id]}<ChevronRight size={16} />{:else}<ChevronLeft size={16} />{/if}
      </button>
    {/each}
  </aside>
</div>

<style>
  .workflow-diagram { display: flex; min-width: 0; gap: 8px; position: relative; background: #fff; border-radius: 8px; }
  .product-categories { position: absolute; z-index: 5; top: 12px; left: 0; right: 0; }
  .product-category { position: absolute; max-width: 460px; min-height: 52px; border: 1px solid color-mix(in srgb, var(--category-tone) 25%, white); border-radius: 8px; --category-tone: #087cff; display: flex; align-items: center; justify-content: center; gap: 2px; font-size: 1rem; font-weight: bold; color: var(--category-tone); background: color-mix(in srgb, var(--category-tone) 9%, white); }
  .product-category[data-workflow-product="reverse"] { --category-tone: #00a773; }
  .product-category[data-workflow-product="exchange"] { --category-tone: #8090aa; }
  .product-toggles { display: flex; flex-direction: column; gap: 8px; position: sticky; top: 12px; align-self: flex-start; padding: 12px 8px 12px 0; width: 140px; flex: none; }
  .product-toggle { --product-tone: #087cff; display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; padding: 10px; background: var(--surface, white); border: 1px solid var(--tr-border); border-radius: 8px; color: var(--tr-muted); cursor: pointer; transition: color 150ms, background 150ms, border-color 150ms; }
  .product-toggle[data-scope="reverse"] { --product-tone: #00a773; }
  .product-toggle[data-scope="exchange"] { --product-tone: #8090aa; }
  .product-toggle span:not(.product-dot) { flex: 1; white-space: nowrap; text-align: left; font-size: .875rem; font-weight: bold; }
  .product-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: currentColor; opacity: .5; }
  .product-toggle[aria-expanded="true"] { color: var(--product-tone); background: color-mix(in srgb, var(--product-tone) 7%, white); border-color: color-mix(in srgb, var(--product-tone) 24%, white); }
  .product-toggle[aria-expanded="true"] .product-dot { opacity: 1; }
  .product-toggle:hover { border-color: var(--product-tone); }
  .branch-frame { --frame-tone: #087cff; position: absolute; pointer-events: none; border: 1px solid color-mix(in srgb, var(--frame-tone) 28%, white); border-radius: 14px; background: color-mix(in srgb, var(--frame-tone) 3%, white); }
  .branch-frame[data-scope="reverse"] { --frame-tone: #00a773; }
  .branch-frame[data-scope="exchange"] { --frame-tone: #8090aa; }
  .product-toggle:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { .product-toggle { transition: none; } }
  @media (max-width: 700px) {
    .workflow-diagram { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0; }
    .product-toggles { grid-row: 1; flex-direction: row; width: 100%; padding: 8px; gap: 6px; background: white; z-index: 10; top: 0; }
    .product-toggle { flex: 1; min-width: 0; padding: 8px 6px; gap: 4px; }
    .product-dot { display: none; }
    .flow-scroll { grid-row: 2; }
  }
  .flow-scroll { flex: 1; min-width: 0; overflow-x: auto; }
  .flow-canvas { position: relative; }
  .workflow-timeline { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
  .workflow-timeline text { font: normal 1rem var(--font-sans, sans-serif); font-variant-numeric: tabular-nums; fill: #496388; }
  .flow-canvas :global(.svelte-flow) { --xy-background-color: transparent; --xy-edge-stroke: #087cff; background: transparent; }
  .flow-canvas :global(.svelte-flow__pane) { cursor: default; }

</style>
