<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { onMount, tick } from "svelte";
  import WorkbenchIcon from "../trading-research/WorkbenchIcon.svelte";
  import { portal } from "../portal";
  import { globalMessages } from "../global-messages";
  import { useAiClient } from "../ai-client.svelte";
  import { creditAnswerText, type CreditAnswer, type CreditSession } from "./types";
  import CreditActivityView from "./CreditActivityView.svelte";

  const aiClient = useAiClient();

  let session = $state<CreditSession>({ turns: [], running: false, progress: "", error: null, startedAt: 0 });
  let question = $state("");
  let optimisticQuestion = $state("");
  let loading = $state(false);
  let loadError = $state("");
  let sending = $state(false);
  let creating = $state(false);
  let restoreController: AbortController | undefined;
  let chat: HTMLDivElement;
  let textarea = $state<HTMLTextAreaElement>(null!);
  let form: HTMLFormElement;
  let streamController: AbortController | undefined;
  let mounted = false;
  let revision = 0;
  const pendingQuestion = $derived(session.pendingQuestion || optimisticQuestion);
  const busy = $derived(sending || session.running || creating);

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/credit-assistant/${path}`, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", ...init?.headers } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "请求未完成，请重试");
    return data as T;
  }
  function stopStream() {
    streamController?.abort();
    streamController = undefined;
  }
  function watchSession() {
    if (!mounted || !session.running) { stopStream(); return; }
    if (streamController) return;
    const current = revision;
    const controller = new AbortController();
    streamController = controller;
    void aiClient.run({
      title: "授信助手",
      url: "/api/credit-assistant/session/events",
      signal: controller.signal,
      cancellable: false,
      parse: (value) => value as CreditSession,
      resultText: sessionResultText,
    }).then((next) => {
      if (!mounted || current !== revision || streamController !== controller) return;
        const followLatest = nearLatest();
        session = next;
        loadError = "";
        if (!next.running && !next.error) optimisticQuestion = "";
        if (followLatest) void scrollLatest();
      }).catch((error) => {
        if (mounted && current === revision && !controller.signal.aborted) {
          loadError = error instanceof Error ? error.message : "连接已断开，请重新连接以查看答复。";
        }
      }).finally(() => {
        if (streamController === controller) streamController = undefined;
      });
  }
  function nearLatest() {
    const workspace = chat?.closest<HTMLElement>(".tr-workspace");
    return !workspace || workspace.scrollHeight - workspace.scrollTop - workspace.clientHeight < 220;
  }
  async function scrollLatest() {
    await tick();
    if (!mounted) return;
    const workspace = chat?.closest<HTMLElement>(".tr-workspace");
    workspace?.scrollTo({ top: workspace.scrollHeight, behavior: "instant" });
  }
  async function refresh() {
    restoreController?.abort();
    const controller = new AbortController();
    restoreController = controller;
    const followLatest = !session.turns.length || nearLatest();
    loading = true;
    const current = revision;
    try {
      const next = await api<CreditSession>("session", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
      if (!mounted || current !== revision || controller.signal.aborted || restoreController !== controller) return;
      session = next;
      loadError = "";
      if (!session.running && !session.error) optimisticQuestion = "";
      if (followLatest) void scrollLatest();
    } catch (error) {
      if (mounted && current === revision && !controller.signal.aborted) loadError = "历史对话未能加载，可重新连接或直接提问。";
    } finally {
      if (mounted && current === revision && restoreController === controller) { loading = false; watchSession(); }
    }
  }
  function resizeInput() {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }
  async function sendQuestion(value: string) {
    const text = value.trim();
    if (!text || busy) return;
    revision++;
    restoreController?.abort(); loading = false; loadError = "";
    stopStream();
    sending = true;
    optimisticQuestion = text;
    const draft = question;
    question = "";
    session = { ...session, error: null, pendingQuestion: "", startedAt: 0 };
    void scrollLatest();
    try {
      const next = await aiClient.run({
        title: "授信助手",
        url: "/api/credit-assistant/session",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: text }),
        },
        cancellable: false,
        parse: (value) => value as CreditSession,
        resultText: sessionResultText,
      });
      if (!mounted) return;
      session = next;
      if (!next.error) optimisticQuestion = "";
    } catch (error) {
      if (!mounted) return;
      question ||= draft || text;
      optimisticQuestion = "";
      globalMessages.error(error instanceof Error ? error.message : "发送失败");
      // Another tab may have started a turn while history was loading.
      void refresh();
    } finally {
      sending = false;
      await tick();
      if (mounted) { resizeInput(); textarea?.focus({ preventScroll: true }); }
    }
  }
  function send(event: SubmitEvent) {
    event.preventDefault();
    void sendQuestion(question);
  }
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      form.requestSubmit();
    }
  }
  async function newSession() {
    if (busy) return;
    revision++;
    restoreController?.abort(); loading = false;
    stopStream();
    creating = true;
    try {
      const next = await api<CreditSession>("session/new", { method: "POST", body: "{}" });
      if (!mounted) return;
      session = next;
      optimisticQuestion = "";
      question = "";
      loadError = "";
      await tick();
      resizeInput();
      textarea?.focus({ preventScroll: true });
      void scrollLatest();
    } catch (error) { globalMessages.error(error instanceof Error ? error.message : "新建对话失败"); }
    finally { creating = false; }
  }
  async function copy(turnId: string) {
    const current = revision;
    try {
      const latest = await api<CreditSession>("session");
      if (!mounted || current !== revision) return;
      session = latest;
      const answer = latest.turns.find(t => t.id === turnId)?.answer;
      if (!answer) throw new Error("当前会话中没有该答复，请重新提问。");
      await navigator.clipboard.writeText(creditAnswerText(answer));
      globalMessages.success("已复制答复和资料来源");
    } catch (error) { globalMessages.error(error instanceof Error ? error.message : "复制失败，请重试"); }
  }
  function citations(answer: CreditAnswer): string[] { return [...new Set(answer.paragraphs.flatMap(p => p.citations.map(c => c.sourceId)))]; }
  function sessionResultText(value: CreditSession): string {
    const answer = value.turns.at(-1)?.answer;
    return value.error || (answer ? creditAnswerText(answer) : '');
  }
  async function showCitation(event: MouseEvent, turnId: string, sourceId: string) {
    event.preventDefault();
    const details = document.getElementById(`references-${turnId}`);
    if (details instanceof HTMLDetailsElement) details.open = true;
    await tick();
    const target = document.getElementById(`source-${turnId}-${sourceId}`);
    target?.scrollIntoView({ block: "start", behavior: "instant" });
    target?.focus({ preventScroll: true });
  }
  function fileType(title: string) { return title.match(/\.([a-z0-9]+)$/i)?.[1]?.toUpperCase() || "文件"; }
  onMount(() => {
    mounted = true;
    void refresh();
    return () => { mounted = false; revision++; restoreController?.abort(); stopStream(); };
  });
</script>

<div class="credit-chat" bind:this={chat}>
  <!-- Keep the component's root in place; only move its nested toolbar. -->
  <div class="chat-toolbar" use:portal={"#tr-topbar-actions"}>
    <Button data-ui-owner="lib-credit-assistant-CreditAssistantView-svelte" variant="outline" class={"ui-button chat-button chat-button--new"} type="button" disabled={busy} onclick={() => void newSession()}>
      <WorkbenchIcon name="plus" /><span>{creating ? "正在新建…" : "新对话"}</span>
    </Button>
  </div>
  <p class="sr-only" role="status">{!session.running && !sending && !loading && !session.error && session.turns.length ? "授信答复已完成，可阅读正文与资料来源。" : ""}</p>
  <div class="chat-messages" role="log" aria-label="对话记录" aria-live="off">
    {#if loading && !session.turns.length}
      <div class="chat-empty" role="status"><span class="ui-spinner  " aria-hidden="true"></span><p>正在恢复历史对话，可继续输入…</p></div>
    {:else if !session.turns.length && !pendingQuestion && !session.running && !session.error && !loadError}
      <div class="chat-empty"><span class="chat-welcome-icon"><WorkbenchIcon name="chat" /></span><h2>有什么需要核实？</h2></div>
    {/if}
    {#if loadError}
      <div class="chat-load-error" role="alert"><p>{loadError}</p><Button data-ui-owner="lib-credit-assistant-CreditAssistantView-svelte" variant="outline" class={"ui-button chat-button"} type="button" onclick={() => void refresh()}>重新连接</Button></div>
    {/if}
    {#each session.turns as turn (turn.id)}
      <article class="chat-turn" aria-label="一轮对话">
        <div class="message message--user"><span class="sr-only">你：</span><p>{turn.question}</p></div>
        <div class="message message--assistant">
          <div class="assistant-identity"><WorkbenchIcon name="chat" /><span>授信助手</span></div>
          <div class="answer-content">
            {#each turn.answer.paragraphs as paragraph}
              <p class="answer-paragraph">{paragraph.text}{#each paragraph.citations as cite}<a class="citation" href={`#source-${turn.id}-${cite.sourceId}`} aria-label={`查看资料来源${citations(turn.answer).indexOf(cite.sourceId) + 1}`} onclick={event => void showCitation(event, turn.id, cite.sourceId)}>[{citations(turn.answer).indexOf(cite.sourceId) + 1}]</a>{/each}</p>
            {/each}
            {#if turn.answer.files.length}
              {#if !turn.answer.paragraphs.length}<p class="answer-paragraph">所需材料已附上，可以直接下载。</p>{/if}
              <ul class="file-attachments" aria-label="答复附件">
                {#each turn.answer.files as file}
                  <li><a class="file-attachment" href={`${file.url}${file.url.includes("?") ? "&" : "?"}download=1`} download={file.title} aria-label={`下载 ${file.title}`}>
                    <span class="file-icon"><WorkbenchIcon name="file" /></span>
                    <span class="file-info"><strong>{file.title}</strong><span>{fileType(file.title)} · 下载文件</span></span>
                    <span class="file-download"><WorkbenchIcon name="download" /></span>
                  </a></li>
                {/each}
              </ul>
            {/if}
            {#if turn.answer.gaps.length}<div class="answer-gaps"><h3>尚需确认</h3><ul>{#each turn.answer.gaps as gap}<li>{gap}</li>{/each}</ul></div>{/if}
            {#if turn.answer.sources.length}
              <details class="answer-sources" id={`references-${turn.id}`}>
                <summary>资料来源</summary>
                {#each turn.answer.sources as source}
                  <div class="source" id={`source-${turn.id}-${source.id}`} tabindex="-1">
                    {#if source.url}<a href={source.url} target="_blank" rel="noreferrer">{source.title} · {source.locator}</a>{:else}<span>{source.title} · {source.locator}</span>{/if}
                    <span class="source-kind">检索片段</span>
                    {#each turn.answer.paragraphs.flatMap(p => p.citations).filter(c => c.sourceId === source.id) as cite}<blockquote>{cite.quote}</blockquote>{/each}
                  </div>
                {/each}
              </details>
            {/if}
            <Button data-ui-owner="lib-credit-assistant-CreditAssistantView-svelte" variant="outline" class={"ui-button chat-button chat-button--copy"} type="button" onclick={() => void copy(turn.id)} aria-label="复制答复和资料来源"><WorkbenchIcon name="copy" /><span>复制答复</span></Button>
          </div>
        </div>
      </article>
    {/each}
    {#if pendingQuestion || session.running || sending || session.error}
      <article class="chat-turn" aria-label="当前对话">
        {#if pendingQuestion}<div class="message message--user"><span class="sr-only">你：</span><p>{pendingQuestion}</p></div>{/if}
        <div class="message message--assistant">
          <div class="assistant-identity"><WorkbenchIcon name="chat" /><span>授信助手</span></div>
          {#if session.running || sending}
            <CreditActivityView {session} {sending} />
          {:else if session.error}
            <div class="answer-error" role="alert"><p>{session.error}</p>{#if pendingQuestion}<Button data-ui-owner="lib-credit-assistant-CreditAssistantView-svelte" variant="outline" class={"ui-button chat-button"} type="button" disabled={busy || !!loadError} onclick={() => void sendQuestion(pendingQuestion)}>重新发送</Button>{/if}</div>
          {/if}
        </div>
      </article>
    {/if}
  </div>
  <div class="composer-dock">
    <form class="chat-composer" onsubmit={send} bind:this={form}>
      <label class="sr-only" for="credit-question">输入消息</label>
      <Textarea data-ui-owner="lib-credit-assistant-CreditAssistantView-svelte" class={"ui-textarea textarea-ghost"} id="credit-question" placeholder="输入问题" bind:ref={textarea} bind:value={question} oninput={resizeInput} onkeydown={handleKeydown} rows={2} disabled={creating}></Textarea>
      <div class="composer-actions">
        <Button data-ui-owner="lib-credit-assistant-CreditAssistantView-svelte" variant="default" class={"ui-button  chat-button chat-button--send"} type="submit" disabled={!question.trim() || busy} aria-label={busy ? "正在处理消息" : "发送消息"}><WorkbenchIcon name="arrow-up" /></Button>
      </div>
    </form>
  </div>
</div>

<style>
  .credit-chat { display: flex; flex: 1; flex-direction: column; min-width: 0; width: 100%; }
  .chat-toolbar { display: flex; align-items: center; }
  .chat-messages { flex: 1; width: min(100%, 880px); margin-inline: auto; padding: 36px 24px 20px; }
  .chat-empty { display: flex; min-height: min(40dvh, 320px); flex-direction: column; align-items: center; justify-content: center; gap: 20px; color: var(--text-3); text-align: center; }
  .chat-empty h2 { margin: 0; color: var(--text-1); font-size: 1.5rem; font-weight: bold; }
  .chat-welcome-icon { display: grid; place-items: center; width: 52px; height: 52px; border-radius: var(--radius-card); background: var(--brand-soft); color: var(--brand); }
  .chat-welcome-icon :global(svg) { width: 28px; height: 28px; }
  .chat-turn { display: grid; gap: 28px; margin-bottom: 36px; }
  .message { min-width: 0; line-height: 1.85; overflow-wrap: anywhere; }
  .message--user { justify-self: end; max-width: min(85%, 680px); padding: 12px 18px; border-radius: var(--radius-card); background: var(--brand-soft); color: var(--text-1); }
  .message--user p { margin: 0; white-space: pre-wrap; }
  .message--assistant { display: grid; gap: 12px; }
  .assistant-identity { display: flex; align-items: center; gap: 10px; color: var(--text-1); font-size: .875rem; font-weight: bold; }
  .assistant-identity :global(svg) { color: var(--brand); width: 22px; height: 22px; }
  .answer-content { min-width: 0; }
  .answer-paragraph { margin: 0 0 16px; white-space: pre-wrap; }
  .answer-paragraph:last-child { margin-bottom: 0; }
  .answer-content a { color: var(--brand); overflow-wrap: anywhere; }
  .citation { margin-left: 4px; padding-block: 6px; font-size: .875rem; text-decoration: none; }
  .citation:hover { text-decoration: underline; }
  .file-attachments { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 12px; list-style: none; margin: 16px 0; padding: 0; }
  .file-attachment { display: flex; align-items: center; gap: 12px; min-height: 88px; padding: 16px; border: 1px solid var(--border-color); border-radius: var(--radius-card); background: var(--surface); text-decoration: none; transition: border-color 160ms ease, background 160ms ease; }
  .file-attachment:hover { border-color: var(--brand); background: var(--brand-soft); }
  .file-icon { flex-shrink: 0; display: grid; place-items: center; width: 44px; height: 44px; border-radius: var(--radius-control); background: var(--bg-page); }
  .file-icon :global(svg) { width: 24px; height: 24px; }
  .file-info { display: grid; gap: 4px; min-width: 0; flex: 1; }
  .file-info strong { color: var(--text-1); font-size: .875rem; font-weight: bold; line-height: 1.6; }
  .file-info > span { color: var(--text-3); font-size: .875rem; }
  .file-download { display: grid; place-items: center; flex-shrink: 0; }
  .file-download :global(svg) { width: 20px; height: 20px; }
  h3 { margin: 12px 0 8px; font-size: 1rem; font-weight: bold; }
  .answer-gaps ul, .source ul { margin: 0 0 12px; padding-left: 24px; }
  .answer-sources { margin: 12px 0 4px; color: var(--text-2); font-size: .875rem; }
  summary { width: fit-content; min-height: 44px; padding-block: 10px; cursor: pointer; color: var(--text-3); }
  summary:hover { color: var(--brand); }
  .source { padding: 16px 0; border-top: 1px solid var(--border-color); scroll-margin-top: 24px; }
  .source-kind { display: block; color: var(--text-3); margin-top: 4px; }
  blockquote { margin: 10px 0; padding: 4px 12px; border-left: 2px solid var(--border-strong); white-space: pre-wrap; }
  .answer-error p, .chat-load-error p { margin: 0 0 12px; color: var(--text-2); }
  .chat-load-error { margin-bottom: 24px; }
  .composer-dock { position: sticky; z-index: 2; bottom: 0; width: 100%; padding: 16px 24px max(20px, env(safe-area-inset-bottom)); background: var(--bg-page); }
  .chat-composer { max-width: 832px; margin-inline: auto; padding: 16px; border: 1px solid var(--border-strong); border-radius: var(--radius-card); background: var(--surface); box-shadow: var(--shadow-card); transition: border-color 160ms ease; }
  .chat-composer:focus-within { border-color: var(--brand); outline: 2px solid var(--brand); outline-offset: 2px; }
  :global(textarea[data-ui-owner="lib-credit-assistant-CreditAssistantView-svelte"]) { display: block; width: 100%; max-height: 180px; padding: 0; border: 0; box-shadow: none; resize: none; min-height: 56px; background: transparent; border-radius: 0; }
  :global(.chat-composer textarea[data-ui-owner="lib-credit-assistant-CreditAssistantView-svelte"]:focus-visible) { outline: none; }
  :global(textarea[data-ui-owner="lib-credit-assistant-CreditAssistantView-svelte"]::placeholder) { color: var(--text-3); }
  .composer-actions { display: flex; align-items: center; justify-content: flex-end; gap: 16px; margin-top: 8px; }
  :global(.chat-button[data-ui-owner="lib-credit-assistant-CreditAssistantView-svelte"]) { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-width: 44px; padding: 8px 14px; }
  :global(.chat-button[data-ui-owner="lib-credit-assistant-CreditAssistantView-svelte"] svg) { width: 18px; height: 18px; }
  :global(.chat-button--copy[data-ui-owner="lib-credit-assistant-CreditAssistantView-svelte"]) { padding-inline: 10px; margin-left: -10px; }
  :global(.chat-button--send[data-ui-owner="lib-credit-assistant-CreditAssistantView-svelte"]) { flex-shrink: 0; width: 44px; padding: 0; }
  :global(.chat-button--send[data-ui-owner="lib-credit-assistant-CreditAssistantView-svelte"] svg) { width: 22px; height: 22px; }
  :global(.chat-button[data-ui-owner="lib-credit-assistant-CreditAssistantView-svelte"]:focus-visible), a:focus-visible, summary:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
  @media (max-width: 600px) {
    .chat-messages { padding: 24px 16px 12px; }
    .composer-dock { padding: 12px 16px max(16px, env(safe-area-inset-bottom)); }
    .chat-composer { padding: 12px; }
    .message--user { max-width: 92%; }
    .chat-turn { gap: 22px; }
  }
  @media (prefers-reduced-motion: reduce) { :global(.chat-button[data-ui-owner="lib-credit-assistant-CreditAssistantView-svelte"]), .file-attachment, .chat-composer { transition: none; } }
</style>
