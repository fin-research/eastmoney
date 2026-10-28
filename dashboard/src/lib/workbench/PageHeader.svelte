<script lang="ts">
  import type { Snippet } from 'svelte';
  import AuthMenu from '$lib/AuthMenu.svelte';
  import type { PageLink, PageTab } from './navigation';

  let { section, current, tabs = [], activeTabId = '', leading, actions, account,
    actionsId, class: className = '', onheight, onTabNavigate, tabsDisabled = false }: {
    section: PageLink; current?: PageLink; tabs?: readonly PageTab[]; activeTabId?: string;
    leading?: Snippet; actions?: Snippet; account?: Snippet; actionsId?: string;
    class?: string; onheight?: (height: number) => void;
    onTabNavigate?: (tab: PageTab) => void; tabsDisabled?: boolean;
  } = $props();

  function measure(element: HTMLElement) {
    const update = () => onheight?.(Math.ceil(element.getBoundingClientRect().height));
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return { destroy: () => observer.disconnect() };
  }
  function navigate(event: MouseEvent, tab: PageTab) {
    if (tabsDisabled) { event.preventDefault(); return; }
    if (onTabNavigate && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      onTabNavigate(tab);
    }
  }
</script>

<header class={`page-header ${className}`} class:page-header--tabs={tabs.length > 1} use:measure>
  <div class="page-header__identity">
    {#if leading}<div class="page-header__leading">{@render leading()}</div>{/if}
    <div class="page-header__heading">
      <a class="page-header__brand" href="/" aria-label="返回市场研究门户">东方财富证券 · 资金管理部</a>
      <nav class="page-header__breadcrumb tr-breadcrumb" aria-label="当前位置">
        <ol>
          {#if current}
            <li><a href={section.href}>{section.label}</a></li>
            <li class="page-header__separator" aria-hidden="true">/</li>
          {/if}
          <li><h1><a href={current?.href ?? section.href} aria-current="page">{current?.label ?? section.label}</a></h1></li>
        </ol>
      </nav>
    </div>
  </div>
  {#if tabs.length > 1}
    <nav class="page-header__tabs" aria-label="标签页">
      {#each tabs as tab (tab.id)}
        <a href={tab.href} class:active={activeTabId === tab.id}
          aria-current={activeTabId === tab.id ? 'page' : undefined}
          aria-disabled={tabsDisabled || undefined} onclick={(event) => navigate(event, tab)}>{tab.label}</a>
      {/each}
    </nav>
  {/if}
  <div class="page-header__meta">
    <div id={actionsId} class="page-header__actions tr-topbar__actions">{#if actions}{@render actions()}{/if}</div>
    {#if account}{@render account()}{:else}<AuthMenu />{/if}
  </div>
</header>

<style>
  .page-header {
    --page-title-size: 1.25rem;
    --header-padding-block: 6px;
    --page-header-bg: var(--tr-header, var(--bg-card));
    position: relative;
    z-index: 40;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 20px;
    width: 100%;
    min-width: 0;
    min-height: 64px;
    padding: var(--header-padding-block) clamp(16px, 2vw, 32px);
    border-bottom: 1px solid var(--border-color);
    background: var(--page-header-bg);
    color: var(--text-1);
    font-family: var(--font);
  }
  .page-header__identity { display: flex; align-items: center; gap: 16px; min-width: 0; max-width: 100%; }
  .page-header__leading { flex: 0 0 auto; }
  .page-header__heading { display: grid; min-width: 0; gap: 2px; }
  .page-header__brand { width: fit-content; color: var(--brand); font-size: 0.875rem; line-height: 18px; font-weight: bold; text-decoration: none; }
  .page-header__breadcrumb ol { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin: 0; padding: 0; list-style: none; }
  .page-header__breadcrumb li { min-width: 0; }
  .page-header__breadcrumb h1, .page-header__breadcrumb a {
    margin: 0; color: var(--text-1); font: bolder var(--page-title-size)/1.3 var(--font);
    letter-spacing: -.025em; text-decoration: none; white-space: normal; overflow-wrap: anywhere;
  }
  .page-header__separator { color: var(--text-muted); font-size: var(--page-title-size); }
  .page-header__breadcrumb a:hover, .page-header__brand:hover { color: var(--brand); }
  .page-header__meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; margin-left: auto; min-width: 0; max-width: 100%; }
  .page-header__actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; min-width: 0; max-width: 100%; }
  .page-header__actions:empty { display: none; }
  .page-header__tabs { display: flex; align-self: stretch; align-items: end; gap: 8px; min-width: 0; max-width: 100%; overflow-x: auto; scrollbar-width: none; margin-bottom: calc(-1 * var(--header-padding-block) - 1px); }
  .page-header__tabs::-webkit-scrollbar { display: none; }
  .page-header__tabs a { position: relative; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; min-height: 44px; padding: 10px 22px; border: 0; border-bottom: 3px solid transparent; border-radius: 10px 10px 0 0; color: var(--text-2); background: transparent; font-size: 1rem; line-height: 24px; font-weight: bold; text-decoration: none; white-space: nowrap; transition: color 160ms ease, background-color 160ms ease, border-color 160ms ease; }
  .page-header__tabs a:not(.active):hover { color: var(--text-1); background: var(--bg-page); }
  .page-header__tabs a.active { color: var(--brand); border-bottom-color: var(--brand); background: transparent; }
  .page-header__tabs a:active { filter: brightness(.96); }
  .page-header__tabs a[aria-disabled='true'] { opacity: .6; }
  a:focus-visible { outline: 2px solid var(--brand); outline-offset: -3px; border-radius: 4px; }
  @media (max-width: 1100px) {
    .page-header__tabs { order: 3; flex-basis: 100%; }
  }
  @media (max-width: 720px) {
    .page-header { gap: 8px 12px; padding-inline: 16px; }
    .page-header__identity { gap: 10px; }
    .page-header__breadcrumb ol { gap: 2px 8px; }
    .page-header__meta { justify-content: flex-end; }
    .page-header__tabs a { padding-inline: 18px; }
  }
  @media (prefers-reduced-motion: reduce) { .page-header__tabs a { transition: none; } }
  @media print { .page-header { display: none; } }
</style>
