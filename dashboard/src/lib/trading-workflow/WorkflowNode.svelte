<script lang="ts">
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { onMount } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import { ChevronRight } from '@lucide/svelte';
  import InquiryTable from './InquiryTable.svelte';
  import { isInquiry } from './model';
  import { nodeIcon, workflowIcons } from './icons';
  import type { FlowNode } from './graph';
  let { data }: NodeProps<FlowNode> = $props();
  const Icon = $derived(workflowIcons[nodeIcon(data.node)].component);
  let body: HTMLDivElement;
  onMount(() => {
    const measure = () => data.measureHeight?.(body.offsetHeight);
    const observer = new ResizeObserver(measure); observer.observe(body); measure();
    return () => observer.disconnect();
  });
</script>

<Handle id="top" type="target" position={Position.Top} isConnectable={false} aria-hidden="true" tabindex={-1} />
<Handle id="side" type="target" position={Position.Left} isConnectable={false} aria-hidden="true" tabindex={-1} />
<Handle id="side" type="source" position={Position.Right} isConnectable={false} aria-hidden="true" tabindex={-1} />
<div bind:this={body} class="workflow-node" class:decision={data.node?.kind === 'branch'}
  class:done={data.done} class:chosen={data.selected} class:editing={data.editing}
  data-workflow-node={data.node?.id} data-scope={data.scope} style:width={`${data.width}px`}>
  <button type="button" class="node-surface" aria-label={data.title} disabled={!!data.node && !data.editing && !data.active}
    aria-pressed={data.node?.kind === 'task' && !isInquiry(data.node) ? !!data.done : undefined}
    aria-expanded={data.node?.kind === 'branch' || (data.node && isInquiry(data.node)) ? !!data.expanded : undefined}
    aria-describedby={data.node && !isInquiry(data.node) ? `workflow-state-${data.node.id}` : undefined}
    onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); data.activate(); } }}>
    <span class="node-symbol" aria-hidden="true">
      <Icon size={21} />
    </span>
    <span class="node-copy"><span class="node-title">{data.title}</span>{#if data.node?.detail}<span class="node-detail">{data.node.detail}</span>{/if}</span>
    {#if data.node?.kind === 'branch' || (data.node && isInquiry(data.node))}<span class="node-chevron" class:expanded={data.expanded} aria-hidden="true"><ChevronRight size={17} /></span>{/if}
  </button>
  {#if data.node && !isInquiry(data.node)}<span id={`workflow-state-${data.node.id}`} class="sr-only">{data.done ? '已完成' : '未完成'}</span>{/if}
  {#if data.node && isInquiry(data.node) && data.expanded && !data.editing}
    {#key data.date}<InquiryTable rows={data.rows} loan={data.node.flowIds.includes('loan')} directory={data.directory} rates={data.rates}
      date={data.date} now={data.now} onRows={data.writeRows} onRemember={data.remember} />{/key}
    {#if data.note}<Textarea data-ui-owner="lib-trading-workflow-WorkflowNode-svelte" class={"ui-textarea legacy-note nodrag nopan nowheel"} aria-label="原询价记录" value={data.note} oninput={event => data.writeNote(event.currentTarget.value)}></Textarea>{/if}
  {/if}
</div>
<Handle id="bottom" type="source" position={Position.Bottom} isConnectable={false} aria-hidden="true" tabindex={-1} />

<style>
  .workflow-node { position: relative; scroll-margin: 8px; --node-tone: #087cff; }
  .workflow-node[data-scope="reverse"] { --node-tone: #00a773; }
  .workflow-node[data-scope="exchange"] { --node-tone: #8090aa; }
  .node-surface { width: 100%; min-height: 52px; display: flex; align-items: center; gap: 12px; padding: 12px 16px; text-align: left; background: #fff; color: var(--tr-text); border: 1px solid #dbe7f7; border-radius: 8px; cursor: pointer; box-shadow: 0 3px 10px rgb(32 91 153 / 5%); font: inherit; transition: border-color .15s, box-shadow .15s; }
  .node-surface:hover { border-color: var(--node-tone); box-shadow: 0 3px 12px rgb(32 91 153 / 10%); }
  .chosen .node-surface { border-color: #087cff; box-shadow: 0 0 0 1px #087cff, 0 3px 12px rgb(8 124 255 / 12%); }
  .node-surface:disabled { opacity: .5; cursor: default; }
  .node-surface:focus-visible { outline: 3px solid var(--node-tone); outline-offset: 3px; }
  .editing .node-surface { cursor: grab; touch-action: none; }
  .editing .node-surface:active { cursor: grabbing; }
  .node-symbol { color: var(--node-tone); flex: none; display: flex; align-items: center; justify-content: center; }
  .node-copy { display: grid; gap: 2px; flex: 1; min-width: 0; }
  .node-title, .node-detail { line-height: 1.4; overflow-wrap: anywhere; }
  .node-title { font-size: 1.125rem; font-weight: bold; }
  .node-detail { font-size: .875rem; font-weight: normal; color: var(--tr-muted); white-space: pre-line; }
  .node-chevron { color: var(--node-tone); display: flex; transition: transform 240ms ease; }
  .node-chevron.expanded { transform: rotate(90deg); }
  .done .node-surface { background: color-mix(in srgb, var(--node-tone) 20%, white); border-color: color-mix(in srgb, var(--node-tone) 60%, white); }
  .workflow-node:has(:global(.inquiry-table)) .node-surface { border-radius: 8px 8px 0 0; }
  :global(.legacy-note[data-ui-owner="lib-trading-workflow-WorkflowNode-svelte"]) { width: 100%; font-size: .875rem; }
  :global(.svelte-flow__handle) { opacity: 0; pointer-events: none; }
  @media (prefers-reduced-motion: reduce) { .node-surface, .node-chevron { transition: none; } }
</style>
