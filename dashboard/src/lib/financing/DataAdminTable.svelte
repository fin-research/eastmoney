<script lang="ts">
 import { Search, SlidersHorizontal, RefreshCw, Download, Plus } from '@lucide/svelte';
 import ModuleCard from '../../components/ModuleCard.svelte';
 import { goto } from '$app/navigation';
 import { Button } from '$lib/components/ui/button/index.js';
 import { Input } from '$lib/components/ui/input/index.js';
 import { NativeSelect } from '$lib/components/ui/native-select/index.js';
 import DebtColumnMenu from './DebtColumnMenu.svelte';
 import * as Popover from '$lib/components/ui/popover/index.js';
 import { Checkbox } from '$lib/components/ui/checkbox/index.js';
 import { createTable, tableFeatures } from '@tanstack/svelte-table';
 import * as Table from '$lib/components/ui/table/index.js';
 import { globalMessages } from '$lib/global-messages';
 import { hasPermission } from '$lib/permissions';
 import { formatDataValue, type EntityConfig, type DataRow } from './data-admin';
 import { NeonDataApi, type ListOptions } from './neon-data-api';
 import { financingToday } from './time.js';
 import { downloadDebtWorkbook } from './debt-export';
 let { config, url, permissions }: {config:EntityConfig; url:URL; permissions:string[]} = $props();
 const api = new NeonDataApi();
 const core = ['name','subtype','counterparty','amount','annual_rate','issue_date','maturity_date','status'];
 const availableFields = $derived(config.fields.filter(field => core.includes(field.key)));
 const hidden = $derived((url.searchParams.get('hidden')??'').split(',').filter(key=>key!=='name'));
 const fields = $derived(availableFields.filter(field=>!hidden.includes(field.key)));
 const filters = $derived.by(() => {
  const result: NonNullable<ListOptions['filters']> = {};
  for (const field of availableFields) {
   try { const value=url.searchParams.get(`f_${field.key}`);if(value){const parsed=JSON.parse(value);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))result[field.key]=parsed;} } catch { /* Ignore malformed UI state. */ }
  }
  return result;
 });
 let rows = $state<DataRow[]>([]), total = $state(0), loading = $state(true), exporting = $state(false), error = $state('');
 const features = tableFeatures({});
 const columns = $derived(fields.map(field=>({accessorKey:field.key,header:field.label})));
 const table = createTable({features,get columns(){return columns;},get data(){return rows;}});
 const options = $derived.by((): ListOptions => ({
  page: Math.max(0, Math.floor(Number(url.searchParams.get('page')) || 0)),
  pageSize: [25, 50, 100].includes(Number(url.searchParams.get('size'))) ? Number(url.searchParams.get('size')) : 50,
  filters,
  sortKey: config.fields.some(field => field.key === url.searchParams.get('sort'))
   ? url.searchParams.get('sort')! : config.defaultSort.key,
  sortDirection: url.searchParams.get('direction') === 'asc' ? 'asc' : 'desc',
  search: url.searchParams.get('search') ?? '',
  lifecycle: url.searchParams.get('lifecycle') === 'all' ? 'all' : 'unmatured',
  asOfDate: financingToday(),
  status: url.searchParams.get('status') ?? '',
  subtype: url.searchParams.get('subtype') ?? '',
  issueFrom: url.searchParams.get('from') ?? '',
  issueTo: url.searchParams.get('to') ?? ''
 }));

 let search = $state('');
 let request = 0;
 $effect(() => { search = options.search; void load(config, options); });
 async function load(entity:EntityConfig, query:ListOptions) {
  const current = ++request; loading = true; error = '';
  try {
   const result = await api.list(entity, { ...query, asOfDate: financingToday() });
   if(current!==request)return;
   const lastPage=Math.max(0,Math.ceil(result.total/query.pageSize)-1);
   if(query.page>lastPage){change({page:String(lastPage)});return;}
   rows=result.rows;total=result.total;
  }
  catch(cause) { if(current!==request)return;rows=[];total=0;error=cause instanceof Error?cause.message:String(cause); }
  finally { if(current===request)loading=false; }
 }
 function change(changes:Record<string,string>) {
  const next = new URL(url); next.searchParams.delete('page');
  for(const [key,value] of Object.entries(changes)) { if(value)next.searchParams.set(key,value);else next.searchParams.delete(key); }
  void goto(next.pathname+next.search,{noScroll:true,keepFocus:true});
 }
 function setFilter(key:string, filter:NonNullable<ListOptions['filters']>[string]) {
  change({[`f_${key}`]:Object.keys(filter).length?JSON.stringify(filter):''});
 }
 function setHidden(key:string, hide:boolean) {
  change({hidden:(hide?[...hidden,key]:hidden.filter(item=>item!==key)).join(',')});
 }
 function entryHref(id:unknown) { const next=new URL(url);next.searchParams.set('entry',String(id));return next.pathname+next.search; }
 async function exportRows() {
  if(exporting)return; exporting=true;
  try { const entity=config, query={...options,asOfDate:financingToday()};const fresh=await api.all(entity,query);await downloadDebtWorkbook(entity,fresh);globalMessages.success(`已导出 ${fresh.length} 条`,{key:'debt-export'}); }
  catch(cause){globalMessages.error(cause instanceof Error?cause.message:String(cause),{key:'debt-export'});}
  finally{exporting=false;}
 }
 const pages = $derived(Math.max(1,Math.ceil(total/options.pageSize)));
</script>
<ModuleCard class="data-editor" padding="none" labelledBy="debt-table-title">
 <h2 id="debt-table-title" class="sr-only">{config.label}负债数据</h2>
 <div class="table-toolbar">
  <form role="search" onsubmit={event=>{event.preventDefault();change({search});}}><Input aria-label="搜索负债" placeholder="搜索负债" type="search" bind:value={search}/><Button type="submit" variant="ghost" size="icon" class="size-11" aria-label="查询"><Search aria-hidden="true"/></Button></form>
  <div class="table-actions">
   <NativeSelect aria-label="到期筛选" value={options.lifecycle} onchange={event=>change({lifecycle:event.currentTarget.value})}><option value="unmatured">未到期</option><option value="all">全部</option></NativeSelect>
   <Popover.Root><Popover.Trigger>{#snippet child({props})}<Button {...props} variant="outline"><SlidersHorizontal aria-hidden="true"/>视图</Button>{/snippet}</Popover.Trigger><Popover.Content align="end" class="w-52 p-3"><div class="view-columns">{#each availableFields as field}<label><Checkbox checked={!hidden.includes(field.key)} disabled={field.key==='name'} onCheckedChange={checked=>setHidden(field.key,!checked)}/>{field.label}</label>{/each}</div></Popover.Content></Popover.Root><Button variant="ghost" size="icon" class="size-11" aria-label="刷新" onclick={()=>void load(config,options)} disabled={loading}><RefreshCw aria-hidden="true" class={loading?'animate-spin':''}/></Button><Button variant="outline" onclick={()=>void exportRows()} disabled={exporting}><Download aria-hidden="true"/>{exporting?'导出中…':'导出 Excel'}</Button>{#if hasPermission(permissions,'financing.data:create')}<Button class="ui-button" href={entryHref('new')}><Plus aria-hidden="true"/>新增条目</Button>{/if}</div>
 </div>
 {#if error}<div role="alert" class="table-error">{error}<Button variant="outline" onclick={()=>void load(config,options)}>重试</Button></div>{/if}
 <div class="table-shell" role="region" aria-label="负债表格" tabindex="0" aria-busy={loading}>
 <Table.Root scrollable={false}>
  <Table.Header>{#each table.getHeaderGroups() as group}<Table.Row>{#each group.headers as header}
   {@const field=fields.find(field=>field.key===header.column.id)!}
   <Table.Head aria-sort={options.sortKey===field.key?(options.sortDirection==='asc'?'ascending':'descending'):'none'} class={field.type==='number'?'numeric':''}>
    <DebtColumnMenu {field} sortDirection={options.sortKey===field.key?options.sortDirection:undefined} filter={filters[field.key]} onsort={direction=>change({sort:direction?field.key:'',direction})} onfilter={filter=>setFilter(field.key,filter)} onhide={()=>{if(field.key!=='name')setHidden(field.key,true);}}/>
   </Table.Head>
  {/each}</Table.Row>{/each}</Table.Header>
  <Table.Body>
   {#if loading}<Table.Row><Table.Cell colspan={fields.length} class="empty-row">正在读取…</Table.Cell></Table.Row>
   {:else}{#each table.getRowModel().rows as item (String(item.original.id))}
    {@const row=item.original}
    <Table.Row class="debt-row" onclick={()=>void goto(entryHref(row.id))}>
     {#each fields as field}<Table.Cell class={field.type==='number'?'numeric':''}>
      {#if field.key==='name'}<a href={entryHref(row.id)} onclick={event=>event.stopPropagation()}>{formatDataValue(field,row[field.key])}</a>
      {:else if field.key==='status'}{({planned:'未生效',active:'存续',matured:'到期',closed:'关闭'} as Record<string,string>)[String(row.status)]??String(row.status)}
      {:else}{formatDataValue(field,row[field.key])}{/if}
     </Table.Cell>{/each}
    </Table.Row>
   {:else}<Table.Row><Table.Cell colspan={fields.length} class="empty-row">暂无记录</Table.Cell></Table.Row>{/each}{/if}
  </Table.Body>
 </Table.Root>
 </div>
 <div class="pagination-bar"><strong>{total.toLocaleString('zh-CN')} 条</strong><label>每页<NativeSelect aria-label="每页条数" value={String(options.pageSize)} onchange={event=>change({size:event.currentTarget.value})}><option value="25">25</option><option value="50">50</option><option value="100">100</option></NativeSelect></label><span>第 {options.page+1} / {pages} 页</span><Button variant="outline" aria-label="上一页" disabled={loading||options.page===0} onclick={()=>change({page:String(options.page-1)})}>上一页</Button><Button variant="outline" aria-label="下一页" disabled={loading||options.page+1>=pages} onclick={()=>change({page:String(options.page+1)})}>下一页</Button></div>
</ModuleCard>
<style>
 :global(.data-editor) {min-width:0;overflow:hidden;}
 .table-toolbar,.table-actions,.pagination-bar,.table-toolbar form {display:flex;align-items:center;gap:.75rem;}
 .table-toolbar,.pagination-bar {padding:1rem;flex-wrap:wrap;}
 .table-toolbar {justify-content:space-between;gap:1rem;}.table-toolbar form{position:relative;flex:0 1 20rem;min-width:12rem;}.table-actions{flex-wrap:wrap;gap:.5rem;}
 :global(.table-toolbar form input){padding-right:3.25rem;} :global(.table-toolbar form button){position:absolute;right:0;top:0;} :global(.table-actions select){width:auto;min-width:7rem;}.pagination-bar label{white-space:nowrap;} :global(.pagination-bar select){width:5rem;}
 .view-columns {display:flex;flex-direction:column;gap:.75rem;}.view-columns label,.pagination-bar label{display:flex;align-items:center;gap:.5rem;font-size:.875rem;}.pagination-bar strong{margin-right:auto;}

 .table-shell{overflow:auto;max-width:100%;border-block:1px solid var(--line);}
 :global(.data-editor table){width:100%;font-variant-numeric:tabular-nums;}
 :global(.data-editor th),:global(.data-editor td){white-space:nowrap;padding:.75rem 1rem;}
 :global(.data-editor .numeric){text-align:right;}:global(.data-editor th.numeric button){margin-left:auto;}
 :global(.data-editor .debt-row){cursor:pointer;}:global(.data-editor .debt-row:hover){background:var(--brand-soft);}
 :global(.data-editor .debt-row a){color:var(--brand);font-weight:bold;}
 :global(.data-editor .empty-row){height:8rem;text-align:center;}
 .pagination-bar{justify-content:flex-end;}.table-error{display:flex;gap:1rem;align-items:center;padding:1rem;color:#b42318;}
 @media(max-width:40rem){.table-toolbar form{flex-basis:100%;min-width:0;width:100%;}.table-toolbar{align-items:stretch;}.table-actions{width:100%;}.pagination-bar{justify-content:space-between;}}
</style>
