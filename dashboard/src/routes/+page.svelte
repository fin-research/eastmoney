<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import AuthMenu from '$lib/AuthMenu.svelte';
  import { permissionVisibility } from '$lib/permission-visibility';
  import { currentReportDate } from "../report-date";
  const allowed = permissionVisibility();
  const todayFundReportUrl = `/fund-report/${currentReportDate()}.html`;
</script>

<svelte:head>
  <title>市场研究 · 资金管理部</title>
  <meta name="description" content="资金日报与市场研究工作台" />
  <meta name="theme-color" content="#fffbf4" />
</svelte:head>

<div class="home-page">
  <header class="site-header">
    <a data-ui-owner="routes--page-svelte" href="/" aria-label="市场研究首页">
      <span class="brand-mark" aria-hidden="true"><i></i><i></i></span>
      <span>资金管理部</span>
    </a>
    <AuthMenu />
  </header>

  <main>
    <h1 class="sr-only">市场研究</h1>
    <nav class="tool-grid" aria-label="市场研究内容">
      {#if $allowed(undefined, '/fund-report')}<article class="ui-card tool-card tool-card--fund-report">
        <span class="tool-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M4 4h16v16H4zM7 8h10M7 12h4M7 16h6" />
            <path d="m14 15 2-2 2 2" />
          </svg>
        </span>
        <span class="card-visual card-visual--fund-report" aria-hidden="true">
          <svg viewBox="0 0 180 100">
            <path d="M22 14h136v72H22zM22 34h136M58 34v52" />
            <path d="M31 48h18M31 61h18M31 74h18M72 69l18-18 17 11 31-30" />
            <circle cx="72" cy="69" r="3" />
            <circle cx="90" cy="51" r="3" />
            <circle cx="107" cy="62" r="3" />
            <circle cx="138" cy="32" r="3" />
          </svg>
        </span>
        <span class="tool-copy">
          <h2>资金日报</h2>
        </span>
        <span class="tool-actions tool-actions--fund-report">
          <Button data-ui-owner="routes--page-svelte" variant="outline" class={"ui-button tool-action"} href={todayFundReportUrl}>
            今日资金日报
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12h14m-5-5 5 5-5 5" />
            </svg>
          </Button>
          <Button data-ui-owner="routes--page-svelte" variant="outline" class={"ui-button tool-action"} href="/fund-report">
            历史资金日报
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12h14m-5-5 5 5-5 5" />
            </svg>
          </Button>
        </span>
      </article>{/if}

      <a data-ui-owner="routes--page-svelte" class="ui-card tool-card tool-card--briefing" href="/market-briefing">
        <span class="tool-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M5 3h10l4 4v14H5z" />
            <path d="M15 3v5h5M8 12h8M8 16h6" />
          </svg>
        </span>
        <span class="card-visual card-visual--briefing" aria-hidden="true">
          <svg viewBox="0 0 180 100">
            <path d="M12 80h156M28 78V58M64 78V43M100 78V64M136 78V27" />
            <path d="m18 57 38-18 39 14 51-34" />
            <circle cx="18" cy="57" r="3" />
            <circle cx="56" cy="39" r="3" />
            <circle cx="95" cy="53" r="3" />
            <circle cx="146" cy="19" r="3" />
          </svg>
        </span>
        <span class="tool-copy">
          <h2>市场点评</h2>
        </span>
        <span data-ui-owner="routes--page-svelte" class="ui-button tool-action">
          打开市场点评
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14m-5-5 5 5-5 5" />
          </svg>
        </span>
      </a>

      {#if $allowed(undefined, '/trading-research')}<a data-ui-owner="routes--page-svelte" class="ui-card tool-card tool-card--trading-research" href="/trading-research">
        <span class="tool-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <path d="M9 4v16M9 9h11M9 15h11M13 12h3m-1.5-1.5v3" />
          </svg>
        </span>
        <span class="card-visual card-visual--trading-research" aria-hidden="true">
          <svg viewBox="0 0 180 100">
            <path d="M18 18h144v68H18zM18 37h144M58 37v49" />
            <path d="M29 51h18M29 62h18M29 73h18M72 55h25M72 69h45M130 52h19v19h-19z" />
            <path d="m133 62 5 5 9-11" />
          </svg>
        </span>
        <span class="tool-copy">
          <h2>交易研究工作台</h2>
        </span>
        <span data-ui-owner="routes--page-svelte" class="ui-button tool-action">
          打开交易研究工作台
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14m-5-5 5 5-5 5" />
          </svg>
        </span>
      </a>{/if}

      {#if $allowed(undefined, '/credit-workbench')}<a data-ui-owner="routes--page-svelte" class="ui-card tool-card tool-card--credit-workbench" href="/credit-workbench">
        <span class="tool-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M12 3 5 6v5c0 4.8 2.7 8.4 7 10 4.3-1.6 7-5.2 7-10V6l-7-3Z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
        </span>
        <span class="card-visual card-visual--credit-workbench" aria-hidden="true">
          <svg viewBox="0 0 180 100">
            <path d="m26 66 41-38 39 30 47-39M67 28l-8 57m47-27 42 23" />
            <circle cx="26" cy="66" r="7" />
            <circle cx="67" cy="28" r="10" />
            <circle cx="59" cy="85" r="5" />
            <circle cx="106" cy="58" r="12" />
            <circle cx="153" cy="19" r="6" />
            <circle cx="148" cy="81" r="8" />
          </svg>
        </span>
        <span class="tool-copy">
          <h2>授信工作台</h2>
        </span>
        <span data-ui-owner="routes--page-svelte" class="ui-button tool-action">
          打开授信工作台
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14m-5-5 5 5-5 5" />
          </svg>
        </span>
      </a>{/if}

      {#if $allowed(undefined, '/financing/')}<a data-ui-owner="routes--page-svelte" class="ui-card tool-card tool-card--workspace" href="/financing/">
        <span class="tool-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M4 7h16v13H4zM8 7V4h8v3M8 12h8M8 16h5" />
          </svg>
        </span>
        <span class="card-visual card-visual--workspace" aria-hidden="true">
          <svg viewBox="0 0 180 100">
            <path d="M18 18h144v68H18zM18 37h144M61 37v49" />
            <path d="m30 53 6 6 12-14M30 73l6 6 12-14M75 52h67M75 70h49" />
          </svg>
        </span>
        <span class="tool-copy">
          <h2>融资工作台</h2>
        </span>
        <span data-ui-owner="routes--page-svelte" class="ui-button tool-action">
          打开融资工作台
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14m-5-5 5 5-5 5" />
          </svg>
        </span>
      </a>{/if}

      {#if $allowed(undefined, '/management')}<a data-ui-owner="routes--page-svelte" class="ui-card tool-card tool-card--management" href="/management">
        <span class="tool-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 4 6v6c0 4 3 7 8 9 5-2 8-5 8-9V6z" /><path d="m8 12 3 3 5-6" /></svg></span>
        <span class="card-visual" aria-hidden="true"><svg viewBox="0 0 180 100"><rect x="24" y="14" width="132" height="72" rx="6" /><path d="M24 35h132M65 35v51M80 51h56M80 65h35M36 49h16M36 63h16" /></svg></span>
        <span class="tool-copy"><h2>管理</h2></span>
        <span data-ui-owner="routes--page-svelte" class="ui-button tool-action">打开管理<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg></span>
      </a>{/if}

    </nav>
  </main>
</div>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  .home-page {
    --ink: #15243b;
    --background: #fffbf4;
    --yellow: #ffda6a;
    --blue: #91ceff;
    --slate-blue: #d6e4f3;
    --peach: #ffc9a9;
    --mint: #a9e8d2;
    --lilac: #dfceff;
    --sage: #c8e6d2;
    min-height: 100dvh;
    background: var(--background);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .site-header,
  main {
    width: min(1280px, calc(100% - 48px));
    margin-inline: auto;
  }

  .site-header {
    display: flex;
    min-height: 80px;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px 12px;
    border-bottom: 1px solid rgba(21, 36, 59, 0.16);
  }

  :global(.site-header a[data-ui-owner="routes--page-svelte"]) {
    display: inline-flex;
    min-height: 48px;
    align-items: center;
    gap: 11px;
    border-radius: 8px;
    color: var(--ink);
    font-size: 1.25rem;
    font-weight: bold;
    letter-spacing: 0.05em;
    text-decoration: none;
  }

  .brand-mark {
    display: grid;
    width: 34px;
    height: 34px;
    grid-template-columns: 1fr 1fr;
    gap: 3px;
    padding: 5px;
    border: 1px solid rgba(21, 36, 59, 0.16);
    border-radius: 10px;
    background: #ffffff;
  }

  .brand-mark i {
    display: block;
    border-radius: 4px;
  }

  .brand-mark i:first-child {
    background: var(--yellow);
  }

  .brand-mark i:last-child {
    background: var(--blue);
  }

  main {
    padding-block: clamp(64px, 12vh, 112px);
  }

  .tool-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 380px));
    justify-content: center;
    gap: 24px;
  }

  .tool-card {
    position: relative;
    display: grid;
    width: 100%;
    min-width: 0;
    max-width: 380px;
    min-height: 320px;
    grid-template-rows: auto 1fr auto;
    gap: 30px;
    padding: 32px;
    overflow: hidden;
    border: 1px solid rgba(21, 36, 59, 0.08);
    border-radius: 24px;
    color: var(--ink);
    text-decoration: none;
    cursor: pointer;
    transition:
      box-shadow 180ms ease,
      transform 180ms ease;
  }

  .tool-card::before,
  .tool-card::after {
    position: absolute;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.22);
    content: "";
    pointer-events: none;
  }

  .tool-card::before {
    top: -76px;
    right: -48px;
    width: 220px;
    height: 220px;
  }

  .tool-card::after {
    top: 90px;
    right: 128px;
    width: 46px;
    height: 46px;
  }

  .tool-card--management { background: var(--lilac); }

  .tool-card--briefing {
    background: var(--yellow);
    box-shadow: 0 24px 54px rgba(195, 139, 27, 0.16);
  }

  .tool-card--fund-report {
    background: var(--mint);
    box-shadow: 0 24px 54px rgba(22, 163, 148, 0.16);
  }

  .tool-card--credit-workbench {
    background: var(--blue);
    box-shadow: 0 24px 54px rgba(31, 119, 183, 0.16);
  }

  .tool-card--workspace {
    background: var(--peach);
    box-shadow: 0 24px 54px rgba(184, 91, 43, 0.14);
  }

  .tool-card--trading-research {
    background: var(--slate-blue);
    box-shadow: 0 24px 54px rgba(47, 111, 214, 0.14);
  }


  .tool-card:hover {
    box-shadow: 0 30px 64px rgba(21, 36, 59, 0.18);
    transform: translateY(-4px);
  }

  .tool-card:active {
    box-shadow: 0 18px 40px rgba(21, 36, 59, 0.14);
    transform: translateY(-1px);
  }

  .tool-card:focus-visible,
  :global(.tool-action[data-ui-owner="routes--page-svelte"]:focus-visible),
  :global(.site-header a[data-ui-owner="routes--page-svelte"]:focus-visible) {
    outline: 3px solid #1d4ed8;
    outline-offset: 4px;
  }

  .tool-icon {
    position: relative;
    z-index: 2;
    display: grid;
    width: 56px;
    height: 56px;
    place-items: center;
    border: 1px solid rgba(21, 36, 59, 0.15);
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.7);
    box-shadow: 0 8px 20px rgba(21, 36, 59, 0.08);
  }

  .tool-icon svg,
  :global(.tool-action[data-ui-owner="routes--page-svelte"] svg) {
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.9;
  }

  .tool-icon svg {
    width: 28px;
  }

  .card-visual {
    position: absolute;
    z-index: 1;
    top: 28px;
    right: 24px;
    width: min(42%, 188px);
    color: var(--ink);
    opacity: 0.33;
    pointer-events: none;
  }

  .card-visual svg {
    width: 100%;
    overflow: visible;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 2;
  }

  .card-visual circle {
    fill: rgba(255, 255, 255, 0.72);
  }

  .tool-copy {
    position: relative;
    z-index: 2;
    display: grid;
    align-content: start;
    gap: 12px;
  }

  .tool-copy h2 {
    margin: 0;
  }

  .tool-copy h2 {
    color: var(--ink);
    font-size: clamp(1.9rem, 4vw, 2.5rem);
    font-weight: bolder;
    line-height: 1.16;
    letter-spacing: -0.035em;
    overflow-wrap: anywhere;
  }

  :global(.tool-action[data-ui-owner="routes--page-svelte"]) {
    position: relative;
    z-index: 2;
    display: flex;
    width: fit-content;
    min-height: 48px;
    align-items: center;
    justify-content: flex-start;
    gap: 16px;
    border-radius: 12px;
    padding: 0 17px;
    border: 1px solid rgba(21, 36, 59, 0.12);
    color: var(--ink);
    background: rgba(255, 255, 255, 0.72);
    box-shadow: 0 7px 18px rgba(21, 36, 59, 0.08);
    font-size: 0.9rem;
    font-weight: bold;
    text-decoration: none;
  }

  .tool-actions {
    position: relative;
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  :global(.tool-actions .tool-action[data-ui-owner="routes--page-svelte"]) {
    gap: 8px;
    padding-inline: 12px;
  }

  :global(.tool-action[data-ui-owner="routes--page-svelte"] svg) {
    width: 19px;
  }

  @media (max-width: 720px) {
    .site-header,
    main {
      width: min(100% - 32px, 1040px);
    }

    .site-header {
      min-height: 68px;
    }

    main {
      padding-block: 48px;
    }

    .tool-grid {
      grid-template-columns: 1fr;
      gap: 18px;
    }

    .tool-card {
      min-height: 272px;
      gap: 24px;
      padding: 24px;
      border-radius: 20px;
    }

    .card-visual {
      width: 150px;
      opacity: 0.24;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .tool-card {
      transition: none;
    min-height: 320px;
    }

    .tool-card:hover,
    .tool-card:active {
      transform: none;
    }
  }

</style>
