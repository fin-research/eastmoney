<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { onMount } from "svelte";

  import ModuleCard from "../../../components/ModuleCard.svelte";
  import DetailPageShell from "$lib/policy-tracking/DetailPageShell.svelte";
  import DocumentBody from "$lib/policy-tracking/DocumentBody.svelte";
  import type { ResearchReportDetail } from "$lib/policies";
  import { policyCategoryLabels } from "$lib/policies";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  let report = $state<ResearchReportDetail | null>(null);
  let loading = $state(true);
  let errorMessage = $state("");

  onMount(() => { void loadReport(); });

  async function loadReport(): Promise<void> {
    loading = true;
    errorMessage = "";
    try {
      const response = await fetch(`/api/articles/${encodeURIComponent(data.id)}`);
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(readError(payload, "研报读取失败"));
      report = payload as ResearchReportDetail;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "研报读取失败";
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
  <title>{report ? `${report.title} · 研报详情` : "研报详情 · 资金管理部"}</title>
  <meta name="description" content="政策跟踪关联研报详情" />
</svelte:head>

<DetailPageShell eyebrow="RESEARCH REPORT" title="研报详情" backHref="/trading-research/policy-tracking" backLabel="返回政策跟踪" wrapHeadings>
  {#if loading}
    <section class="page-state" aria-live="polite"><span class="spinner"></span><strong>正在读取研报</strong></section>
  {:else if errorMessage}
    <section class="page-state page-state--error" role="alert"><strong>{errorMessage}</strong><Button data-ui-owner="routes-articles--id---page-svelte" variant="outline" class={"ui-button"} type="button" onclick={loadReport}>重新读取</Button></section>
  {:else if report}
    <div class="report-layout">
      <div class="report-column">
        <ModuleCard class="report-hero" labelledBy="report-title">
          <div class="report-meta"><span>{report.author || "未标注机构"}</span><time datetime={report.publishedAt}>{formatDateTime(report.publishedAt)}</time></div>
          <h2 id="report-title">{report.title}</h2>
          <p class="summary">{report.summary}</p>
          {#if report.link}
            <a class="source-link" href={report.link} target="_blank" rel="noreferrer">
              <span>查看原文</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-9 9M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" /></svg>
            </a>
          {/if}
        </ModuleCard>

        <ModuleCard class="research-report-content" labelledBy="report-body-title">
          <h2 id="report-body-title">研报正文</h2>
          <DocumentBody content={report.content} />
        </ModuleCard>
      </div>

      <aside aria-labelledby="related-policy-title">
        <ModuleCard>
          <h2 id="related-policy-title">关联政策</h2>
          {#if report.policies.length > 0}
            <ul class="policy-list">
              {#each report.policies as policy}
                <li>
                  <div><span>{policyCategoryLabels[policy.category]}</span><time datetime={policy.policyDate}>{policy.policyDate}</time></div>
                  <a href={`/trading-research/policy-tracking#policy-${encodeURIComponent(policy.id)}`}>{policy.title}</a>
                  <p>{policy.summary}</p>
                </li>
              {/each}
            </ul>
          {:else}<p class="empty-text">当前未关联政策</p>{/if}
        </ModuleCard>
      </aside>
    </div>
  {/if}
</DetailPageShell>

<style>
  .page-state { display: flex; min-height: 260px; align-items: center; justify-content: center; gap: 14px; border: 1px solid #d8e2f0; border-radius: 10px; background: #fff; }
  .page-state--error { flex-wrap: wrap; color: #b42318; }
  :global(.page-state button[data-ui-owner="routes-articles--id---page-svelte"]), .source-link { display: inline-flex; min-height: 44px; align-items: center; justify-content: center; padding: 0 16px; border: 1px solid #b8c6da; border-radius: 8px; color: #2f6fd6; font: inherit; font-weight: bold; background: #fff; cursor: pointer; transition: border-color 180ms ease, background 180ms ease; }
  :global(.page-state button[data-ui-owner="routes-articles--id---page-svelte"]:hover), .source-link:hover { border-color: #2f6fd6; background: #f5f9ff; }
  :global(.page-state button[data-ui-owner="routes-articles--id---page-svelte"]:focus-visible), .source-link:focus-visible, .policy-list a:focus-visible { outline: 3px solid rgba(47, 111, 214, .28); outline-offset: 2px; }
  .spinner { width: 22px; height: 22px; border: 3px solid #d8e2f0; border-top-color: #2f6fd6; border-radius: 50%; animation: spin .8s linear infinite; }
  .report-layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 20px; align-items: start; }
  .report-column { display: grid; gap: 20px; min-width: 0; }
  :global(.report-hero), :global(.research-report-content) { padding: 24px; }
  .report-meta { display: flex; flex-wrap: wrap; gap: 8px 18px; color: #667085; font-size: .875rem; }
  .report-meta span { color: #2f6fd6; font-weight: bold; }
  #report-title { margin: 14px 0 12px; font-size: 1.5rem; line-height: 1.45; }
  .summary { margin: 0; color: #475467; line-height: 1.75; }
  .source-link { width: fit-content; gap: 7px; margin-top: 18px; text-decoration: none; }
  .source-link svg { width: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; }
  #report-body-title, aside h2 { margin: 0 0 18px; font-size: 1.125rem; }
  .policy-list { display: grid; gap: 14px; margin: 0; padding: 0; list-style: none; }
  .policy-list li { padding-bottom: 14px; border-bottom: 1px solid #e4e7ec; }
  .policy-list li:last-child { padding-bottom: 0; border-bottom: 0; }
  .policy-list div { display: flex; justify-content: space-between; gap: 8px; color: #667085; font-size: .75rem; }
  .policy-list div span { color: #2f6fd6; font-weight: bold; }
  .policy-list a { display: block; margin-top: 8px; color: #172033; font-weight: bold; line-height: 1.5; text-decoration: none; }
  .policy-list a:hover { color: #2f6fd6; }
  .policy-list p, .empty-text { margin: 7px 0 0; color: #667085; font-size: .875rem; line-height: 1.6; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 900px) { .report-layout { grid-template-columns: 1fr; } aside { order: -1; } }
  @media (max-width: 620px) { :global(.report-hero), :global(.research-report-content) { padding: 16px; } #report-title { font-size: 1.25rem; } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } :global(.page-state button[data-ui-owner="routes-articles--id---page-svelte"]), .source-link { transition: none; } }
</style>
