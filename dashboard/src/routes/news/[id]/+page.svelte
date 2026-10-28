<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { onMount } from "svelte";

  import ModuleCard from "../../../components/ModuleCard.svelte";
  import DetailPageShell from "$lib/policy-tracking/DetailPageShell.svelte";
  import DocumentBody from "$lib/policy-tracking/DocumentBody.svelte";
  import {
    policyCategoryLabels,
    type PolicyNewsDetail,
  } from "$lib/policies";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  let detail = $state<PolicyNewsDetail | null>(null);
  let loading = $state(true);
  let errorMessage = $state("");

  onMount(() => { void loadNews(); });

  async function loadNews(): Promise<void> {
    loading = true;
    errorMessage = "";
    try {
      const response = await fetch(`/api/news/${encodeURIComponent(data.id)}`);
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(readError(payload, "新闻资讯读取失败"));
      detail = payload as PolicyNewsDetail;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "新闻资讯读取失败";
    } finally {
      loading = false;
    }
  }

  function readError(payload: unknown, fallback: string): string {
    if (payload && typeof payload === "object" && "error" in payload) {
      const value = (payload as { error?: unknown }).error;
      if (typeof value === "string" && value) return value;
    }
    return fallback;
  }

  function formatDateTime(value: string): string {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }
</script>

<svelte:head>
  <title>{detail ? `${detail.title} · 新闻资讯` : "新闻资讯 · 资金管理部"}</title>
  <meta name="description" content="政策跟踪新闻资讯与 DM 原文" />
</svelte:head>

<DetailPageShell eyebrow="NEWS DETAIL" title="新闻资讯" backHref="/trading-research/policy-tracking" backLabel="返回政策跟踪" wrapHeadings>
  {#if loading}
    <section class="page-state" aria-live="polite"><span class="spinner"></span><strong>正在读取新闻资讯</strong></section>
  {:else if errorMessage}
    <section class="page-state page-state--error" role="alert"><strong>{errorMessage}</strong><Button data-ui-owner="routes-news--id---page-svelte" variant="outline" class={"ui-button"} type="button" onclick={loadNews}>重新读取</Button></section>
  {:else if detail}
    <div class="news-layout">
      <div class="news-column">
        <ModuleCard class="news-hero" labelledBy="news-title">
          <div class="news-meta"><span>DM 资讯</span><time datetime={detail.publishedAt}>{formatDateTime(detail.publishedAt)}</time></div>
          <h2 id="news-title">{detail.title}</h2>
          {#if detail.link}
            <a class="source-link" href={detail.link} target="_blank" rel="noreferrer">
              <span>查看政策原文</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-9 9M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" /></svg>
            </a>
          {:else}
            <p class="source-missing">政策原文链接暂未收录</p>
          {/if}
        </ModuleCard>

        <ModuleCard class="news-content" labelledBy="news-body-title">
          <h2 id="news-body-title">DM 原文</h2>
          <DocumentBody content={detail.content} />
        </ModuleCard>
      </div>

      <aside aria-labelledby="related-policy-title">
        <ModuleCard>
          <div class="policy-meta"><span>{policyCategoryLabels[detail.policy.category]}</span><time datetime={detail.policy.policyDate}>{detail.policy.policyDate}</time></div>
          <h2 id="related-policy-title">{detail.policy.title}</h2>
          <p>{detail.policy.summary}</p>
          <a href={`/trading-research/policy-tracking#policy-${encodeURIComponent(detail.policy.id)}`}>查看关联政策</a>
        </ModuleCard>
      </aside>
    </div>
  {/if}
</DetailPageShell>

<style>
  .page-state { display: flex; min-height: 260px; align-items: center; justify-content: center; gap: 14px; border: 1px solid #d8e2f0; border-radius: 10px; background: #fff; }
  .page-state--error { flex-wrap: wrap; color: #b42318; }
  :global(.page-state button[data-ui-owner="routes-news--id---page-svelte"]), .source-link, aside a { display: inline-flex; min-height: 44px; align-items: center; justify-content: center; padding: 0 16px; border: 1px solid #b8c6da; border-radius: 8px; color: #2f6fd6; font: inherit; font-weight: bold; background: #fff; cursor: pointer; text-decoration: none; transition: border-color 180ms ease, background 180ms ease; }
  :global(.page-state button[data-ui-owner="routes-news--id---page-svelte"]:hover), .source-link:hover, aside a:hover { border-color: #2f6fd6; background: #f5f9ff; }
  :global(.page-state button[data-ui-owner="routes-news--id---page-svelte"]:focus-visible), .source-link:focus-visible, aside a:focus-visible { outline: 3px solid rgba(47, 111, 214, .28); outline-offset: 2px; }
  .spinner { width: 22px; height: 22px; border: 3px solid #d8e2f0; border-top-color: #2f6fd6; border-radius: 50%; animation: spin .8s linear infinite; }
  .news-layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 20px; align-items: start; }
  .news-column { display: grid; gap: 20px; min-width: 0; }
  :global(.news-hero), :global(.news-content) { padding: 24px; }
  .news-meta, .policy-meta { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 18px; color: #667085; font-size: .875rem; }
  .news-meta span, .policy-meta span { color: #2f6fd6; font-weight: bold; }
  #news-title { margin: 14px 0 0; font-size: 1.5rem; line-height: 1.45; }
  .source-link { width: fit-content; gap: 7px; margin-top: 18px; }
  .source-link svg { width: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; }
  .source-missing { margin: 18px 0 0; color: #667085; font-size: .875rem; }
  #news-body-title { margin: 0 0 18px; font-size: 1.125rem; }
  .policy-meta { font-size: .75rem; }
  aside h2 { margin: 14px 0 10px; font-size: 1.125rem; line-height: 1.5; }
  aside p { margin: 0; color: #667085; font-size: .875rem; line-height: 1.65; }
  aside a { width: 100%; margin-top: 18px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 900px) { .news-layout { grid-template-columns: 1fr; } aside { order: -1; } }
  @media (max-width: 620px) { :global(.news-hero), :global(.news-content) { padding: 16px; } #news-title { font-size: 1.25rem; } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } :global(.page-state button[data-ui-owner="routes-news--id---page-svelte"]), .source-link, aside a { transition: none; } }
</style>
