<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { NativeSelect } from "$lib/components/ui/native-select/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { onMount } from "svelte";

  import ModuleCard from "../../components/ModuleCard.svelte";
  import { globalMessages } from "$lib/global-messages";
  import {
    policyCategoryLabels,
    policyImportanceLabels,
    type ArticleSearchResult,
    type PolicyCategory,
    type PolicyEvent,
    type PolicyTimelineResponse,
  } from "$lib/policies";
  interface Props {
    embedded?: boolean;
  }

  let { embedded = false }: Props = $props();

  let policies = $state<PolicyEvent[]>([]);
  let loading = $state(true);
  let errorMessage = $state("");
  let startDate = $state(offsetDate(-30));
  let endDate = $state(offsetDate(0));
  let category: PolicyCategory | "" = $state("");
  let articlePolicy = $state<PolicyEvent | null>(null);
  let articleQuery = $state("");
  let articleResults = $state<ArticleSearchResult[]>([]);
  let selectedArticleIds = $state(new Set<string>());
  let searchingArticles = $state(false);
  let savingArticles = $state(false);


  onMount(loadPolicies);

  async function loadPolicies(): Promise<void> {
    loading = true;
    errorMessage = "";
    try {
      const query = new URLSearchParams({ startDate, endDate });
      if (category) query.set("category", category);
      const response = await fetch(`/api/policies?${query}`, {
        headers: { Accept: "application/json" },
      });
      const payload = (await response.json()) as PolicyTimelineResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error || "政策时间轴读取失败");
      policies = payload.policies;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  function openArticleEditor(policy: PolicyEvent): void {
    articlePolicy = policy;
    articleQuery = "";
    articleResults = policy.articles.map((article) => ({
      id: article.id,
      title: article.title,
      author: article.author,
      summary: article.summary,
      publishedAt: article.publishedAt,
      link: article.link,
    }));
    selectedArticleIds = new Set(policy.articles.map((article) => article.id));
    void searchArticles();
  }

  async function searchArticles(): Promise<void> {
    searchingArticles = true;
    try {
      const response = await fetch(`/api/policies/articles?q=${encodeURIComponent(articleQuery)}`);
      const payload = (await response.json()) as { articles?: ArticleSearchResult[]; error?: string };
      if (!response.ok || !payload.articles) throw new Error(payload.error || "研报检索失败");
      const merged = new Map(articleResults.map((article) => [article.id, article]));
      for (const article of payload.articles) merged.set(article.id, article);
      articleResults = [...merged.values()];
    } catch (error) {
      globalMessages.error(error instanceof Error ? error.message : String(error));
    } finally {
      searchingArticles = false;
    }
  }

  function toggleArticle(articleId: string): void {
    const next = new Set(selectedArticleIds);
    if (next.has(articleId)) next.delete(articleId);
    else next.add(articleId);
    selectedArticleIds = next;
  }

  async function saveArticles(): Promise<void> {
    if (!articlePolicy) return;
    savingArticles = true;
    try {
      const response = await fetch(`/api/policies/${articlePolicy.id}/articles`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ articleIds: [...selectedArticleIds] }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "研报关联保存失败");
      articlePolicy = null;
      globalMessages.success("政策研报关联已保存");
      await loadPolicies();
    } catch (error) {
      globalMessages.error(error instanceof Error ? error.message : String(error));
    } finally {
      savingArticles = false;
    }
  }

  function formatDate(value: string): string {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(`${value}T00:00:00+08:00`));
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

  function offsetDate(days: number): string {
    const value = new Date();
    value.setUTCDate(value.getUTCDate() + days);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    if (articlePolicy) articlePolicy = null;
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<svelte:head>
{#if !embedded}
  <title>政策跟踪 · 资金管理部</title>
  <meta name="description" content="中央政策时间轴、关联研报与标准化政策点评" />
{/if}
</svelte:head>

<div class="policy-page" class:policy-page--embedded={embedded}>
  <header class="policy-header">
    {#if !embedded}
    <div class="header-title">
      <a href="/" aria-label="返回市场研究门户">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
      </a>
      <div><span>POLICY TRACKER</span><h1>政策跟踪</h1></div>
    </div>
    {/if}
    <form class="filters" onsubmit={(event) => { event.preventDefault(); void loadPolicies(); }}>
      <label><span>开始日期</span><Input data-ui-owner="lib-pages-PolicyTrackingPage-svelte" class={"ui-input"} type="date" bind:value={startDate} /></label>
      <label><span>结束日期</span><Input data-ui-owner="lib-pages-PolicyTrackingPage-svelte" class={"ui-input"} type="date" bind:value={endDate} /></label>
      <label><span>政策类型</span><NativeSelect data-ui-owner="lib-pages-PolicyTrackingPage-svelte" class={"ui-select"} bind:value={category}>
        <option value="">全部</option>
        {#each Object.entries(policyCategoryLabels) as [value, label]}
          <option value={value}>{label}</option>
        {/each}
      </NativeSelect></label>
      <Button data-ui-owner="lib-pages-PolicyTrackingPage-svelte" variant="outline" class={"ui-button"} type="submit" disabled={loading}>{loading ? "读取中" : "查询"}</Button>
    </form>
  </header>

  <svelte:element this={embedded ? "section" : "main"} class="policy-main">
    {#if loading}
      <section class="page-state" aria-live="polite"><span class="spinner"></span><strong>正在读取政策时间轴</strong></section>
    {:else if errorMessage}
      <section class="page-state page-state--error" role="alert"><strong>{errorMessage}</strong><Button data-ui-owner="lib-pages-PolicyTrackingPage-svelte" variant="outline" class={"ui-button"} type="button" onclick={loadPolicies}>重新读取</Button></section>
    {:else if policies.length === 0}
      <section class="page-state"><strong>所选范围内暂无已聚合政策</strong></section>
    {:else}
      <ol class="policy-timeline" aria-label="政策时间轴">
        {#each policies as policy (policy.id)}
          <li class="policy-timeline-item">
            <div class="timeline-date"><time datetime={policy.policyDate}>{formatDate(policy.policyDate)}</time><span></span></div>
            <ModuleCard class="policy-card" labelledBy={`policy-${policy.id}`}>
              <div class="policy-card-topline">
                <div class="policy-meta">
                  <span class={`category category--${policy.category}`}>{policyCategoryLabels[policy.category]}</span>
                  {#each policy.departments as department}<span class="department">{department}</span>{/each}
                </div>
                <span
                  class={`importance-chip importance-chip--${policy.importance}`}
                  aria-label={`政策重要性：${policyImportanceLabels[policy.importance]}`}
                >{policyImportanceLabels[policy.importance]}</span>
              </div>
              <h2 class="policy-card-title" id={`policy-${policy.id}`}>{policy.title}</h2>
              <p class="policy-summary">{policy.summary}</p>

              <div class="policy-sections">
                <section>
                  <div class="section-heading"><h3>政策资讯 <span>{policy.news.length}</span></h3></div>
                  <ol class="news-list">
                    {#each policy.news as item}
                      <li><time datetime={item.publishedAt}>{formatTime(item.publishedAt)}</time>
                        <a href={`/news/${encodeURIComponent(item.id)}`}>{item.title}</a>
                      </li>
                    {/each}
                  </ol>
                </section>

                <section>
                  <div class="section-heading"><h3>关联研报 <span>{policy.articles.length}</span></h3><Button permission="research.policy:update" data-ui-owner="lib-pages-PolicyTrackingPage-svelte" variant="outline" class={"ui-button"} type="button" onclick={() => openArticleEditor(policy)}>调整关联</Button></div>
                  {#if policy.articles.length > 0}
                    <ul class="article-list">
                      {#each policy.articles as article}
                        <li>
                          <div><strong>{article.author || "未标注机构"}</strong><span>{formatDate(article.publishedAt.slice(0, 10))}</span>
                            {#if article.associationMethod === "manual"}<span class="manual-badge">人工确认</span>{/if}
                          </div>
                          <a href={`/articles/${encodeURIComponent(article.id)}`}>{article.title}</a>
                          <small>{article.summary}</small>
                        </li>
                      {/each}
                    </ul>
                  {:else}<p class="empty-text">暂无直接相关研报</p>{/if}
                </section>

                <section>
                  <div class="section-heading"><h3>跟踪点评</h3>
                    <a class="detail-link" href={policy.commentary
                      ? `/trading-research/tracking-commentary?id=${encodeURIComponent(policy.commentary.id)}`
                      : `/trading-research/tracking-commentary?policy=${encodeURIComponent(policy.id)}`}>
                      {policy.commentary ? "查看点评" : "撰写点评"}
                    </a>
                  </div>
                </section>
              </div>
            </ModuleCard>
          </li>
        {/each}
      </ol>
    {/if}
  </svelte:element>
</div>

{#if articlePolicy}
  <Modal open onclose={() => articlePolicy = null} class="p-0 gap-0 sm:max-w-[840px]" aria-labelledby="article-modal-title">
    <div class="policy-dialog">
      <header><div><span>关联研报</span><h2 id="article-modal-title">{articlePolicy.title}</h2></div><Button data-ui-owner="lib-pages-PolicyTrackingPage-svelte" variant="outline" class={"ui-button"} type="button" aria-label="关闭" onclick={() => (articlePolicy = null)}>×</Button></header>
      <form class="article-search" onsubmit={(event) => { event.preventDefault(); void searchArticles(); }}><label><span>检索标题、机构或摘要</span><Input data-ui-owner="lib-pages-PolicyTrackingPage-svelte" class={"ui-input"} bind:value={articleQuery} /></label><Button data-ui-owner="lib-pages-PolicyTrackingPage-svelte" variant="outline" class={"ui-button"} type="submit" disabled={searchingArticles}>{searchingArticles ? "检索中" : "检索"}</Button></form>
      <div class="modal-scroll article-options">
        {#each articleResults as article (article.id)}
          <label class:selected={selectedArticleIds.has(article.id)}><Checkbox data-ui-owner="lib-pages-PolicyTrackingPage-svelte"  checked={selectedArticleIds.has(article.id)} onCheckedChange={() => toggleArticle(article.id)} /><span><strong>{article.title}</strong><small>{article.author || "未标注机构"} · {formatDate(article.publishedAt.slice(0, 10))}</small><p>{article.summary}</p></span></label>
        {/each}
      </div>
      <footer><span>已选择 {selectedArticleIds.size} 篇</span><Button permission="research.policy:update" data-ui-owner="lib-pages-PolicyTrackingPage-svelte" variant="default" class={"ui-button  primary-action"} type="button" disabled={savingArticles} onclick={saveArticles}>{savingArticles ? "保存中" : "保存关联"}</Button></footer>
    </div>
  </Modal>
{/if}

<style>
  :global(*) { box-sizing: border-box; }
  .policy-page { min-height: 100dvh; color: #172033; background: #f6f8fb; }
  .policy-header { position: sticky; z-index: 20; top: 0; display: flex; min-height: 82px; align-items: center; justify-content: space-between; gap: 24px; padding: 14px max(24px, calc((100vw - 1600px) / 2)); border-bottom: 1px solid #d8e2f0; background: rgba(246, 248, 251, .94); backdrop-filter: blur(14px); }
  .header-title, .filters, .filters label, .policy-meta, .section-heading, .heading-actions, .policy-dialog header, .policy-dialog footer, .article-search { display: flex; align-items: center; }
  .header-title { gap: 14px; }
  .header-title > a { display: grid; width: 44px; height: 44px; place-items: center; border: 1px solid #cbd5e1; border-radius: 8px; color: #344054; background: #fff; }
  .header-title svg { width: 22px; fill: none; stroke: currentColor; stroke-width: 2; }
  .header-title span, .policy-dialog header span { color: #2f6fd6; font-size: .75rem; font-weight: bold; letter-spacing: .12em; }
  h1 { margin: 2px 0 0; font-size: 1.5rem; font-weight: bolder; }
  .filters { flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
  .filters label { gap: 7px; color: #475467; font-size: .875rem; font-weight: bold; }
  .filters label > span { flex: 0 0 auto; white-space: nowrap; }
  :global(.filters input[data-ui-owner="lib-pages-PolicyTrackingPage-svelte"]), :global(.filters select[data-ui-owner="lib-pages-PolicyTrackingPage-svelte"]) { width: 10rem; padding: 0 10px; }
  :global(button[data-ui-owner="lib-pages-PolicyTrackingPage-svelte"]:not([role="checkbox"])) { padding: 0 14px; }
  :global(button[data-ui-owner="lib-pages-PolicyTrackingPage-svelte"]:focus-visible), :global(input[data-ui-owner="lib-pages-PolicyTrackingPage-svelte"]:focus-visible), :global(select[data-ui-owner="lib-pages-PolicyTrackingPage-svelte"]:focus-visible), :global(textarea[data-ui-owner="lib-pages-PolicyTrackingPage-svelte"]:focus-visible), a:focus-visible { outline: 3px solid rgba(47, 111, 214, .25); outline-offset: 2px; }
  .policy-main { width: min(1600px, calc(100% - 48px)); margin: 0 auto; padding: 32px 0 64px; }
  .page-state { display: flex; min-height: 240px; align-items: center; justify-content: center; gap: 14px; border: 1px solid #d8e2f0; border-radius: 10px; background: #fff; }
  .page-state--error { color: #b42318; }
  .spinner { width: 24px; height: 24px; border: 3px solid #dbe8fb; border-top-color: #2f6fd6; border-radius: 50%; animation: spin 800ms linear infinite; }
  .policy-timeline { display: grid; gap: 2rem; margin: 0; padding: 0; list-style: none; }
  .policy-timeline-item { display: grid; grid-template-columns: 126px minmax(0, 1fr); gap: 2rem; }
  .timeline-date { position: relative; display: flex; align-items: flex-start; justify-content: flex-end; padding-top: 26px; text-align: right; }
  .timeline-date time { position: sticky; top: 16px; color: #344054; font-size: .875rem; font-weight: bold; font-variant-numeric: tabular-nums; }
  .timeline-date::before, .timeline-date::after { position: absolute; right: -1rem; width: 1px; background: #cbd5e1; content: ""; }
  .timeline-date::before { top: 0; bottom: calc(100% - 36px); }
  .timeline-date::after { top: 36px; bottom: -2rem; }
  .policy-timeline-item:first-child .timeline-date::before { display: none; }
  .policy-timeline-item:last-child .timeline-date::after { display: none; }
  .timeline-date span { position: absolute; z-index: 2; top: 36px; right: -1rem; width: 11px; height: 11px; border: 3px solid #f6f8fb; border-radius: 50%; background: #2f6fd6; box-shadow: 0 0 0 1px #2f6fd6; transform: translate(50%, -50%); }
  :global(.policy-card) { padding: 24px; }
  .policy-card-topline { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .policy-meta { flex-wrap: wrap; gap: 8px; }
  .policy-meta span, .manual-badge span { padding: 4px 8px; border-radius: 6px; font-size: .75rem; font-weight: bold; }
  .category { color: #175cd3; background: #eff4ff; }
  .category--real_estate { color: #b54708; background: #fffaeb; }
  .category--fiscal { color: #027a48; background: #ecfdf3; }
  .category--capital_market { color: #6941c6; background: #f4f3ff; }
  .department { color: #475467; background: #f2f4f7; }
  .importance-chip { display: inline-flex; flex: 0 0 auto; align-items: center; padding: 5px 10px; border: 1px solid; border-radius: 6px; font-size: .875rem; font-weight: bold; line-height: 1.25; }
  .importance-chip--important { border-color: #fecdca; color: #b42318; background: #fef3f2; }
  .importance-chip--related { border-color: #b2ddff; color: #175cd3; background: #eff8ff; }
  .importance-chip--general { border-color: #d0d5dd; color: #475467; background: #f2f4f7; }
  .policy-card-title { margin: 14px 0 10px; scroll-margin-top: 100px; font-size: 1.25rem; line-height: 1.4; font-weight: bolder; }
  .policy-summary { margin: 0; color: #344054; font-size: 1rem; line-height: 1.75; }
  .policy-sections { display: grid; gap: 22px; margin-top: 24px; padding-top: 22px; border-top: 1px solid #eaecf0; }
  .section-heading { min-height: 44px; justify-content: space-between; gap: 12px; }
  .section-heading h3 { margin: 0; font-size: 1.125rem; font-weight: bold; }
  .section-heading h3 span { color: #667085; font-size: .875rem; }
  .heading-actions { flex-wrap: wrap; gap: 8px; }
  .detail-link { display: inline-flex; min-height: 44px; align-items: center; padding: 0 12px; border: 1px solid #b8c6da; border-radius: 8px; color: #2f6fd6; font-size: .875rem; font-weight: bold; text-decoration: none; }
  .detail-link:hover { border-color: #2f6fd6; background: #f5f9ff; }
  .detail-link:focus-visible { outline: 3px solid rgba(47, 111, 214, .28); outline-offset: 2px; }
  .news-list, .article-list { display: grid; gap: 10px; margin: 10px 0 0; padding: 0; list-style: none; }
  .news-list li { display: grid; grid-template-columns: 98px minmax(0, 1fr); gap: 12px; align-items: start; padding: 10px 12px; border-radius: 8px; background: #f8fafc; }
  .news-list time, .article-list small { color: #667085; font-size: .8125rem; font-variant-numeric: tabular-nums; }
  a { color: #175cd3; text-underline-offset: 3px; }
  .article-list { grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); }
  .article-list li { min-width: 0; padding: 14px; border: 1px solid #e4e7ec; border-radius: 8px; background: #fff; }
  .article-list li > div { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-bottom: 7px; }
  .article-list li > div > span { color: #667085; font-size: .8125rem; }
  .article-list li a { display: block; margin: 0 0 8px; font-weight: bold; line-height: 1.5; }
  .article-list li > small { display: block; line-height: 1.5; }
  .manual-badge { color: #027a48 !important; background: #ecfdf3; }
  .empty-text { margin: 10px 0 0; color: #667085; }
  .policy-dialog { position: relative; display: grid; width: min(840px, calc(100vw - 3rem)); max-height: calc(100dvh - 32px); grid-template-rows: auto auto minmax(0, 1fr) auto; overflow: hidden; border: 1px solid #cbd5e1; border-radius: inherit; background: var(--surface); box-shadow: none; }
  .policy-dialog header, .policy-dialog footer { justify-content: space-between; gap: 14px; padding: 18px 20px; border-bottom: 1px solid #e4e7ec; }
  .policy-dialog footer { border-top: 1px solid #e4e7ec; border-bottom: 0; color: #667085; }
  .policy-dialog h2 { max-width: 720px; margin: 3px 0 0; font-size: 1.25rem; }
  :global(.policy-dialog header > button[data-ui-owner="lib-pages-PolicyTrackingPage-svelte"]) { width: 44px; padding: 0; }
  .article-search { gap: 10px; padding: 14px 20px; border-bottom: 1px solid #e4e7ec; }
  .article-search label { flex: 1; }
  .article-search label span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
  :global(.article-search input[data-ui-owner="lib-pages-PolicyTrackingPage-svelte"]) { width: 100%; padding: 0 12px; }
  .modal-scroll { min-height: 0; overflow-y: auto; }
  .article-options { display: grid; gap: 10px; padding: 18px 20px; }
  .article-options > label { display: grid; grid-template-columns: 24px 1fr; gap: 12px; padding: 14px; border: 1px solid #e4e7ec; border-radius: 8px; cursor: pointer; }
  .article-options > label.selected { border-color: #2f6fd6; background: #f5f9ff; }
  :global(.article-options input[data-ui-owner="lib-pages-PolicyTrackingPage-svelte"]) { width: 20px; accent-color: #2f6fd6; }
  .article-options strong, .article-options small { display: block; }
  .article-options small { margin-top: 5px; color: #667085; }
  .article-options p { margin: 8px 0 0; color: #475467; font-size: .875rem; line-height: 1.5; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 900px) {
    .policy-header { position: static; align-items: flex-start; flex-direction: column; min-height: 82px; }
    .filters { width: 100%; justify-content: flex-start; }
    .policy-timeline-item { grid-template-columns: 1fr; gap: 8px; }
    .timeline-date { justify-content: flex-start; padding-top: 0; text-align: left; }
    .timeline-date time { position: static; }
    .timeline-date::before, .timeline-date::after, .timeline-date span { display: none; }
  }
  @media (max-width: 620px) {
    .policy-main { width: min(100% - 28px, 1600px); padding-top: 20px; }
    .filters label { width: 100%; justify-content: space-between; }
    :global(.filters input[data-ui-owner="lib-pages-PolicyTrackingPage-svelte"]), :global(.filters select[data-ui-owner="lib-pages-PolicyTrackingPage-svelte"]) { flex: 1; }
    :global(.filters > button[data-ui-owner="lib-pages-PolicyTrackingPage-svelte"]) { width: 100%; }
    :global(.policy-card) { padding: 16px; }
    .section-heading { align-items: flex-start; flex-direction: column; }
    .news-list li { grid-template-columns: 1fr; gap: 4px; }
  }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }

  .policy-page--embedded { min-height: 0; background: transparent; }
  .policy-page--embedded .policy-header { position: static; min-height: 0; padding: 0 0 24px; border: 0; background: transparent; backdrop-filter: none; }
  .policy-page--embedded .policy-main { width: 100%; padding: 0; }
</style>
