<script lang="ts">
  import DocumentBody from "$lib/policy-tracking/DocumentBody.svelte";
  import { commentaryTypeLabels, type CommentaryDraft } from "$lib/commentary";
  let { draft, element = $bindable() }: { draft: CommentaryDraft; element?: HTMLElement } = $props();
</script>
<article class="commentary-report" bind:this={element}>
  <header><h1>【东财证券】资金管理部·{commentaryTypeLabels[draft.type]}</h1>
    <dl><div><dt>事件名称</dt><dd>{draft.eventName}</dd></div><div><dt>消息来源</dt><dd>{draft.sources || "未注明"}</dd></div>
      <div class="dates"><div><dt>发布时间</dt><dd>{draft.eventPublishedAt || "未注明"}</dd></div><div><dt>快评时间</dt><dd>{draft.commentaryDate || "未注明"}</dd></div></div>
    </dl>
  </header>
  <section><h2>事件摘要</h2><DocumentBody content={draft.eventSummary || "尚未撰写"} /></section>
  <section><h2>时事快评</h2><DocumentBody content={draft.commentary || "尚未撰写"} /></section>
  {#if draft.recommendation}<section><h2>应对建议</h2><DocumentBody content={draft.recommendation} /></section>{/if}
</article>
<style>
  .commentary-report { width:100%; color:var(--text-1); font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:white; overflow-wrap:anywhere; }
  header { border-bottom:2px solid var(--primary); padding-bottom:14px; margin-bottom:18px; }
  h1 { margin:0 0 18px; font-size:1.25rem; line-height:1.45; font-weight:bold; }
  dl { margin:0; display:grid; gap:8px; font-size:.875rem; }
  dl div { display:flex; gap:10px; } dt { flex-shrink:0; font-weight:bold; } dd { margin:0; }
  dl .dates { display:grid; grid-template-columns:1fr 1fr; }
  section { margin-top:20px; } h2 { font-size:1rem; margin:0 0 10px; font-weight:bold; break-after:avoid; }
  /* This is a report variant, shared DocumentBody still owns text/table rendering. */
  .commentary-report :global(.document-body) { max-width:none; font-size:.875rem; line-height:1.75; }
  .commentary-report :global(.document-body p) { margin:0 0 12px; }
  @media print {
    .commentary-report { color:#172033; width:100%; }
    header { border-color:#2f6fd6; } h1 { font-size:15pt; } dl {font-size:10pt;} h2 {font-size:11pt;}
    .commentary-report :global(.document-body) { font-size:10.5pt; line-height:1.65; }
    .commentary-report :global(p), .commentary-report :global(tr) { break-inside:avoid; }
    .commentary-report :global(.table-scroll) { overflow:visible; }
    .commentary-report :global(table) { table-layout:auto; width:100%; }
  }
</style>
