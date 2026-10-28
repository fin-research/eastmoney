<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";

  import { getContext, onMount } from 'svelte';
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import PageHeader from '$lib/workbench/PageHeader.svelte';
  import FundReportUploadDialog from '$lib/FundReportUploadDialog.svelte';
  import { requireClientPermission, isLoginRedirecting } from '$lib/auth-client';
  import { CLIENT_SESSION_CONTEXT, type ClientSession } from '$lib/client-session';
  import { globalMessages } from '$lib/global-messages';
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const session = getContext<ClientSession>(CLIENT_SESSION_CONTEXT);

  let uploadDialog: FundReportUploadDialog;
  let checkingLogin = $state(false);
  async function openUpload() {
    if (checkingLogin) return;
    checkingLogin = true;
    try {
      if (await requireClientPermission('admin', '/fund-report?upload=1', session)) uploadDialog.open();
    } catch (error) {
      if (!isLoginRedirecting()) globalMessages.error(error instanceof Error ? error.message : '登录状态读取失败');
    } finally { checkingLogin = false; }
  }
  function refreshReports() {
    void invalidate('app:fund-reports').catch(() => globalMessages.error('日报已保存，列表刷新失败，请重新加载'));
  }
  onMount(() => { if ($session?._roles.includes('admin') && page.url.searchParams.get('upload') === '1') void openUpload(); });

  function formatReportDate(date: string): string {
    const [year, month, day] = date.split("-");
    return `${year}年${Number(month)}月${Number(day)}日`;
  }

  function formatUploadedAt(value: string): string {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(value));
  }

  function formatSize(size: number): string {
    return size >= 1024 * 1024
      ? `${(size / 1024 / 1024).toFixed(2)} MB`
      : `${Math.max(1, Math.round(size / 1024))} KB`;
  }
</script>

<svelte:head>
  <title>历史资金日报 · 资金管理部</title>
  <meta name="description" content="按日期查看历史资金日报" />
  <meta name="theme-color" content="#f6f8fb" />
</svelte:head>

<div class="fund-report-page">
  <PageHeader section={{label: '资金日报', href: '/fund-report'}}>
    {#snippet actions()}
      <Button permission="admin" data-ui-owner="routes-fund-report--page-svelte" variant="outline" class={"ui-button upload-entry"} type="button" disabled={checkingLogin} onclick={openUpload}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4m0 0L8 8m4-4 4 4M5 13v6h14v-6" /></svg>
        {checkingLogin ? '正在检查登录' : '上传资金日报'}
      </Button>
    {/snippet}
  </PageHeader>

  <main>
    <section class="report-panel" aria-labelledby="fund-report-list-title">
      <header class="panel-heading">
        <div>
          <span class="panel-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M5 4h14v16H5zM8 2v4M16 2v4M5 9h14M8 13h3M13 13h3M8 17h3" />
            </svg>
          </span>
          <h2 id="fund-report-list-title">历史资金日报</h2>
        </div>
        {#if !data.loadError}
          <span class="report-count">共 {data.reports.length} 期</span>
        {/if}
      </header>

      {#if data.loadError}
        <div class="report-state report-state--error" role="alert">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 17h.01" /></svg>
          <strong>{data.loadError}</strong>
          <a href="/fund-report">重新加载</a>
        </div>
      {:else if data.reports.length === 0}
        <div class="report-state">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM8 2v4M16 2v4M5 9h14" /></svg>
          <strong>暂无历史资金日报</strong>
        </div>
      {:else}
        <ul class="report-list">
          {#each data.reports as report}
            <li>
              <a href={report.url}>
                <span class="report-date">
                  <strong>{formatReportDate(report.date)}</strong>
                  {#if report.date === data.today}<span>今日</span>{/if}
                </span>
                <span class="report-meta">
                  <span>{formatSize(report.size)}</span>
                  <span>发布于 {formatUploadedAt(report.uploadedAt)}</span>
                </span>
                <span class="report-open">
                  打开日报
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg>
                </span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </main>
</div>

<FundReportUploadDialog bind:this={uploadDialog} onuploaded={refreshReports} />

<style>
  :global(.upload-entry[data-ui-owner="routes-fund-report--page-svelte"]) { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 14px; }
  :global(.upload-entry[data-ui-owner="routes-fund-report--page-svelte"] svg) { width: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

  .fund-report-page {
    width: min(100%, 2100px);
    min-height: 100dvh;
    margin-inline: auto;
    padding: 12px 16px 40px;
    color: var(--text-1);
    background: var(--bg-page);
  }

  .panel-heading,
  .panel-heading > div,
  .report-date,
  .report-meta,
  .report-open {
    display: flex;
    align-items: center;
  }

  .panel-icon svg,
  .report-state svg,
  .report-open svg {
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.9;
  }

  main {
    width: min(100%, 1040px);
    margin-inline: auto;
    padding-top: clamp(28px, 5vw, 56px);
  }

  .report-panel {
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius-card);
    background: var(--surface);
    box-shadow: var(--shadow-card);
  }

  .panel-heading {
    min-height: 76px;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 20px;
    border-bottom: 1px solid var(--line);
  }

  .panel-heading > div {
    min-width: 0;
    gap: 12px;
  }

  .panel-heading h2 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: bold;
  }

  .panel-icon {
    display: grid;
    width: 44px;
    height: 44px;
    flex: 0 0 auto;
    place-items: center;
    border-radius: var(--radius-control);
    color: var(--brand-deep);
    background: var(--brand-soft);
  }

  .panel-icon svg {
    width: 24px;
  }

  .report-count {
    flex: 0 0 auto;
    padding: 6px 9px;
    border-radius: var(--radius-tag);
    color: var(--brand-deep);
    background: var(--brand-soft);
    font-size: 0.875rem;
    font-weight: bold;
    font-variant-numeric: tabular-nums;
  }

  .report-list {
    display: grid;
    gap: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .report-list li + li {
    border-top: 1px solid var(--line);
  }

  .report-list a {
    display: grid;
    min-height: 88px;
    grid-template-columns: minmax(180px, 1fr) minmax(250px, 1fr) auto;
    align-items: center;
    gap: 24px;
    padding: 16px 20px;
    color: var(--text-2);
    text-decoration: none;
    transition: background 160ms ease;
  }

  .report-list a:hover {
    background: color-mix(in srgb, var(--brand-soft) 48%, var(--surface));
  }

  .report-date {
    min-width: 0;
    gap: 9px;
  }

  .report-date strong {
    font-size: 1.125rem;
    font-weight: bold;
    font-variant-numeric: tabular-nums;
  }

  .report-date > span {
    padding: 4px 7px;
    border-radius: var(--radius-tag);
    color: color-mix(in srgb, var(--green) 76%, #173b31);
    background: color-mix(in srgb, var(--green) 10%, var(--surface));
    font-size: 0.75rem;
    font-weight: bold;
  }

  .report-meta {
    flex-wrap: wrap;
    gap: 6px 18px;
    color: var(--text-muted);
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
  }

  .report-open {
    min-height: 44px;
    gap: 8px;
    padding: 0 13px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-control);
    color: var(--brand-deep);
    background: var(--surface);
    font-size: 0.875rem;
    font-weight: bold;
  }

  .report-open svg {
    width: 18px;
  }

  .report-state {
    display: grid;
    min-height: 240px;
    place-items: center;
    align-content: center;
    gap: 14px;
    padding: 32px;
    color: var(--text-muted);
    text-align: center;
  }

  .report-state svg {
    width: 40px;
  }

  .report-state strong {
    color: var(--text-2);
    font-size: 1rem;
    font-weight: bold;
  }

  .report-state a {
    min-height: 44px;
    padding: 11px 16px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-control);
    color: var(--brand-deep);
    background: var(--surface);
    font-weight: bold;
    text-decoration: none;
  }

  .report-state--error svg {
    color: var(--red);
  }

  .report-list a:focus-visible,
  .report-state a:focus-visible {
    position: relative;
    z-index: 1;
    outline: 3px solid color-mix(in srgb, var(--brand) 36%, transparent);
    outline-offset: 2px;
  }

  @media (max-width: 720px) {
    .fund-report-page {
      padding-inline: 12px;
    }

    main {
      padding-top: 24px;
    }

    .panel-heading {
      padding-inline: 16px;
    }

    .report-list a {
      min-height: 0;
      grid-template-columns: 1fr auto;
      gap: 10px 12px;
      padding: 16px;
    }

    .report-meta {
      grid-column: 1;
    }

    .report-open {
      grid-column: 2;
      grid-row: 1 / span 2;
    }
  }

  @media (max-width: 460px) {

    .panel-heading {
      align-items: flex-start;
    min-height: 76px;
    }

    .report-list a {
      grid-template-columns: 1fr;
    min-height: 88px;
    }

    .report-meta,
    .report-open {
      grid-column: 1;
      grid-row: auto;
    }

    .report-open {
      width: fit-content;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .report-list a {
      transition: none;
    }
  }
</style>
