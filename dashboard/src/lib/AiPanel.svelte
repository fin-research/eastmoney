<script lang="ts">
  import { ArrowLeft, Bot, Check, ChevronRight, Circle, Expand, Square, X } from "@lucide/svelte";
  import { cubicIn, cubicOut } from "svelte/easing";
  import { tick } from "svelte";
  import { fade, fly } from "svelte/transition";
  import { Button } from "$lib/components/ui/button/index.js";
  import type { AiClient, AiTaskRecord } from "$lib/ai-client.svelte";
  import BrowserAgent from "$lib/BrowserAgent.svelte";

  let { client, identity }: { client: AiClient; identity: string | null } = $props();
  let trigger = $state<HTMLButtonElement | null>(null);
  let panel = $state<HTMLElement | null>(null);
  let tab = $state<'chat' | 'tasks'>('chat');
  let expanded = $state(false);

  const running = $derived(client.activeTasks);
  const selectedTask = $derived(client.tasks.find((task) => task.id === client.selectedTaskId));
  $effect(() => { if (client.selectedTaskId) tab = 'tasks'; });

  $effect(() => {
    if (!client.open) return;
    const selectedTaskId = client.selectedTaskId;
    void tick().then(() => {
      if (client.open && client.selectedTaskId === selectedTaskId) panel?.focus({ preventScroll: true });
    });
  });

  function openPanel() {
    client.selectTask(null);
    client.setOpen(true);
  }

  async function closePanel() {
    client.setOpen(false);
    await tick();
    if (!trigger) {
      await new Promise((resolve) => setTimeout(resolve, motionDuration(150)));
      await tick();
    }
    trigger?.focus({ preventScroll: true });
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === "Escape" && client.open) void closePanel();
  }

  function status(task: AiTaskRecord): string {
    if (task.status === "running") return "进行中";
    if (task.status === "completed") return "已完成";
    if (task.status === "cancelled") return "已取消";
    if (task.status === "disconnected") return "已断开";
    return "失败";
  }

  function time(timestamp: number): string {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp);
  }

  function currentSummary(task: AiTaskRecord): string {
    if (task.progress.at(-1)) return task.progress.at(-1) ?? "";
    return task.status === "running" ? "正在处理" : status(task);
  }

  function resultText(task: AiTaskRecord): string {
    return task.displayResult ?? (typeof task.result === 'string' ? task.result : '');
  }

  function motionDuration(duration: number): number {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : duration;
  }
</script>

<svelte:window onkeydown={keydown} />

{#if !client.open}
  <Button
    bind:ref={trigger}
    class="ai-trigger"
    variant="default"
    aria-label="打开 AI 面板"
    aria-controls="global-ai-panel"
    aria-expanded="false"
    onclick={openPanel}
  >
    <Bot aria-hidden="true" />
    <span>AI</span>
    {#if running.length}<span class="ai-trigger-dot" aria-label="AI 任务进行中"></span>{/if}
  </Button>
{:else}
  <aside
    bind:this={panel}
    id="global-ai-panel"
    class:expanded
    class="ai-panel"
    aria-label="AI 助手"
    tabindex="-1"
    in:fly|local={{ x: 24, duration: motionDuration(240), easing: cubicOut }}
    out:fly|local={{ x: 12, duration: motionDuration(150), easing: cubicIn }}
  >
    <header class="ai-panel-header">
      <div class="ai-panel-heading">
        {#if tab === 'tasks' && selectedTask}
          <Button variant="ghost" class="ai-panel-back" aria-label="返回任务列表" onclick={() => client.selectTask(null)}><ArrowLeft aria-hidden="true" /></Button>
        {/if}
        <div class="ai-panel-title"><Bot aria-hidden="true" /><h2>{tab === 'tasks' && selectedTask ? "任务详情" : "AI"}</h2></div>
      </div>
      <div class="ai-header-actions">
        <Button variant="ghost" class="ai-panel-expand" aria-label={expanded ? '收起宽面板' : '展开宽面板'} onclick={() => expanded = !expanded}><Expand aria-hidden="true" /></Button>
      <Button variant="ghost" class="ai-panel-close" aria-label="关闭 AI 面板" onclick={closePanel}><X aria-hidden="true" /></Button>
      </div>
    </header>
    <div class="ai-tabs" role="tablist" aria-label="AI 面板内容">
      <button type="button" role="tab" aria-selected={tab === 'chat'} class:active={tab === 'chat'} onclick={() => tab = 'chat'}>对话</button>
      <button type="button" role="tab" aria-selected={tab === 'tasks'} class:active={tab === 'tasks'} onclick={() => tab = 'tasks'}>任务{#if running.length} · {running.length}{/if}</button>
    </div>
    {#if tab === 'chat'}
      <BrowserAgent {identity} />
    {:else}
    <div class="ai-panel-body">
      {#if selectedTask}
        {#key selectedTask.id}
          <article
            class="ai-task-detail"
            aria-labelledby={`ai-task-title-${selectedTask.id}`}
            in:fly|local={{ x: 18, duration: motionDuration(220), easing: cubicOut }}
            out:fade|local={{ duration: motionDuration(120) }}
          >
            <div class="ai-task-heading">
              <div>
                <h3 id={`ai-task-title-${selectedTask.id}`}>{selectedTask.title}</h3>
                <p><span class:failed={selectedTask.status === "failed"}>{status(selectedTask)}</span><time datetime={new Date(selectedTask.startedAt).toISOString()}>{time(selectedTask.startedAt)}</time></p>
              </div>
              {#if selectedTask.status === "running" && selectedTask.cancellable}
                <Button variant="ghost" class="ai-stop" aria-label={`停止${selectedTask.title}`} onclick={() => client.cancel(selectedTask.id)}><Square aria-hidden="true" /></Button>
              {/if}
            </div>

            <div class:complete={selectedTask.status === "completed"} class="ai-progress" role="status" aria-live="polite" aria-atomic="true">
              {#if selectedTask.status === "running"}<span class="ai-pulse" aria-hidden="true"></span>{:else if selectedTask.status === "completed"}<Check class="ai-progress-check" aria-hidden="true" />{:else}<Circle class="ai-progress-state" aria-hidden="true" />{/if}
              <div class="ai-progress-copy">
                <span class="sr-only">{status(selectedTask)}</span>
                {#key currentSummary(selectedTask)}
                  <p in:fly|local={{ y: 6, duration: motionDuration(180), easing: cubicOut }} out:fade|local={{ duration: motionDuration(100) }}>{currentSummary(selectedTask)}</p>
                {/key}
              </div>
            </div>

            {#if selectedTask.progress.length}
              <details class="ai-thinking">
                <summary>思考过程</summary>
                <ol>
                  {#each selectedTask.progress as item}<li>{item}</li>{/each}
                </ol>
              </details>
            {/if}

            {#if selectedTask.error}
              <p class="ai-task-error" role="alert">{selectedTask.error}</p>
            {/if}

            {#if resultText(selectedTask)}
              <section class="ai-result" aria-labelledby={`ai-result-title-${selectedTask.id}`} in:fade|local={{ duration: motionDuration(220) }}>
                <h3 id={`ai-result-title-${selectedTask.id}`}>结果</h3>
                <div class="ai-result-text">{resultText(selectedTask)}</div>
              </section>
            {/if}
          </article>
        {/key}
      {:else}
        <section class="ai-task-index" aria-label="AI 任务列表" in:fade|local={{ duration: motionDuration(180) }} out:fade|local={{ duration: motionDuration(100) }}>
          {#if !client.tasks.length}
            <p class="ai-empty">暂无任务</p>
          {:else}
            <ol class="ai-task-list">
              {#each client.tasks as task (task.id)}
                <li>
                  <button class:failed={task.status === "failed"} type="button" aria-label={`查看${task.title}`} onclick={() => client.selectTask(task.id)}>
                    <span class="ai-task-row-title"><strong>{task.title}</strong><ChevronRight aria-hidden="true" /></span>
                    <span class="ai-task-row-meta"><span>{status(task)}</span><time datetime={new Date(task.startedAt).toISOString()}>{time(task.startedAt)}</time></span>
                  </button>
                </li>
              {/each}
            </ol>
          {/if}
        </section>
      {/if}
    </div>
    {/if}
  </aside>
{/if}

<style>
  :global(.ai-trigger) {
    position: fixed;
    z-index: 45;
    right: max(20px, env(safe-area-inset-right));
    bottom: max(20px, env(safe-area-inset-bottom));
    min-width: 76px;
    height: 48px;
    gap: 8px;
    border-radius: 999px;
    box-shadow: 0 16px 36px rgb(23 32 51 / 22%);
  }
  :global(.ai-trigger) :global(svg), .ai-panel-title :global(svg) { width: 20px; height: 20px; }
  .ai-trigger-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--primary-foreground); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary-foreground) 28%, transparent); }
  .ai-panel {
    position: sticky;
    z-index: 100;
    top: 0;
    display: flex;
    flex: 0 0 min(420px, 40vw);
    width: min(420px, 40vw);
    height: 100dvh;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border-color);
    border-radius: 0;
    background: var(--surface);
    color: var(--text-1);
    box-shadow: -8px 0 24px rgb(23 32 51 / 7%);
  }
  .ai-panel.expanded { flex-basis: min(720px, 60vw); width: min(720px, 60vw); }
  .ai-panel:focus { outline: none; }
  .ai-panel-header { display: flex; min-height: 64px; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--border-color); }
  .ai-header-actions { display:flex; gap:4px; }
  .ai-tabs { display:flex; border-bottom:1px solid var(--border-color); }
  .ai-tabs button { flex:1; min-height:44px; border:0; border-bottom:2px solid transparent; background:var(--surface); color:var(--text-muted); font:inherit; cursor:pointer; }
  .ai-tabs button.active { border-color:var(--brand); color:var(--brand); font-weight:bold; }
  .ai-panel-heading, .ai-panel-title { display: flex; min-width: 0; align-items: center; gap: 8px; }
  .ai-panel-title { color: var(--brand); }
  .ai-panel-title h2 { margin: 0; color: var(--text-1); font-size: 1.25rem; font-weight: bold; }
  :global(.ai-panel-close), :global(.ai-panel-expand), :global(.ai-panel-back), :global(.ai-stop) { width: 44px; height: 44px; padding: 0; }
  :global(.ai-panel-close) :global(svg), :global(.ai-panel-expand) :global(svg), :global(.ai-panel-back) :global(svg), :global(.ai-stop) :global(svg) { width: 20px; height: 20px; }
  .ai-panel-body { min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; }
  .ai-task-detail, .ai-task-index { padding: 20px; }
  .ai-task-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .ai-task-heading > div { min-width: 0; }
  .ai-task-heading h3 { margin: 0; overflow-wrap: anywhere; font-size: 1.125rem; font-weight: bold; line-height: 1.45; }
  .ai-task-heading p { display: flex; gap: 10px; margin: 7px 0 0; color: var(--text-muted); font-size: .8125rem; }
  .ai-task-heading .failed { color: var(--destructive); }
  .ai-progress { display: flex; min-height: 64px; align-items: flex-start; gap: 12px; margin-top: 24px; padding: 16px; border: 1px solid color-mix(in srgb, var(--brand) 18%, var(--border-color)); border-radius: var(--radius-control); background: color-mix(in srgb, var(--brand-soft) 46%, var(--surface)); line-height: 1.65; }
  .ai-progress.complete { border-color: color-mix(in srgb, var(--color-success-content) 24%, var(--border-color)); background: color-mix(in srgb, var(--color-success) 54%, var(--surface)); }
  .ai-progress-copy { display: grid; min-width: 0; flex: 1; }
  .ai-progress-copy p { grid-area: 1 / 1; min-width: 0; margin: 0; overflow-wrap: anywhere; }
  .ai-pulse { flex: 0 0 auto; width: 10px; height: 10px; margin-top: 7px; border-radius: 50%; background: var(--brand); animation: ai-pulse 1.4s ease-in-out infinite; }
  .ai-progress-check, .ai-progress-state { flex: 0 0 auto; width: 18px; height: 18px; margin-top: 4px; }
  .ai-progress-check { color: var(--color-success-content); }
  .ai-progress-state { color: var(--text-muted); }
  .ai-thinking { margin-top: 12px; border-bottom: 1px solid var(--border-color); }
  .ai-thinking summary { min-height: 44px; padding: 11px 2px; color: var(--text-muted); cursor: pointer; font-size: .875rem; font-weight: bold; }
  .ai-thinking ol { display: grid; gap: 10px; margin: 0 0 16px; padding-left: 24px; color: var(--text-muted); font-size: .875rem; line-height: 1.6; }
  .ai-thinking li { overflow-wrap: anywhere; }
  .ai-task-error { margin: 18px 0 0; color: var(--destructive); line-height: 1.6; }
  .ai-result { margin-top: 24px; }
  .ai-result h3 { margin: 0 0 12px; font-size: 1rem; font-weight: bold; }
  .ai-result-text { margin: 0; padding: 16px; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--border-color); border-radius: var(--radius-control); background: color-mix(in srgb, var(--brand-soft) 22%, var(--surface)); color: var(--text-1); font: inherit; line-height: 1.65; }
  .ai-empty { margin: 36px 0; color: var(--text-muted); text-align: center; }
  .ai-task-list { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
  .ai-task-list button { display: grid; width: 100%; min-height: 72px; gap: 8px; padding: 14px 12px 14px 16px; border: 1px solid var(--border-color); border-radius: var(--radius-control); background: var(--surface); color: var(--text-1); font: inherit; text-align: left; cursor: pointer; transition: border-color 160ms ease, background-color 160ms ease, box-shadow 160ms ease; }
  .ai-task-list button:hover { border-color: color-mix(in srgb, var(--brand) 36%, var(--border-color)); background: color-mix(in srgb, var(--brand-soft) 26%, var(--surface)); }
  .ai-task-list button:focus-visible { outline: 3px solid color-mix(in srgb, var(--brand) 38%, transparent); outline-offset: 2px; }
  .ai-task-list button.failed .ai-task-row-meta span:first-child { color: var(--destructive); }
  .ai-task-row-title, .ai-task-row-meta { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 12px; }
  .ai-task-row-title strong { min-width: 0; overflow-wrap: anywhere; font-size: .875rem; font-weight: bold; }
  .ai-task-row-title :global(svg) { flex: 0 0 auto; width: 18px; height: 18px; color: var(--text-muted); }
  .ai-task-row-meta { color: var(--text-muted); font-size: .8125rem; }
  @keyframes ai-pulse { 0%, 100% { opacity: .35; transform: scale(.85); } 50% { opacity: 1; transform: scale(1); } }
  @media (max-width: 600px) {
    :global(.ai-trigger) { right: max(12px, env(safe-area-inset-right)); bottom: max(12px, env(safe-area-inset-bottom)); }
    .ai-panel,.ai-panel.expanded { position:fixed; inset:0; width:100vw; height:100dvh; padding-top:env(safe-area-inset-top); padding-bottom:env(safe-area-inset-bottom); }
  }
  @media (prefers-reduced-motion: reduce) {
    .ai-panel, .ai-panel *, .ai-pulse { animation: none !important; transition-duration: .01ms !important; }
  }
</style>
