<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { ArrowUp, BookOpen, Building2, ChartLine, Check, ChevronDown, Copy, FileText, FolderOpen, Plus, Search, Settings2, Square, Trash } from '@lucide/svelte';
  import type { ModelMessage } from 'ai';
  import { listBrowserTools, runBrowserAgent, type BrowserTool } from './browser-agent';

  let { identity }: { identity: string | null } = $props();
  type ChatMessage = { role: 'user' | 'assistant'; text: string; activity?: string[]; sources?: Array<{ title: string; url: string }>; error?: string };
  type Conversation = { id: string; title: string; createdAt: number; messages: ChatMessage[]; modelMessages: ModelMessage[] };
  let conversations = $state<Conversation[]>([]);
  let selectedId = $state<string | null>(null);
  let draft = $state('');
  let tools = $state<BrowserTool[]>([]);
  let selectedTools = $state<string[]>([]);
  let attachPage = $state(false);
  let readOnly = $state(true);
  let maxSteps = $state(12);
  let showHistory = $state(false);
  let showSettings = $state(false);
  let showShortcuts = $state(false);
  let toolSearch = $state('');
  let busy = $state(false);
  let loadingTools = $state(false);
  let error = $state('');
  let approval = $state<{ name: string; title: string; input: unknown; decide: (approved: boolean) => void } | null>(null);
  let controller: AbortController | null = null;
  let loadedIdentity: string | null = null;
  let transcript: HTMLElement;
  let textarea: HTMLTextAreaElement;
  const selected = $derived(conversations.find(item => item.id === selectedId));
  const filteredTools = $derived(tools.filter(item => `${item.title || item.name} ${item.name}`.toLowerCase().includes(toolSearch.toLowerCase())));

  function storageKey(user: string) { return `eastmoney-browser-agent:${user}`; }
  function persist() {
    if (!identity || typeof localStorage === 'undefined') return;
    try { localStorage.setItem(storageKey(identity), JSON.stringify({ conversations: conversations.slice(0, 20), selectedId })); }
    catch { error = '本地会话空间不足'; }
  }
  function load(user: string | null) {
    stop();
    conversations = []; selectedId = null; tools = []; selectedTools = []; loadingTools = false; error = '';
    if (!user || typeof localStorage === 'undefined') return;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey(user)) || '{}');
      if (Array.isArray(saved.conversations)) {
        conversations = saved.conversations.filter((item: Conversation) => item && typeof item.id === 'string'
          && Array.isArray(item.messages) && Array.isArray(item.modelMessages)).slice(0, 20);
      }
      selectedId = conversations.some(item => item.id === saved.selectedId) ? saved.selectedId : conversations[0]?.id ?? null;
    } catch { error = '本地会话无法读取'; }
  }
  $effect(() => {
    if (typeof window === 'undefined' || loadedIdentity === identity) return;
    loadedIdentity = identity;
    untrack(() => load(identity));
  });

  async function refreshTools() {
    if (!identity) return;
    const forUser = identity;
    loadingTools = true;
    try {
      const available = await listBrowserTools();
      if (identity !== forUser) return;
      tools = available;
      const before = new Set(selectedTools);
      selectedTools = before.size ? available.filter(item => before.has(item.name)).map(item => item.name) : available.map(item => item.name);
    } catch (failure) { if (identity === forUser) error = failure instanceof Error ? failure.message : '工具目录无法读取'; }
    finally { if (identity === forUser) loadingTools = false; }
  }
  function openSettings() {
    showSettings = !showSettings;
    if (showSettings && !tools.length && !loadingTools) void refreshTools();
  }
  function newConversation() {
    if (!identity) return;
    const item: Conversation = { id: crypto.randomUUID(), title: '新对话', createdAt: Date.now(), messages: [], modelMessages: [] };
    conversations = [item, ...conversations].slice(0, 20);
    selectedId = item.id; showHistory = false; draft = ''; persist();
    void tick().then(() => textarea?.focus());
  }
  function selectConversation(id: string) { selectedId = id; showHistory = false; persist(); void scrollEnd(); }
  function deleteConversation(id: string) {
    if (selectedId === id && busy) stop();
    conversations = conversations.filter(item => item.id !== id);
    if (selectedId === id) selectedId = conversations[0]?.id ?? null;
    persist();
  }
  function stop() {
    controller?.abort(); controller = null;
    approval?.decide(false); approval = null;
  }
  function decide(yes: boolean) { approval?.decide(yes); approval = null; }
  function toggleTool(name: string) {
    selectedTools = selectedTools.includes(name) ? selectedTools.filter(item => item !== name) : [...selectedTools, name];
  }
  async function scrollEnd() { await tick(); transcript?.scrollTo({ top: transcript.scrollHeight }); }
  async function send(value = draft) {
    const text = value.trim();
    if (!identity || !text || busy) return;
    if (loadingTools) return;
    if (tools.length === 0) await refreshTools();
    if (!identity) return;
    if (!selected) newConversation();
    const conversation = conversations.find(item => item.id === selectedId);
    if (!conversation) return;
    if (conversation.title === '新对话') conversation.title = text.slice(0, 28);
    conversation.messages.push({ role: 'user', text }, { role: 'assistant', text: '', activity: [] });
    const reply = conversation.messages.at(-1)!;
    conversation.modelMessages.push({ role: 'user', content: attachPage
      ? `${text}\n\n当前页面：${document.title}（${location.pathname}）` : text });
    draft = ''; busy = true; error = '';
    controller = new AbortController();
    const active = controller;
    persist(); void scrollEnd();
    try {
      const result = await runBrowserAgent({
        messages: conversation.modelMessages,
        tools, selectedNames: new Set(selectedTools), readOnly, maxSteps, signal: active.signal,
        approve: item => new Promise(resolve => { approval = { ...item, decide: resolve }; }),
        onEvent: event => {
          if (event.type === 'text') reply.text += event.text;
          if (event.type === 'tool-call') reply.activity?.push(`调用 ${event.toolName}`);
          if (event.type === 'tool-result') {
            reply.activity?.push(`完成 ${event.toolName}`);
            reply.sources = [...new Map([...(reply.sources || []), ...(event.sources || [])]
              .map(source => [source.url, source] as const)).values()];
          }
          void scrollEnd();
        },
      });
      conversation.modelMessages.push(...result.messages);
      if (!reply.text) reply.text = result.text || '模型未返回正文';
    } catch (failure) {
      reply.error = active.signal.aborted ? '已停止' : failure instanceof Error ? failure.message : '请求失败';
      if (!reply.text) reply.text = reply.error;
    } finally {
      if (controller === active) controller = null;
      busy = false; approval = null; persist(); void scrollEnd();
    }
  }
  function handleInput(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); void send();
    }
    if (event.key === '?' && !draft) { event.preventDefault(); showShortcuts = !showShortcuts; }
    if (event.key === '@' && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); showSettings = true; if (!tools.length && !loadingTools) void refreshTools(); }
  }
  async function copy(text: string) { await navigator.clipboard.writeText(text); }
</script>

<div class="agent">
  <div class="agent-toolbar">
    <button class="conversation-picker" type="button" aria-label="切换对话" onclick={() => showHistory = !showHistory} aria-expanded={showHistory}>
      <span>{selected?.title || '新对话'}</span><ChevronDown size={18} aria-hidden="true" />
    </button>
    <button class="icon-button" type="button" aria-label="新对话" onclick={newConversation} disabled={!identity}><Plus size={20} /></button>
  </div>
  {#if showHistory}
    <div class="history" aria-label="对话历史">
      {#each conversations as item (item.id)}
        <div class:current={selectedId === item.id} class="history-row">
          <button type="button" onclick={() => selectConversation(item.id)}>{item.title}</button>
          <button class="icon-button" type="button" aria-label={`删除${item.title}`} onclick={() => deleteConversation(item.id)}><Trash size={16} /></button>
        </div>
      {:else}<p>暂无对话</p>{/each}
    </div>
  {/if}
  <div class="transcript" bind:this={transcript}>
    {#if !identity}
      <div class="welcome"><h3>AI 助手</h3><a href="/auth/login">登录后使用</a></div>
    {:else if !selected?.messages.length}
      <div class="welcome">
        <div class="help-bar"><span>需要帮助？</span><button type="button" onclick={() => showShortcuts = !showShortcuts}>快捷键</button></div>
        <div class="agent-mark" aria-hidden="true"><span></span><span></span></div>
        <h3>你好。</h3><p class="welcome-subtitle">今天想做什么？</p>
        <div class="suggestions">
          <button type="button" onclick={() => send('概览今天的市场热点，并附上来源')}><ChartLine aria-hidden="true" /><span>市场热点<small>查看最新快照</small></span></button>
          <button type="button" onclick={() => send('查询最新的授信报表，说明额度与已用情况')}><Building2 aria-hidden="true" /><span>授信报表<small>查询当前数据</small></span></button>
          <button type="button" onclick={() => send('查看融资项目当前进展与待办')}><FolderOpen aria-hidden="true" /><span>融资项目<small>梳理项目进度</small></span></button>
          <button type="button" onclick={() => send('查找最新的政策资讯和研究点评')}><BookOpen aria-hidden="true" /><span>政策研究<small>检索资讯与点评</small></span></button>
          <button type="button" onclick={() => send('列出公开授信材料，并概括每份材料的名称')}><FileText aria-hidden="true" /><span>公开材料<small>查看授信资料</small></span></button>
        </div>
      </div>
    {:else}
      <div class="messages">
        {#each selected.messages as message}
          <article class:user={message.role === 'user'} class="message">
            <div class="message-label">{message.role === 'user' ? '你' : 'AI'}</div>
            <div class="message-text">{message.text || (busy ? '正在处理…' : '')}</div>
            {#if message.activity?.length}<details><summary>工具活动（{message.activity.length}）</summary><ol>{#each message.activity as step}<li>{step}</li>{/each}</ol></details>{/if}
            {#if message.sources?.length}<div class="sources"><strong>来源</strong>{#each message.sources as source (source.url)}<a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>{/each}</div>{/if}
            {#if message.error}<p class="message-error" role="alert">{message.error}</p>{/if}
            {#if message.role === 'assistant' && message.text}<button class="copy" type="button" onclick={() => copy(message.text)} aria-label="复制答复"><Copy size={16} />复制</button>{/if}
          </article>
        {/each}
      </div>
    {/if}
  </div>
  {#if approval}
    <div class="approval" role="alertdialog" aria-label="确认工具操作">
      <strong>确认执行：{approval.title}</strong>
      <pre>{JSON.stringify(approval.input, null, 2)}</pre>
      <div><button type="button" onclick={() => decide(false)}>拒绝</button><button type="button" class="approve" onclick={() => decide(true)}><Check size={16} />确认</button></div>
    </div>
  {/if}
  {#if showSettings}
    <div class="settings" aria-label="AI 工具设置">
      <div class="settings-heading"><strong>工具</strong><button type="button" onclick={refreshTools} disabled={loadingTools}>刷新</button></div>
      <label class="search"><Search size={16} /><input bind:value={toolSearch} aria-label="搜索工具" placeholder="搜索工具" /></label>
      <label class="page-context"><input type="checkbox" bind:checked={attachPage} />附带当前页面</label>
      <div class="tool-list">
        {#each filteredTools as item (item.name)}
          <label><input type="checkbox" checked={selectedTools.includes(item.name)} onchange={() => toggleTool(item.name)} /><span>{item.title || item.name}<small>{item.annotations?.readOnlyHint ? '读取' : '修改或生成'}</small></span></label>
        {/each}
      </div>
      <label class="steps">最多步骤 <input type="number" min="1" max="20" bind:value={maxSteps} /></label>
    </div>
  {/if}
  {#if showShortcuts}<div class="shortcuts">Enter 发送 · Shift+Enter 换行 · @ 选择工具 · ? 快捷键</div>{/if}
  {#if error}<p class="agent-error" role="alert">{error}</p>{/if}
  <div class="composer">
    <label class="sr-only" for="agent-input">输入消息</label>
    <textarea id="agent-input" bind:this={textarea} bind:value={draft} onkeydown={handleInput} disabled={!identity} placeholder="提问，@ 选择工具，? 查看快捷键" rows="3"></textarea>
    <div class="composer-actions">
      <button type="button" class="mode" onclick={() => readOnly = !readOnly} aria-label="切换运行模式">{readOnly ? 'Ask' : 'Act'} <ChevronDown size={15} /></button>
      <div>
        <button class="icon-button" type="button" aria-label="工具设置" aria-expanded={showSettings} onclick={openSettings}><Settings2 size={19} /></button>
        {#if busy}<button class="send" type="button" aria-label="停止生成" onclick={stop}><Square size={18} /></button>
        {:else}<button class="send" type="button" aria-label="发送消息" disabled={!identity || !draft.trim()} onclick={() => send()}><ArrowUp size={20} /></button>{/if}
      </div>
    </div>
  </div>
</div>

<style>
  .agent { display:flex; flex:1; min-height:0; flex-direction:column; background:var(--surface); }
  button { cursor:pointer; font:inherit; }
  button:focus-visible, textarea:focus-visible, input:focus-visible { outline:2px solid var(--brand); outline-offset:2px; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .agent-toolbar { display:flex; align-items:center; padding:6px 12px; border-bottom:1px solid var(--border-color); gap:8px; }
  .conversation-picker { display:flex; flex:1; min-width:0; height:44px; align-items:center; justify-content:space-between; gap:8px; border:0; background:transparent; color:var(--text-1); text-align:left; font-weight:bold; }
  .conversation-picker span { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .icon-button { display:grid; width:44px; height:44px; place-items:center; border:0; border-radius:var(--radius-control); background:transparent; color:var(--text-1); }
  .icon-button:hover,.conversation-picker:hover { background:var(--brand-soft); }
  .history { max-height:240px; overflow:auto; padding:8px; border-bottom:1px solid var(--border-color); }
  .history p { margin:12px; color:var(--text-muted); }
  .history-row { display:flex; min-height:48px; align-items:center; border-radius:var(--radius-control); }
  .history-row.current { background:var(--brand-soft); }
  .history-row > button:first-child { flex:1; min-width:0; padding:10px; overflow:hidden; border:0; background:transparent; text-align:left; white-space:nowrap; text-overflow:ellipsis; }
  .transcript { flex:1; min-height:0; overflow:auto; background:radial-gradient(color-mix(in srgb,var(--text-muted) 28%,transparent) 1px, transparent 1px) 0 0/22px 22px; }
  .welcome { display:flex; min-height:100%; flex-direction:column; align-items:center; justify-content:center; padding:32px 20px; text-align:center; }
  .help-bar { display:flex; width:100%; align-items:center; justify-content:space-between; margin-bottom:20px; padding:8px 12px; border:1px solid var(--border-color); border-radius:var(--radius-control); background:var(--surface); }
  .help-bar button { min-height:36px; padding:0 12px; border:1px solid var(--border-color); border-radius:999px; background:var(--surface); }
  .welcome h3 { margin:18px 0 2px; font-size:1.25rem; font-weight:bold; }
  .welcome-subtitle { margin:0 0 28px; color:var(--text-muted); }
  .agent-mark { position:relative; width:64px; height:48px; }
  .agent-mark span { position:absolute; width:42px; height:42px; border-radius:50%; background:var(--brand); opacity:.8; }
  .agent-mark span:first-child { left:2px; top:2px; }.agent-mark span:last-child { right:2px; bottom:2px; opacity:.45; }
  .suggestions { display:grid; width:100%; gap:8px; }
  .suggestions button { display:flex; min-height:68px; align-items:center; gap:14px; padding:10px 16px; border:1px solid var(--border-color); border-radius:var(--radius-control); background:var(--surface); color:var(--text-1); text-align:left; font-weight:bold; }
  .suggestions button:hover { border-color:var(--brand); }.suggestions button :global(svg) { flex:none; width:22px; height:22px; color:var(--text-muted); }
  .suggestions span { display:block; }.suggestions small { display:block; margin-top:2px; color:var(--text-muted); font-size:.875rem; font-weight:normal; }
  .messages { display:grid; gap:20px; padding:20px 16px 32px; }
  .message { min-width:0; padding:14px; border:1px solid var(--border-color); border-radius:var(--radius-control); background:var(--surface); }
  .message.user { margin-left:32px; background:var(--brand-soft); }.message-label { margin-bottom:8px; color:var(--brand); font-weight:bold; }
  .message-text { white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.65; }.message details { margin-top:12px; color:var(--text-muted); font-size:.875rem; }
  .message summary { cursor:pointer; }.message ol { margin:8px 0 0; padding-left:20px; }.message-error,.agent-error { color:var(--destructive); }
  .sources { display:grid; gap:6px; margin-top:14px; padding-top:12px; border-top:1px solid var(--border-color); font-size:.875rem; }.sources a { color:var(--brand); overflow-wrap:anywhere; }
  .copy { display:flex; align-items:center; gap:4px; min-height:36px; margin-top:10px; padding:0 8px; border:0; background:transparent; color:var(--text-muted); }
  .approval,.settings,.shortcuts { padding:12px 16px; border-top:1px solid var(--border-color); background:var(--surface); }
  .approval pre { max-height:140px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font-size:.8125rem; }
  .approval div { display:flex; justify-content:flex-end; gap:8px; }.approval button,.settings-heading button { min-height:44px; padding:0 14px; border:1px solid var(--border-color); border-radius:var(--radius-control); background:var(--surface); }
  .approval .approve { display:flex; align-items:center; gap:5px; border-color:var(--brand); background:var(--brand); color:white; }
  .settings-heading { display:flex; align-items:center; justify-content:space-between; }.search { display:flex; align-items:center; gap:8px; margin-top:8px; padding:8px; border:1px solid var(--border-color); border-radius:var(--radius-control); }
  .search input { flex:1; min-width:0; border:0; background:transparent; color:var(--text-1); }.tool-list { max-height:200px; overflow:auto; }
  .page-context { display:flex; min-height:44px; align-items:center; gap:10px; }
  .tool-list label { display:flex; min-height:44px; align-items:center; gap:10px; padding:5px 2px; }.tool-list span { display:flex; flex:1; justify-content:space-between; gap:8px; }.tool-list small { color:var(--text-muted); }
  .steps { display:flex; align-items:center; justify-content:space-between; margin-top:8px; }.steps input { width:64px; padding:6px; border:1px solid var(--border-color); border-radius:var(--radius-control); }
  .shortcuts { color:var(--text-muted); font-size:.875rem; }.agent-error { margin:0; padding:8px 16px; }
  .composer { margin:10px 12px 12px; border:1px solid var(--brand); border-radius:var(--radius-card); background:var(--surface); box-shadow:0 0 0 2px color-mix(in srgb,var(--brand) 10%,transparent); }
  .composer textarea { display:block; width:100%; min-height:84px; max-height:180px; padding:14px; resize:vertical; border:0; border-radius:var(--radius-card); background:transparent; color:var(--text-1); font:inherit; }
  .composer textarea:focus { outline:none; }.composer-actions { display:flex; align-items:center; justify-content:space-between; padding:0 8px 8px; }
  .composer-actions > div { display:flex; gap:4px; }.mode { display:flex; min-height:44px; align-items:center; gap:6px; padding:0 12px; border:1px solid var(--border-color); border-radius:999px; background:var(--surface); }
  .send { display:grid; width:44px; height:44px; place-items:center; border:0; border-radius:50%; background:var(--brand); color:white; }
</style>
