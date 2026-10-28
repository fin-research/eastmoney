<script lang="ts">
  let {
    id,
    title,
    meta = "",
    accent = "",
  }: { id: string; title: string; meta?: string; accent?: string } = $props();
</script>

<div class="tr-section-heading">
  <div>
    <span class="tr-section-mark" style:background={accent || undefined} aria-hidden="true"></span>
    <h2 {id}>{title}</h2>
  </div>
  {#if meta}<span>{meta}</span>{/if}
</div>
