<script lang="ts">
  import { permissionVisibility } from "$lib/permission-visibility";
  const allowed=permissionVisibility();
  import { onMount, tick } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import CommentaryReport from "$lib/commentary/CommentaryReport.svelte";
  import { captureCommentaryPdf, downloadPdfBlob } from "$lib/commentary/browser-pdf";
  import { portal } from "$lib/portal";
  import DocumentBody from "$lib/policy-tracking/DocumentBody.svelte";
  import ModuleCard from "../../components/ModuleCard.svelte";
  import PanelHeading from "$lib/trading-research/PanelHeading.svelte";
  import Badge from "$lib/trading-research/Badge.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { NativeSelect } from "$lib/components/ui/native-select/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { globalMessages } from "$lib/global-messages";
  import { isAiRequestCancelled, useAiClient } from "$lib/ai-client.svelte";
  import { commentaryTypeLabels, shanghaiDate, commentaryText, type Commentary, type CommentaryDraft, type CommentaryRevision, type CommentaryPdfArchive } from "$lib/commentary";

  type Item = Pick<Commentary, "id" | "eventName" | "type" | "commentaryDate" | "origin" | "edited" | "generatedAt">;
  let items = $state<Item[]>([]), query = $state(""), typeFilter = $state("");
  let loading = $state(true), listError = $state(""), hasMore = $state(false), loadingMore = $state(false);
  let selected = $state<Commentary | null>(null), draft = $state<CommentaryDraft>(blank());
  let savedDraft = $state(JSON.stringify(blank())), policyId = $state<string | null>(null);
  const aiClient = useAiClient();
  let busy = $state(false), opening = $state(false), preview = $state(false);
  let startDate = $state(shanghaiDate(-6)), endDate = $state(shanghaiDate());
  let revisions = $state<CommentaryRevision[]>([]), shownRevision = $state<CommentaryRevision | null>(null);
  let generation = 0, listRequest = 0, mounted = false;
  let pdfElement = $state<HTMLElement>();
  let savingDraft = $state(false), failedSaveDraft = $state(""), saveConflict = $state(false);
  let autosavePromise: Promise<void> = Promise.resolve();
  const dirty = $derived(JSON.stringify(draft) !== savedDraft);
  const evidence = $derived(selected?.evidence ?? []);

  $effect(() => {
    const value=JSON.stringify(draft);
    if (!$allowed("research.policy_commentary:update") || !mounted || !selected || busy || savingDraft || saveConflict || value===savedDraft || value===failedSaveDraft) return;
    const timer=setTimeout(() => { autosavePromise=syncDraft(); },800);
    return () => clearTimeout(timer);
  });
  async function syncDraft() {
    if (!$allowed("research.policy_commentary:update") || !selected || savingDraft || busy) return;
    const requestId=generation, id=selected.id, snapshot=JSON.parse(JSON.stringify(draft)) as CommentaryDraft;
    savingDraft=true;
    try {
      const value=await json<Commentary>(`/api/commentaries/${encodeURIComponent(id)}`,{
        method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({...snapshot,updatedAt:selected.updatedAt}),
      });
      if(mounted && requestId===generation && selected?.id===id){selected=value;savedDraft=JSON.stringify(snapshot);failedSaveDraft="";}
    } catch(error) { if(mounted && requestId===generation){failedSaveDraft=JSON.stringify(snapshot);saveConflict=error instanceof Error && /已更新/.test(error.message);fail(error);} }
    finally { savingDraft=false; }
  }
  async function reloadDraft() {
    if(!selected || !window.confirm("重新读取将放弃当前未保存的修改，是否继续？"))return;
    const id=selected.id, requestId=++generation;
    opening=true;
    try { const value=await json<Commentary>(`/api/commentaries/${encodeURIComponent(id)}`);if(mounted && requestId===generation)accept(value); }
    catch(error){fail(error);}finally{if(requestId===generation)opening=false;}
  }
  function clearPrintMode() {
    document.documentElement.classList.remove("tracking-commentary-print");document.body.classList.remove("tracking-commentary-print");
  }
  function enablePrintMode() {
    document.documentElement.classList.add("tracking-commentary-print");document.body.classList.add("tracking-commentary-print");
  }
  async function printDraft() {
    await document.fonts.ready; enablePrintMode(); window.print();
  }
  function blank(): CommentaryDraft {
    return { eventName: "", type: "current_affairs", sources: "", eventPublishedAt: shanghaiDate(), commentaryDate: shanghaiDate(), eventSummary: "", commentary: "", recommendation: "" };
  }
  function accept(value: Commentary) {
    selected = value; policyId = value.policyId;
    draft = { eventName: value.eventName, type: value.type, sources: value.sources, eventPublishedAt: value.eventPublishedAt,
      commentaryDate: value.commentaryDate, eventSummary: value.eventSummary, commentary: value.commentary, recommendation: value.recommendation };
    savedDraft = JSON.stringify(draft); saveConflict=false; revisions = []; shownRevision = null;
    if (value.search) { startDate = value.search.startDate; endDate = value.search.endDate; }
    const url = new URL(window.location.href); url.search = new URLSearchParams({ id: value.id }).toString();
    window.history.replaceState(window.history.state, "", url);
  }
  function canLeave() { return !dirty || window.confirm("有未保存的修改，是否离开？"); }
  beforeNavigate(({ cancel }) => { if ((busy && !window.confirm("点评正在生成或保存，是否离开？")) || !canLeave()) cancel(); });
  function beforeUnload(event: BeforeUnloadEvent) { if (dirty || busy) { event.preventDefault(); event.returnValue = ""; } }
  onMount(() => {
    mounted = true;
    void initialize();
    return () => { mounted = false; generation++; listRequest++; clearPrintMode(); };
  });
  async function json<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, options); const value = await response.json();
    if (!response.ok) throw new Error(value.error || "请求失败");
    return value as T;
  }
  async function initialize() {
    await loadList(); if (!mounted) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("id")) { await open(params.get("id")!); return; }
    const policy = params.get("policy");
    if (policy) {
      opening = true;
      try {
        const found = await json<{ items: Item[]; policy: { id: string; title: string; summary: string; departments: string[]; policyDate: string } | null }>(`/api/commentaries?policyId=${encodeURIComponent(policy)}`);
        if (!mounted) return;
        if (found.items[0]) { await open(found.items[0].id); return; }
        const value = found.policy;
        if (!value) throw new Error("未找到政策，请从政策跟踪重新进入");
        policyId = value.id; draft = { ...blank(), eventName: value.title, type: "policy_tracking", sources: value.departments.join("、"), eventPublishedAt: value.policyDate, eventSummary: value.summary };
        endDate = value.policyDate; startDate = new Date(Date.parse(`${value.policyDate}T00:00:00+08:00`) - 6 * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
      } catch (error) { fail(error); } finally { opening = false; }
    }
  }
  async function loadList(more = false) {
    const requestId = ++listRequest;
    if (more) loadingMore = true; else loading = true;
    listError = "";
    try {
      const params = new URLSearchParams({ q: query, offset: String(more ? items.length : 0) });
      if (typeFilter) params.set("type", typeFilter);
      const result = await json<{ items: Item[]; hasMore: boolean }>(`/api/commentaries?${params}`);
      if (!mounted || requestId !== listRequest) return;
      items = more ? [...items, ...result.items] : result.items; hasMore = result.hasMore;
    } catch (error) { if (requestId === listRequest) listError = error instanceof Error ? error.message : "点评列表读取失败"; }
    finally { if (requestId === listRequest) { loading = false; loadingMore = false; } }
  }
  async function open(id: string) {
    if (busy || !canLeave()) return;
    const requestId = ++generation; opening = true;
    try { const value = await json<Commentary>(`/api/commentaries/${encodeURIComponent(id)}`); if (mounted && requestId === generation) accept(value); }
    catch (error) { if (requestId === generation) fail(error); }
    finally { if (requestId === generation) opening = false; }
  }
  function newDraft() {
    if (busy || !canLeave()) return;
    generation++; opening = false; selected = null; policyId = null; draft = blank(); savedDraft = JSON.stringify(draft);
    startDate = shanghaiDate(-6); endDate = shanghaiDate(); revisions = []; shownRevision = null; preview = false;
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }
  async function persist(): Promise<Commentary> {
    await autosavePromise;
    if (selected && !dirty) return selected;
    const value = await json<Commentary>(selected ? `/api/commentaries/${encodeURIComponent(selected.id)}` : "/api/commentaries", {
      method: selected ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(selected ? { ...draft, updatedAt: selected.updatedAt } : { ...draft, policyId }),
    });
    if (mounted) { accept(value); failedSaveDraft=""; }
    return value;
  }
  async function save() {
    if (busy || saveConflict) return; busy = true;
    try { await persist(); globalMessages.success("点评已保存"); await loadList(); }
    catch (error) { saveConflict=error instanceof Error && /已更新/.test(error.message);fail(error); } finally { busy = false; }
  }
  async function generateDraft() {
    if (busy) return;
    if ((draft.commentary || draft.recommendation) && !window.confirm("重新生成将替换当前正文，已保存版本会保留。是否继续？")) return;
    const range = { startDate, endDate };
    busy = true;
    try {
      const current = dirty || !selected ? await persist() : selected;
      const commentary = await aiClient.run({
        title: `跟踪点评 · ${current.eventName}`,
        url: `/api/commentaries/${encodeURIComponent(current.id)}/generate`,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...range, updatedAt: current.updatedAt }),
        },
        parse: (value) => value as Commentary,
        resultText: value => [value.eventName, value.eventSummary, value.commentary, value.recommendation].filter(Boolean).join('\n\n'),
      });
      if (mounted) accept(commentary);
      if (mounted) await loadList();
    } catch (error) { if (mounted && !isAiRequestCancelled(error)) fail(error); }
    finally { if (mounted) busy = false; }
  }
  async function loadRevisions() {
    if (!selected) return; const id = selected.id;
    try { const result = await json<{ revisions: CommentaryRevision[] }>(`/api/commentaries/${encodeURIComponent(id)}/revisions`); if (mounted && selected?.id === id) revisions = result.revisions; }
    catch (error) { fail(error); }
  }
  async function archivePdf() {
    if (busy) return; busy = true;
    try {
      await autosavePromise;
      const current = dirty || !selected ? await persist() : selected;
      if(!current.pdf) {
        await tick();
        if(!pdfElement)throw new Error("报告尚未完成排版");
        const bytes=await captureCommentaryPdf(pdfElement);
        const pdf = await json<CommentaryPdfArchive>(`/api/commentaries/${encodeURIComponent(current.id)}/pdf?updatedAt=${encodeURIComponent(current.updatedAt)}`, {
          method: "POST", headers: { "Content-Type": "application/pdf" }, body: bytes,
        });
        if (mounted && selected?.id === current.id) selected = { ...selected, pdf };
      }
      // Download the archived bytes, including when another tab already saved this version.
      const response=await fetch(`/api/commentaries/${encodeURIComponent(current.id)}/pdf?revisionAt=${encodeURIComponent(current.updatedAt)}`);
      if(!response.ok)throw new Error("PDF 已归档，但下载失败，请点击下载 PDF重试");
      downloadPdfBlob(await response.blob(),selected?.pdf?.fileName || `${current.eventName}.pdf`);
      globalMessages.success("PDF 已下载并归档");
    } catch(error) { fail(error); } finally { busy = false; }
  }
  async function copy() { try { await navigator.clipboard.writeText(commentaryText(draft)); globalMessages.success("点评已复制"); } catch { globalMessages.error("复制失败"); } }
  function fail(error: unknown) { globalMessages.error(error instanceof Error ? error.message : "操作失败"); }
</script>

<svelte:window onbeforeunload={beforeUnload} onbeforeprint={enablePrintMode} onafterprint={clearPrintMode} />
<div class="tracking-workspace" class:tracking-workspace--preview={preview}>
  <div class="writing">
    <div class="writing-toolbar">
      <Button permission="research.policy_commentary:update" variant="outline" disabled={busy} onclick={newDraft}>新建点评</Button>
      <Button permission="research.policy_commentary:update" variant="outline" disabled={busy || opening || saveConflict || !draft.eventName.trim()} onclick={save}>保存草稿</Button>
      {#if saveConflict}<Button variant="outline" disabled={busy} onclick={reloadDraft}>重新读取</Button>{/if}
      <Button variant="outline" disabled={opening} aria-pressed={preview} onclick={() => preview = !preview}>{preview ? "继续编辑" : "预览"}</Button>
      <Button variant="outline" disabled={!draft.commentary} onclick={copy}>复制正文</Button>
      <Button permission="research.policy_commentary:update" variant="outline" disabled={busy || saveConflict || !draft.commentary.trim()} onclick={archivePdf}>保存 PDF</Button>
      <Button variant="outline" disabled={busy || !draft.commentary.trim()} onclick={printDraft}>打印</Button>
      {#if selected?.pdf && !dirty}<Button variant="outline" href={`/api/commentaries/${encodeURIComponent(selected.id)}/pdf?revisionAt=${encodeURIComponent(selected.pdf.revisionAt)}`}>下载 PDF</Button>{/if}
      {#if selected}<Button variant="outline" onclick={loadRevisions}>版本记录</Button>{/if}
      <Badge tone={dirty ? "warning" : "neutral"}>{savingDraft ? "保存中" : dirty ? "未保存" : selected ? "已保存" : "新稿"}</Badge>
    </div>
    {#if opening}<ModuleCard><p aria-live="polite">正在读取点评</p></ModuleCard>
    {:else}
      {#if !preview}
      <ModuleCard>
        <PanelHeading id="tracking-write" title="撰写点评" />
        <fieldset disabled={busy || !$allowed("research.policy_commentary:update")}>
          <label><span>主题</span><Input bind:value={draft.eventName} maxlength={240} /></label>
          <div class="metadata-fields">
            <label><span>类型</span><NativeSelect bind:value={draft.type} disabled={!!policyId}>{#each Object.entries(commentaryTypeLabels) as [value,label]}<option {value}>{label}</option>{/each}</NativeSelect></label>
            <label><span>发布时间</span><Input type="date" bind:value={draft.eventPublishedAt} /></label>
            <label><span>点评时间</span><Input type="date" bind:value={draft.commentaryDate} /></label>
          </div>
          <div class="generation-toolbar">
            <label><span>研报起始日期</span><Input type="date" bind:value={startDate} /></label>
            <label><span>研报截止日期</span><Input type="date" bind:value={endDate} /></label>
            <Button permission="research.policy:generate&research.policy_commentary:update" disabled={busy || saveConflict || draft.eventName.trim().length < 2 || !startDate || !endDate || startDate > endDate} onclick={generateDraft}>{busy ? "生成中" : "检索并生成"}</Button>
          </div>
        </fieldset>
      </ModuleCard>
      {/if}
      <div class="editor-grid">
        <ModuleCard>
          <PanelHeading id="tracking-body" title={preview ? "点评预览" : "点评正文"} />
          {#if preview || !$allowed("research.policy_commentary:update")}
            <CommentaryReport {draft} />
          {:else}
            <fieldset disabled={busy || !$allowed("research.policy_commentary:update")}>
              <label><span>消息来源</span><Input bind:value={draft.sources} /></label>
              <label><span>事件摘要</span><Textarea rows={5} bind:value={draft.eventSummary} /></label>
              <label><span>跟踪点评</span><Textarea rows={18} bind:value={draft.commentary} /></label>
              <label><span>应对建议</span><Textarea rows={7} bind:value={draft.recommendation} /></label>
            </fieldset>
          {/if}
        </ModuleCard>
        <div class="evidence-column">
          <ModuleCard><PanelHeading id="tracking-evidence" title="取材原句" />
            {#if selected?.search}<p class="item-date">{selected.search.startDate} — {selected.search.endDate}</p>{/if}
            {#if !evidence.length}<p>暂无摘录</p>{/if}
            {#each evidence as quote, i}<details open={i === 0}>
              <summary>{quote.section}</summary>
              <p class="source-title">{quote.institution} · {quote.publishedAt}</p><p>{quote.title}</p>
              <blockquote>{quote.text}</blockquote>
            </details>{/each}
            {#if selected?.search?.references?.length}
              <h3>参考点评</h3>
              {#each selected.search.references as reference}<p><a href={`/trading-research/tracking-commentary?id=${encodeURIComponent(reference.id)}`}>{reference.date} · {reference.title}</a></p>{/each}
            {/if}
            {#if policyId}<a href={`/trading-research/policy-tracking#policy-${encodeURIComponent(policyId)}`}>关联政策</a>{/if}
          </ModuleCard>
          {#if selected?.originalText}<ModuleCard><PanelHeading id="tracking-original" title="手写原稿" />
            <ul>{#each selected.sourceFiles as file}<li>{file.name}</li>{/each}</ul>
            <details><summary>查看原文</summary><DocumentBody content={selected.originalText} /></details>
          </ModuleCard>{/if}
          {#if revisions.length}<ModuleCard><PanelHeading id="tracking-revisions" title="版本记录" />
            {#each revisions as revision}<Button variant="ghost" onclick={() => shownRevision = revision}>{revision.savedAt.slice(0,19).replace("T"," ")} · {revision.content.edited ? "人工稿" : "AI 草稿"}</Button>{/each}
            {#if shownRevision}<p class="original">{commentaryText(shownRevision.content)}</p>{/if}
          </ModuleCard>{/if}
        </div>
      </div>
    {/if}
  </div>
  <aside class="archive" aria-label="点评档案">
    <ModuleCard>
      <PanelHeading id="tracking-archive" title="点评档案" />
      <form class="archive-filter" onsubmit={(event) => { event.preventDefault(); void loadList(); }}>
        <label><span>检索主题</span><Input bind:value={query} /></label>
        <label><span>类型</span><NativeSelect bind:value={typeFilter}><option value="">全部</option>{#each Object.entries(commentaryTypeLabels) as [value,label]}<option {value}>{label}</option>{/each}</NativeSelect></label>
        <Button variant="outline" type="submit" disabled={loading}>查询</Button>
      </form>
      {#if loading}<p aria-live="polite">读取中</p>
      {:else if listError}<p role="alert">{listError}</p><Button variant="outline" onclick={() => loadList()}>重试</Button>
      {:else if !items.length}<p>暂无点评</p>
      {:else}<ol class="archive-list">{#each items as item (item.id)}<li>
        <button class:active={selected?.id === item.id} aria-current={selected?.id === item.id ? "true" : undefined} disabled={busy} onclick={() => open(item.id)}>
          <span class="item-date">{item.commentaryDate || "日期未注明"} · {commentaryTypeLabels[item.type]}</span>
          <strong>{item.eventName}</strong><span>{item.origin === "import" ? "手写稿" : item.edited ? "人工稿" : "AI 草稿"}</span>
        </button>
      </li>{/each}</ol>{/if}
      {#if hasMore}<Button variant="outline" disabled={loadingMore} onclick={() => loadList(true)}>{loadingMore ? "读取中" : "加载更多"}</Button>{/if}
    </ModuleCard>
  </aside>

</div>

<div class="tracking-print-anchor">
  <div class="tracking-print-host" use:portal={"body"} aria-hidden="true"><CommentaryReport {draft} bind:element={pdfElement} /></div>
</div>

<style>
  .tracking-workspace { display:grid; grid-template-columns: minmax(220px, 280px) minmax(0,1fr); gap:24px; align-items:start; }
  .archive { grid-column:1; grid-row:1; min-width:0; }
  .writing { grid-column:2; grid-row:1; }
  .writing, .evidence-column { display:grid; gap:20px; min-width:0; }
  .writing-toolbar, .generation-toolbar { display:flex; gap:10px; flex-wrap:wrap; align-items:end; }
  .writing-toolbar { align-items:center; }
  .archive-filter, fieldset { display:grid; gap:16px; min-width:0; padding:0; border:0; margin:0; }
  label { display:grid; gap:8px; min-width:0; }
  label > span { font-weight:bold; }
  .metadata-fields { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; }
  .archive-list { list-style:none; margin:20px 0; padding:0; display:grid; gap:4px; }
  .archive-list button { display:grid; gap:8px; width:100%; text-align:left; border:0; border-bottom:1px solid var(--border-color); padding:16px 8px; color:var(--text-1); background:transparent; font:inherit; cursor:pointer; }
  .archive-list button.active { background:var(--muted); border-inline-start:3px solid var(--primary); }
  .archive-list button:focus-visible, summary:focus-visible { outline:2px solid var(--primary); outline-offset:2px; }
  .archive-list button:disabled { cursor:wait; }
  .archive-list strong { overflow-wrap:anywhere; line-height:1.5; }
  .archive-list span, .item-date, .source-title { color:var(--text-muted); font-size:.875rem; }
  .editor-grid { display:grid; grid-template-columns:minmax(0, 1fr) minmax(240px, 32%); gap:20px; align-items:start; }
  .original, blockquote { white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.85; }
  details { border-top:1px solid var(--border-color); padding:16px 0; }
  summary { cursor:pointer; font-weight:bold; min-height:44px; line-height:1.6; }
  blockquote { margin:12px 0; padding-inline-start:12px; border-inline-start:3px solid var(--primary); }
  .evidence-column p, .evidence-column li { overflow-wrap:anywhere; line-height:1.7; }
  .tracking-workspace--preview .editor-grid { grid-template-columns: minmax(0,1fr); }
  @media(max-width:1600px) { .editor-grid { grid-template-columns:minmax(0,1fr); } }
  @media(max-width:760px) { .tracking-workspace { grid-template-columns:minmax(0,1fr); } .writing { grid-column:1; grid-row:1; } .archive { grid-column:1; grid-row:2; } .metadata-fields { grid-template-columns:minmax(0,1fr); } .generation-toolbar { display:grid; } }
  .tracking-print-host { position:fixed; left:-10000px; top:0; width:720px; background:white; pointer-events:none; }
  @media print {
    @page { size:A4 portrait; margin:12mm; }
    :global(html.tracking-commentary-print), :global(body.tracking-commentary-print) { height:auto !important; overflow:visible !important; background:white !important; }
    :global(body.tracking-commentary-print > :not(.tracking-print-host)) { display:none !important; }
    .tracking-print-host { position:static; width:auto; margin:0; padding:0; }
  }
</style>
