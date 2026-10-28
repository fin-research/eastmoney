<script lang="ts">
  import PageHeader from '$lib/workbench/PageHeader.svelte';
  import { page } from '$app/state';
  import { onMount, type Snippet } from "svelte";

  let {
    title,
    backHref,
    backLabel,
    wrapHeadings = false,
    children,
  }: {
    eyebrow: string;
    title: string;
    backHref: string;
    backLabel: string;
    wrapHeadings?: boolean;
    children: Snippet;
  } = $props();

  let mainElement: HTMLElement;
  onMount(() => mainElement.focus({ preventScroll: true }));
</script>

<div class="detail-page" class:detail-page--wrap-headings={wrapHeadings}>
  <PageHeader section={{label: '交易研究工作台', href: '/trading-research'}}
    current={{label: title, href: page.url.pathname}}>
    {#snippet leading()}
      <a class="detail-back" href={backHref} aria-label={backLabel}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
      </a>
    {/snippet}
  </PageHeader>
  <main class="detail-main" tabindex="-1" bind:this={mainElement}>
    {@render children()}
  </main>
</div>

<style>
  .detail-back { display: grid; width: 44px; height: 44px; place-items: center; color: var(--brand-deep); border: 1px solid var(--border-color); border-radius: var(--radius-control); background: var(--bg-card); }
  .detail-back svg { width: 22px; fill: none; stroke: currentColor; stroke-width: 2; }

  .detail-page { min-height: 100dvh; color: #172033; background: #f6f8fb; }
  .detail-main { width: min(1180px, calc(100% - 48px)); margin: 0 auto; padding: 32px 0 56px; outline: none; }
  .detail-page--wrap-headings :global(h2) { white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: anywhere; }
  @media (max-width: 620px) {
    .detail-main { width: min(100% - 28px, 1180px); padding: 20px 0 40px; }
  }
</style>
