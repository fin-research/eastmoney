<script lang="ts">
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { shiborRatesSchema, type ShiborRate } from '../../data-contracts';
  import { blankDirectory, directoryKey, directorySchema, remember, type InquiryDirectory, type InquiryRow } from '../trading-workflow/inquiries';
  import { onMount, tick } from 'svelte';
  import ModuleCard from "../../components/ModuleCard.svelte";
  import { Clock } from '@lucide/svelte';
  import { portal } from '../portal';
  import WorkflowCanvas from '../trading-workflow/WorkflowCanvas.svelte';
  import { workflowGroups } from '../trading-workflow/graph';
  import WorkflowEditor from '../trading-workflow/WorkflowEditor.svelte';
  import { globalMessages } from '../global-messages';
  import { configResponseSchema, configSchema, dayKey, dueReminders, emptyDay, products, nodesSchema, flowLabel,
    removeNode, readDay, shanghaiClock, updateDay, type Product, type WorkflowConfig, type WorkflowDay, type WorkflowNode } from '../trading-workflow/model';

  let config = $state<WorkflowConfig | null>(null);
  let actorKey = '';
  let directory = $state<InquiryDirectory>(blankDirectory());
  let rates = $state<ShiborRate[]>([]);
  let fetchingRates = false;
  let nextRateCheck = 0;
  let canEdit = $state(false);
  let now = $state(new Date());
  let day = $state<WorkflowDay>(emptyDay(shanghaiClock().date));
  let loading = $state(true);
  let loadError = $state('');
  let editing = $state(false);
  let draft = $state<WorkflowNode[]>([]);
  let selectedId = $state('');
  let saving = $state(false);
  let preview = $state<WorkflowDay>(emptyDay(shanghaiClock().date));
  const displayDay = $derived(editing ? { ...day, enabled: preview.enabled, branches: preview.branches } : day);
  function startEditing() {
    if (!config) return;
    draft = structuredClone($state.snapshot(config.nodes));
    preview = structuredClone($state.snapshot(day)); selectedId = ''; editing = true;
  }
  function cancelEditing() {
    if (saving) return;
    if (config && JSON.stringify(draft) !== JSON.stringify(config.nodes) && !window.confirm('放弃未保存的流程修改？')) return;
    editing = false; selectedId = '';
  }
  async function closeEditor() {
    const id = selectedId;
    selectedId = '';
    await tick();
    Array.from(document.querySelectorAll<HTMLElement>('[data-workflow-node]')).find(node => node.dataset.workflowNode === id)
      ?.querySelector<HTMLButtonElement>('.node-surface')?.focus({ preventScroll: true });
  }
  async function saveDraft() {
    if (saving) return;
    const result = nodesSchema.safeParse(draft);
    if (!result.success) { globalMessages.error(result.error.issues[0]?.message ?? '节点配置无效'); return; }
    saving = true;
    try { if (await saveConfig(result.data)) { editing = false; selectedId = ''; } }
    catch { globalMessages.error('配置保存失败，请重试'); }
    finally { saving = false; }
  }
  async function deleteNode(id: string) {
    if (saving) return;
    const index = draft.findIndex(node => node.id === id);
    draft = removeNode(draft, id);
    selectedId = draft[Math.min(index, draft.length - 1)]?.id ?? '';
    await saveDraft();
  }
  function move(id: string, offset: { x: number; y: number }) {
    if (editing && !saving) {
      const ids = new Set(workflowGroups(draft).find(group => group.some(node => node.id === id))?.map(node => node.id));
      draft = draft.map(node => ids.has(node.id) ? { ...node, offset } : node); selectedId = id;
    }
  }
  function addNode() {
    const node: WorkflowNode = { id: crypto.randomUUID(), flowIds: ['loan'], nextIds: [], parentId: null, kind: 'task', title: '新节点', detail: '', startTime: null, endTime: null };
    draft = [...draft, node]; selectedId = node.id;
  }
  function setBranch(ids: string[], value: boolean) {
    if (editing) { for (const id of ids) preview.branches[id] = value; } else branch(ids, value);
  }
  function setEnabled(product: Product, value: boolean) {
    if (editing) preview.enabled[product] = value; else enable(product, value);
  }
  function note(id: string, value: string) { void change(state => { state.notes[id] = value; }); }
  function quoteRows(id: string, rows: InquiryRow[]) { void change(state => { state.quotes[id] = rows; }); }
  function restoreDirectory() {
    try { const raw = localStorage.getItem(directoryKey(actorKey)); directory = raw ? directorySchema.parse(JSON.parse(raw)) : blankDirectory(); }
    catch { globalMessages.warning('询价名单读取失败，当前名单仅在本页保留', { key: 'inquiry-directory' }); }
  }
  function rememberRow(row: InquiryRow) {
    const write = () => {
      try {
        const raw = localStorage.getItem(directoryKey(actorKey));
        directory = remember(raw ? directorySchema.parse(JSON.parse(raw)) : directory, row);
        localStorage.setItem(directoryKey(actorKey), JSON.stringify(directory));
      } catch { directory = remember(directory, row); globalMessages.warning('询价名单保存失败', { key: 'inquiry-directory' }); }
    };
    directory = remember(directory, row);
    if (navigator.locks) void navigator.locks.request(directoryKey(actorKey), write); else write();
  }
  async function refreshRates() {
    const current = shanghaiClock();
    if (!mounted || fetchingRates || document.visibilityState === 'hidden' || current.minutes < 660 || Date.now() < nextRateCheck) return;
    fetchingRates = true;
    nextRateCheck = Date.now() + 15_000;
    try {
      const response = await fetch('/data/chinamoney/shibor', { cache: 'no-store', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error('SHIBOR 读取失败');
      const loaded = shiborRatesSchema.parse(await response.json());
      if (!mounted || shanghaiClock().date !== current.date) return;
      rates = loaded;
      if (loaded.length === 8 && loaded.every(rate => rate.publishDate === current.date)) nextRateCheck = Date.now() + 300_000;
    } catch { if (mounted) globalMessages.warning('SHIBOR 暂不可用，保留 BP 报价', { key: 'inquiry-shibor' }); }
    finally { fetchingRates = false; }
  }
  let mounted = false;
  let localAvailable = true;
  let abort: AbortController;
  const clock = $derived(shanghaiClock(now));
  function storageFailure() {
    localAvailable = false;
    globalMessages.warning('本地存储不可用或记录损坏，当前进度仅在本页保留', { key: 'workflow-storage', duration: 10000 });
  }
  function restore(date: string) {
    try { day = readDay(localStorage, dayKey(actorKey, date), date); }
    catch { if (day.date !== date) day = emptyDay(date); storageFailure(); }
  }
  function persist(changeDay: (value: WorkflowDay) => void) {
    const date = shanghaiClock().date;
    if (day.date !== date) restore(date);
    if (localAvailable) {
      try { day = updateDay(localStorage, dayKey(actorKey, date), date, changeDay); return; }
      catch { storageFailure(); }
    }
    const copy = structuredClone($state.snapshot(day)); changeDay(copy); day = copy;
  }
  let progressWrite: Promise<void> = Promise.resolve();
  function syncProgress(patch: Record<string, unknown>) {
    progressWrite = progressWrite.then(async () => {
      const response = await fetch('/api/trading-workflow/day', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patch) });
      if (!response.ok) throw new Error(await responseError(response));
    }).catch(error => { globalMessages.error(`进度同步失败：${error.message}`, {key:'workflow-sync'}); });
    return progressWrite;
  }
  async function loadProgress() {
    const response = await fetch('/api/trading-workflow/day');
    if (!response.ok) throw new Error(await responseError(response));
    const result = await response.json();
    if (!mounted || result.state.date !== shanghaiClock().date) return;
    if (!result.revision) await syncProgress({date:day.date,enabled:day.enabled,completed:day.completed,branches:day.branches});
    else persist(state => { state.enabled=result.state.enabled;state.completed=result.state.completed;state.branches=result.state.branches; });
  }
  async function change(changeDay: (value: WorkflowDay) => void) {
    const apply = async () => {
      if (!mounted) return;
      const before=structuredClone($state.snapshot(day));persist(changeDay);
      const patch:Record<string,unknown>={date:day.date};
      for(const key of ['enabled','completed','branches'] as const){
        const flags=Object.fromEntries(Object.entries(day[key]).filter(([id,value])=> (before[key] as Record<string,boolean>)[id]!==value));
        if(Object.keys(flags).length)patch[key]=flags;
      }
      if(Object.keys(patch).length>1)await syncProgress(patch);
    };
    if (navigator.locks) await navigator.locks.request(`trading-workflow:${actorKey}`,apply);else await apply();
  }
  async function loadConfig() {
    loading = true; loadError = '';
    try {
      const response = await fetch('/api/trading-workflow/config', { signal: abort?.signal });
      if (!response.ok) throw new Error(await responseError(response));
      const data = configResponseSchema.parse(await response.json());
      if (!mounted) return;
      config = { version: data.version, flows: data.flows, nodes: data.nodes }; actorKey = data.actorKey; canEdit = data.canEdit;
      restore(shanghaiClock().date); restoreDirectory(); void refreshRates();
      await loadProgress().catch(error=>globalMessages.error(`进度同步失败：${error.message}`,{key:'workflow-sync'}));
    } catch (error) { if (mounted) loadError = error instanceof Error ? error.message : '交易流程加载失败'; }
    finally { if (mounted) loading = false; }
  }
  async function responseError(response: Response) {
    try { const body = await response.json() as { error?: unknown }; return typeof body.error === 'string' ? body.error : `请求失败（${response.status}）`; }
    catch { return `请求失败（${response.status}）`; }
  }
  async function saveConfig(nodes: WorkflowNode[]) {
    if (!config) return false;
    const response = await fetch('/api/trading-workflow/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: config.version, flows: config.flows, nodes }) });
    if (!response.ok) { globalMessages.error(await responseError(response)); return false; }
    config = configSchema.parse(await response.json());
    globalMessages.success('交易流程节点已保存');
    return true;
  }
  function complete(ids: string[], value: boolean) { void change(state => { for (const id of ids) state.completed[id] = value; }); }
  function branch(ids: string[], value: boolean) { void change(state => { for (const id of ids) state.branches[id] = value; }); }
  function enable(product: Product, value: boolean) { void change(state => { state.enabled[product] = value; }); }
  onMount(() => {
    mounted = true; abort = new AbortController();
    void loadConfig();
    const timer = setInterval(() => {
      now = new Date();
      if (config && day.date !== clock.date) { restore(clock.date);void loadProgress().catch(()=>globalMessages.error('进度同步失败')); }
      void refreshRates();
    }, 1000);
    function sync(event: StorageEvent) {
      if (event.key === directoryKey(actorKey) || event.key === null) restoreDirectory();
      if (event.key === dayKey(actorKey, shanghaiClock().date) || event.key === null) restore(shanghaiClock().date);
    }
    function wake() { now = new Date();if(config)void loadProgress().catch(()=>globalMessages.error('进度同步失败'));void refreshRates(); }
    window.addEventListener('storage', sync); window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake);
    return () => { mounted = false; abort.abort(); clearInterval(timer); window.removeEventListener('storage', sync); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); };
  });
</script>

<div class="workflow-view">
  <div class="workflow-header" use:portal={'#tr-topbar-actions'}>
    <time class="workflow-clock" datetime={`${clock.date}T${clock.time}+08:00`} aria-label="当前时间"><Clock size={18} aria-hidden="true" />{clock.time}</time>
    {#if canEdit && config}
      <label class="edit-mode"><Checkbox  bind:checked={() => editing, (value) => { value ? startEditing() : cancelEditing(); }} disabled={saving} />编辑模式</label>
    {/if}
  </div>
  {#if loading}<p role="status">正在加载交易流程…</p>
  {:else if loadError}<ModuleCard><p role="alert">{loadError}</p><Button data-ui-owner="lib-trading-research-WorkflowView-svelte" variant="outline" class={"ui-button"} onclick={loadConfig}>重新加载</Button></ModuleCard>
  {:else if config}
    <div class="flow-workspace" class:saving>
      <WorkflowCanvas flows={config.flows} nodes={editing ? draft : config.nodes} day={displayDay} clockMinutes={clock.minutes} {editing} {selectedId}
        onSelect={id => selectedId = id} onMove={move} onComplete={complete} onBranch={setBranch} onEnable={setEnabled} onNote={note} onRows={quoteRows} onRemember={rememberRow} {directory} {rates} {now} />
      {#if editing && (selectedId || !draft.length)}
        {#key selectedId}<WorkflowEditor flows={config.flows} bind:nodes={draft} {selectedId} disabled={saving} onSelect={id => selectedId = id}
          onClose={closeEditor} onBranch={(id, value) => setBranch([id], value)} expanded={!!preview.branches[selectedId]}
          onSave={saveDraft} onDelete={deleteNode} onAdd={addNode} onReset={() => draft = draft.map(({ offset, ...node }) => node)}
          />{/key}
      {/if}
    </div>
  {/if}
</div>

<style>
  .workflow-view { min-width: 0; }
  .workflow-header { display: flex; align-items: center; gap: 28px; }
  .workflow-clock { display: flex; gap: 8px; align-items: center; color: var(--tr-text); font-size: 1rem; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .workflow-clock :global(svg) { color: #5b759c; }
  .edit-mode { display: flex; align-items: center; gap: 10px; min-height: 44px; font-size: 1rem; white-space: nowrap; }
  .flow-workspace { display: flex; min-width: 0; align-items: flex-start; gap: 16px; }
  .flow-workspace :global(.workflow-diagram) { flex: 1; }
  .flow-workspace.saving { pointer-events: none; }
  @media (max-width: 720px) { .workflow-header { gap: 12px; } .workflow-clock { font-size: .875rem; } }
</style>
