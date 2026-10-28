<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { setContext, type Snippet } from "svelte";
  import { afterNavigate } from "$app/navigation";
  import PageHeader from "./PageHeader.svelte";
  import type { PageTab, WorkbenchPageLink } from "./navigation";
  import WorkbenchIcon from "../trading-research/WorkbenchIcon.svelte";
  import "../../layout-report.css";
  import "../trading-research/workbench.css";
  import "./workspace.css";

  import { permissionVisibility } from "$lib/permission-visibility";
  const allowed=permissionVisibility();
  let { title, homeHref, views, activeViewId, activeLabel = "", activeHref, tabs = [], activeTabId = "", children, chat = false, canvas = false,
    class: className = '', actions, account, status,
    integrated = false, layoutReport = false, reportKind = null, visualVariant = 'workspace', tone = 'blue' }: {
    title: string; homeHref: string;
    class?: string; actions?: Snippet; account?: Snippet; status?: Snippet;
    views: readonly WorkbenchPageLink[];
    activeHref?: string; tabs?: readonly PageTab[]; activeTabId?: string;
    activeViewId: string; activeLabel?: string; children: Snippet; chat?: boolean; canvas?: boolean;
    integrated?: boolean; layoutReport?: boolean; reportKind?: "secondary" | "financing" | "liability" | null;
    visualVariant?: 'workspace' | 'report'; tone?: 'blue' | 'teal' | 'orange' | 'purple';
  } = $props();
  setContext('ui-scope', () => className);
  let desktopCollapsed = $state(false);
  let mobileDrawerOpen = $state(false);
  let mainRegion: HTMLElement;
  let workspaceRegion: HTMLElement;
  let keyboardNavigation = false;
  let topbarHeight = $state(72);
  const activeView = $derived(views.find(view => view.id === activeViewId) ?? { label: activeLabel, href: homeHref });
  const currentLabel = $derived(activeLabel || activeView.label);

  afterNavigate(({ from, to, type }) => {
    mobileDrawerOpen = false;
    if (type !== "popstate" && (from?.url?.pathname !== to?.url?.pathname || from?.url?.searchParams.get("tab") !== to?.url?.searchParams.get("tab"))) {
      workspaceRegion?.scrollTo({ top: 0, left: 0 });
    }
    if (keyboardNavigation) requestAnimationFrame(() => mainRegion?.focus({ preventScroll: true }));
  });
  function toggleDesktopSidebar() { desktopCollapsed = !desktopCollapsed; }
  function toggleMobileDrawer() { mobileDrawerOpen = !mobileDrawerOpen; }
  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key === "Tab" || event.key === "Enter") keyboardNavigation = true;
    if (event.key === "Escape") mobileDrawerOpen = false;
  }
</script>

<svelte:head>
  <title>{currentLabel} · {title}</title>
  <meta
    name="description"
    content={`${title}业务模块`}
  />
  <meta name="theme-color" content="#f6f8fb" />
</svelte:head>

<svelte:window onkeydown={handleWindowKeydown} onpointerdown={() => (keyboardNavigation = false)} />

<div
  class:tr-shell--collapsed={desktopCollapsed}
  class:tr-shell--mobile-open={mobileDrawerOpen}
  class:tr-shell--workspace={!layoutReport && !integrated && visualVariant === 'workspace'}
  class={`tr-workbench tr-shell ${className}`}
  data-workspace-tone={tone}
  style:--tr-topbar-height={`${topbarHeight}px`}
>
  <a class="tr-skip-link" href="#tr-workbench-main">跳至工作台内容</a>

  <PageHeader class="tr-topbar" section={{ label: title, href: homeHref }}
    current={{ label: currentLabel, href: activeHref ?? activeView.href }} {tabs} {activeTabId}
    {actions} {account} actionsId="tr-topbar-actions" onheight={(height) => (topbarHeight = height)}>
    {#snippet leading()}
      <Button data-ui-owner="lib-workbench-WorkbenchShell-svelte" variant="ghost" size="icon"
        class={"ui-button   tr-sidebar-toggle"}
        type="button"
        aria-label={desktopCollapsed ? "展开侧边导航" : "折叠侧边导航"}
        aria-expanded={!desktopCollapsed}
        aria-controls="tr-workbench-drawer"
        onclick={toggleDesktopSidebar}
      >
        <WorkbenchIcon name="sidebar" />
      </Button>
      <Button data-ui-owner="lib-workbench-WorkbenchShell-svelte" variant="ghost" size="icon"
        class={"ui-button   tr-mobile-menu"}
        type="button"
        aria-label={mobileDrawerOpen ? "关闭导航菜单" : "打开导航菜单"}
        aria-expanded={mobileDrawerOpen}
        aria-controls="tr-workbench-drawer"
        onclick={toggleMobileDrawer}
      >
        <WorkbenchIcon name="menu" />
      </Button>
    {/snippet}
  </PageHeader>

  <aside id="tr-workbench-drawer" class="tr-drawer" aria-label={`${title}导航`}>
    <nav class="tr-drawer__nav" aria-label="业务模块" data-sveltekit-preload-data="hover">
      <ul class="ui-menu tr-navigation-list">
      {#each views.filter(view => $allowed(view.permission, view.href)) as view}
        {#if view.separatorBefore}<li class="nav-divider" role="separator"></li>{/if}
        <li><a
          class:active={activeViewId === view.id}
          href={view.href}
          aria-current={activeViewId === view.id ? "page" : undefined}
          title={view.label}
          onclick={() => (mobileDrawerOpen = false)}
        >
          <span class="tr-nav-icon" aria-hidden="true"><WorkbenchIcon name={view.icon} /></span>
          <span class="tr-nav-label">{view.label}</span>
        </a></li>
      {/each}
      </ul>
    </nav>
  </aside>

  <button data-ui-owner="lib-workbench-WorkbenchShell-svelte"
    class="tr-drawer-backdrop"
    type="button"
    aria-label="关闭导航菜单"
    tabindex={mobileDrawerOpen ? 0 : -1}
    onclick={() => (mobileDrawerOpen = false)}
  ></button>

  <section class="tr-workspace" bind:this={workspaceRegion}>
    {#if status}{@render status()}{/if}
    <main
      id="tr-workbench-main"
      class:tr-chat-page={chat}
      class:tr-canvas-page={canvas}
      class:tr-integrated-page={integrated}
      class:layout-report={layoutReport}
      class:layout-report--secondary={reportKind === "secondary"}
      class:layout-report--financing={reportKind === "financing"}
      class:layout-report--liability={reportKind === "liability"}
      class:secondary-weekly-report={reportKind === "secondary"}
      class:secondary-weekly-report--embedded={reportKind === "secondary"}
      bind:this={mainRegion}
      tabindex="-1"
    >
      {@render children()}
    </main>
  </section>
</div>

<style>.nav-divider { margin: 12px 8px; border-top: 1px solid var(--tr-sidebar-divider); }</style>
