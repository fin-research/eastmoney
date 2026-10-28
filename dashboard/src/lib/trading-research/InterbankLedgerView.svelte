<script lang="ts">
  import { getContext, onDestroy, onMount } from 'svelte';
  import ModuleCard from '../../components/ModuleCard.svelte';
  import PanelHeading from './PanelHeading.svelte';
  import Badge from './Badge.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { CLIENT_SESSION_CONTEXT, type ClientSession } from '$lib/client-session';
  import { globalMessages } from '$lib/global-messages';
  import { interbankPageSchema, interbankParseSchema, interbankAttachmentSchema, interbankSavedSchema, interbankDraftSavedSchema, interbankDraftSchema } from '../../data-contracts';
  import { runWorkflow, ledgerRows } from '$lib/interbank/workflow';
  import type { PreparedBatch, Journal, LedgerRow } from '$lib/interbank/model';
  import { loadArchiveDirectory, saveArchiveDirectory, saveArchive, type ArchiveDirectory } from '$lib/interbank/archive';
  const session=getContext<ClientSession>(CLIENT_SESSION_CONTEXT);
  let batch=$state<PreparedBatch|null>(null), journal=$state<Journal|null>(null);
  let directory=$state<ArchiveDirectory>();
  let directoryReady=$state(false), dragging=$state(false);
  let pendingFile:File|undefined;
  let mounted=true;
  let busy=$state(''), date=$state(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
  let rows=$state<LedgerRow[]>([]), queried=$state(false);
  let worker:Worker|undefined;
  let fileInput=$state<HTMLInputElement>();
  const actor=$derived($session?.user?.id ?? '');
  const canImport=$derived(!!$session?.permissions.includes('research.interbank:import'));
  const key=(account:string,signature:string)=>`eastmoney:interbank:v1:${encodeURIComponent(account)}:${signature}`;
  $effect(()=>{ actor; batch=null;journal=null;rows=[];queried=false;pendingFile=undefined; });
  onMount(()=>{ void loadArchiveDirectory().then(handle=>{if(mounted)directory=handle;}).catch(()=>globalMessages.error('归档目录读取失败')).finally(()=>{directoryReady=true;}); });
  onDestroy(()=>{mounted=false;worker?.terminate();});
  async function action(label:string, run:()=>Promise<void>) {
    if (busy) return;
    busy=label;
    try { await run(); } catch(error) { globalMessages.error(error instanceof Error?error.message:'操作失败'); }
    finally { busy=''; }
  }
  async function api(path:string,init?:RequestInit) {
    const response=await fetch(`/data/camel${path}`,init);
    const body=await response.json();
    if (!response.ok) throw new Error(body.error || body.detail || '资金系统请求失败');
    const schema=path.startsWith('/borrowings?')?interbankPageSchema:path==='/borrowings/parse'?interbankParseSchema:path==='/borrowings/import'?interbankSavedSchema:path==='/attachments'?interbankAttachmentSchema:path==='/repayment-drafts'?interbankDraftSavedSchema:interbankDraftSchema;
    return schema.parse(body);
  }
  function process<T>(data:unknown):Promise<T> {
    worker?.terminate();worker=new Worker(new URL('../interbank/prepare.worker.ts',import.meta.url),{type:'module'});
    return new Promise((resolve,reject)=>{
      worker!.onmessage=({data})=>{ worker?.terminate();data.error?reject(new Error(data.error)):resolve(data); };
      worker!.onerror=()=>{worker?.terminate();reject(new Error('文件处理失败'));};
      worker!.postMessage(data);
    });
  }
  function checkAccount(account:string) {
    if (!mounted || actor!==account) throw new Error('账号已改变，操作已停止');
  }
  async function persist(next:Journal,account=actor) {
    checkAccount(account);
    localStorage.setItem(key(account,next.signature),JSON.stringify(next));
    journal=structuredClone(next);
  }
  // Invoked from the original click/drop gesture, before ZIP parsing or other awaits.
  async function accessDirectory(change=false):Promise<ArchiveDirectory> {
    let handle=directory;
    if (!change && handle) {
      if (await handle.queryPermission({mode:'readwrite'})!=='granted' && await handle.requestPermission({mode:'readwrite'})!=='granted') throw new Error('请重新授权归档目录');
    } else {
      const picker=(window as unknown as {showDirectoryPicker?:(options:{mode:'readwrite',id:string})=>Promise<ArchiveDirectory>}).showDirectoryPicker;
      if (!picker) throw new Error('浏览器不支持本地目录保存');
      handle=await picker({mode:'readwrite',id:'interbank-archive'});
      await saveArchiveDirectory(handle);
      directory=handle;
    }
    return handle;
  }
  async function selectDirectory() {
    if (busy) return;
    const account=actor;
    const access=accessDirectory(true);
    await action('目录授权中',async()=>{
      const root=await access;
      checkAccount(account);
      if (pendingFile) {const file=pendingFile;pendingFile=undefined;await processFile(file,root,account);}
    });
  }
  async function selectFile() {
    if (busy || !directoryReady) return;
    let ready=false;
    await action('目录授权中',async()=>{await accessDirectory();ready=true;});
    if (ready) fileInput?.click();
  }
  async function choose(event:Event) {
    const input=event.currentTarget as HTMLInputElement,file=input.files?.[0];input.value='';
    if (file) await acceptFile(file);
  }
  async function drop(event:DragEvent) {
    event.preventDefault();dragging=false;
    if (busy || !canImport || !directoryReady) return;
    const files=event.dataTransfer?.files;
    if (files?.length!==1) {globalMessages.error('请选择一个成交压缩包');return;}
    await acceptFile(files[0]!);
  }
  async function acceptFile(file:File) {
    if (busy || !canImport) return;
    if (!file.name.toLowerCase().endsWith('.zip')) {globalMessages.error('请选择成交压缩包');return;}
    pendingFile=file;
    const account=actor;
    const access=accessDirectory();
    await action('归档中',async()=>{
      const root=await access;
      pendingFile=undefined;
      await processFile(file,root,account);
    });
  }
  async function processFile(file:File,root:ArchiveDirectory,account=actor) {
    if (!account) throw new Error('请先登录');
    checkAccount(account);
    busy='解析中';
    const result=await process<{batch:PreparedBatch}>({file});
    checkAccount(account);
    const prepared=result.batch;
    batch=prepared;date=prepared.date;
    if (!navigator.locks) throw new Error('浏览器不支持安全导入锁');
    await navigator.locks.request(`interbank:${account}`,{ifAvailable:true},async lock=>{
      if (!lock) throw new Error('另一个窗口正在归档');
      checkAccount(account);
      const saved=localStorage.getItem(key(account,prepared.signature));
      const current:Journal=saved?JSON.parse(saved):{signature:prepared.signature,trades:{},uploads:{}};
      if (current.signature!==prepared.signature) throw new Error('批次记录不一致');
      await persist(current,account);
      busy='保存中';
      await saveArchive(root,prepared,()=>checkAccount(account));
      current.archived=true;await persist(current,account);
      busy='导入中';
      await runWorkflow(prepared,current,async(path,init)=>{
        checkAccount(account);
        return api(path,init);
      },next=>persist(next,account));
      checkAccount(account);
      globalMessages.success(`已归档并保存 ${prepared.trades.length} 笔还款草稿`);
    });
  }
</script>
<div class="interbank-ledger">
  <ModuleCard labelledBy="interbank-archive">
    <PanelHeading id="interbank-archive" title="成交归档">
      {#if canImport}
        <input hidden bind:this={fileInput} type="file" accept=".zip,application/zip" aria-label="选择成交压缩包" onchange={choose} disabled={!directoryReady}/>
        <Button onclick={selectFile} disabled={!!busy || !directoryReady}>{busy || '选择成交压缩包'}</Button>
        <Button variant="outline" onclick={selectDirectory} disabled={!!busy || !directoryReady}>{directory?.name ?? '选择归档目录'}</Button>
      {/if}
    </PanelHeading>
    <div class="archive-drop" class:dragging role="region" aria-label="成交压缩包拖放区" aria-busy={!!busy} ondragover={event=>{event.preventDefault();if(!busy && canImport)dragging=true;}} ondragleave={()=>dragging=false} ondrop={drop}>
    {#if batch}
      <div class="batch-summary"><span>{batch.date}</span><span>{batch.trades.length} 笔成交</span><span>{batch.files.length} 个文件</span><Badge>{journal?.archived?'已归档':'待归档'}</Badge></div>
      <div class="table-scroll" tabindex="0" role="region" aria-label="归档文件预览"><table><thead><tr><th>原文件</th><th>归档文件</th></tr></thead><tbody>{#each batch.files as file}<tr><td>{file.source}</td><td>{file.name}</td></tr>{/each}</tbody></table></div>
      <div class="table-scroll" tabindex="0" role="region" aria-label="成交处理进度"><table><thead><tr><th>成交编号</th><th>对手方</th><th class="numeric">金额（万）</th><th>归档</th><th>台账</th><th>附件</th><th>还款草稿</th></tr></thead><tbody>{#each batch.trades as trade}{@const progress=journal?.trades[trade.serialNo]}{@const uploads=batch.files.filter(f=>f.serialNo===trade.serialNo).map(f=>journal?.uploads[f.name])}<tr><td>{trade.serialNo}</td><td>{trade['对手方']}</td><td class="numeric">{trade['拆借金额(万)']}</td><td>{journal?.archived?'已保存':'待保存'}</td><td>{progress?.import==='verified'?'已导入':progress?.import?'结果待确认':'待导入'}</td><td>{uploads.every(u=>u?.id)?'已上传':uploads.some(u=>u?.status==='intent'&&!u.id)?'结果待确认':'待上传'}</td><td>{progress?.draft==='verified'?'已保存':progress?.draft?'结果待确认':'待保存'}</td></tr>{/each}</tbody></table></div>
    {:else}<div class="empty">{busy || '选择或拖入成交压缩包'}</div>{/if}
    </div>
  </ModuleCard>
  <ModuleCard labelledBy="interbank-records">
    <PanelHeading id="interbank-records" title="资金系统台账">
      <div class="date-field"><Input type="date" aria-label="成交日期" bind:value={date} disabled={!!busy}/></div>
      <Button variant="outline" disabled={!!busy} onclick={()=>action('查询中',async()=>{rows=await ledgerRows(api,date);queried=true;})}>{busy==='查询中'?'查询中':'查询'}</Button>
    </PanelHeading>
    {#if rows.length}<div class="table-scroll" tabindex="0" role="region" aria-label="资金系统拆借台账"><table><thead><tr><th>成交编号</th><th>对手方</th><th class="numeric">金额（元）</th><th>首次结算日</th><th>到期还款日</th><th>还款草稿</th></tr></thead><tbody>{#each rows as row}<tr><td>{row.serialNo}</td><td>{row.counterpartyName}</td><td class="numeric">{row.matchAmount}</td><td>{row.matchTime}</td><td>{row.firstSettleDate}</td><td>{row.hid?'已保存':'未保存'}</td></tr>{/each}</tbody></table></div>{:else}<div class="empty">{queried?'当日暂无拆借台账':'请选择成交日期查询'}</div>{/if}
  </ModuleCard>
</div>
<style>
  .archive-drop{border:1px dashed var(--tr-border);border-radius:12px;padding:12px}.archive-drop.dragging{border-color:var(--primary);background:var(--muted)}.interbank-ledger{display:grid;gap:20px;min-width:0}.date-field{width:220px;max-width:100%}.batch-summary{display:flex;gap:20px;align-items:center;flex-wrap:wrap;margin-bottom:16px}.table-scroll{overflow:auto;max-width:100%;margin-top:16px}table{width:100%;border-collapse:collapse;white-space:nowrap;font-size:.875rem}th,td{padding:12px;text-align:left;border-bottom:1px solid var(--tr-border);font-variant-numeric:tabular-nums}th{font-weight:bold;background:var(--tr-bg)}.numeric{text-align:right}.empty{padding:36px 12px;text-align:center;color:var(--text-2)}
</style>
