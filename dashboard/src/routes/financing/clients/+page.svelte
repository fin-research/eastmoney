<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto, invalidateAll } from '$app/navigation';
  import ModuleCard from '../../../components/ModuleCard.svelte';
  import PanelHeading from '$lib/trading-research/PanelHeading.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { NativeSelect } from '$lib/components/ui/native-select/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import * as Table from '$lib/components/ui/table/index.js';
  import Modal from '$lib/components/Modal.svelte';
  import { globalMessages } from '$lib/global-messages';
  import { hasPermission } from '$lib/permissions';
  import { clientTypes, type ClientRecord } from '$lib/financing/client-input';
  let {data}=$props();
  let editing=$state<Partial<ClientRecord>|null>(null);
  let saving=$state(false);
  let query=$state('');
  $effect(()=>{query=data.query;});
  let formError=$state('');
  function edit(record:Partial<ClientRecord>){editing={...record};formError='';}
</script>
<ModuleCard labelledBy="clients-title">
  <PanelHeading id="clients-title" title="客户名单" />
  <div class="client-toolbar">
    <form onsubmit={(event)=>{event.preventDefault();void goto(`/financing/clients?q=${encodeURIComponent(query)}`);}}>
      <Input aria-label="搜索客户或别名" bind:value={query}/><Button type="submit" variant="outline">搜索</Button>
    </form>
    {#if hasPermission(data.permissions,'financing.data:create')}<Button onclick={()=>edit({type:'银行',aliases:[]})}>新增客户</Button>{/if}
  </div>
  <Table.Root>
    <Table.Header><Table.Row><Table.Head>客户名称</Table.Head><Table.Head>全称</Table.Head><Table.Head>类型</Table.Head><Table.Head>子类</Table.Head><Table.Head>别名</Table.Head><Table.Head>操作</Table.Head></Table.Row></Table.Header>
    <Table.Body>{#each data.rows as row (row.id)}
      <Table.Row><Table.Cell>{row.name}</Table.Cell><Table.Cell>{row.fullname??'—'}</Table.Cell><Table.Cell>{row.type}</Table.Cell><Table.Cell>{row.subtype??'—'}</Table.Cell><Table.Cell>{row.aliases.join('、')||'—'}</Table.Cell><Table.Cell>{#if hasPermission(data.permissions,'financing.data:update')}<Button variant="outline" aria-label={`编辑${row.name}`} onclick={()=>edit(row)}>编辑</Button>{/if}</Table.Cell></Table.Row>
    {:else}<Table.Row><Table.Cell colspan={6}>没有匹配的客户</Table.Cell></Table.Row>{/each}</Table.Body>
  </Table.Root>
  <div class="client-pagination"><span>共 {data.total} 位客户</span><Button variant="outline" disabled={data.page<=1} onclick={()=>goto(`/financing/clients?q=${encodeURIComponent(data.query)}&page=${data.page-1}`)}>上一页</Button><span>{data.page}</span><Button variant="outline" disabled={data.page*50>=data.total} onclick={()=>goto(`/financing/clients?q=${encodeURIComponent(data.query)}&page=${data.page+1}`)}>下一页</Button></div>
</ModuleCard>
{#if editing}
  <Modal open aria-label={editing.id?'编辑客户':'新增客户'} oncancel={(event)=>{if(saving)event.preventDefault();}} onclose={()=>{if(!saving)editing=null;}}>
    <h2>{editing.id?'编辑客户':'新增客户'}</h2>
    <form method="POST" action={editing.id?'?/update':'?/create'} use:enhance={()=>{saving=true;formError='';return async({result})=>{
      saving=false;if(result.type==='success'){globalMessages.success('客户已保存');editing=null;await invalidateAll();}
      else {formError=result.type==='failure'?String(result.data?.error??'保存失败'):'保存失败，请重试';globalMessages.error(formError);}
    };}} class="client-form">
      <input type="hidden" name="id" value={editing.id??''}/><input type="hidden" name="version" value={editing.version??''}/>
      <label for="client-name">客户名称</label><Input id="client-name" name="name" value={editing.name??''} required maxlength={500}/>
      <label for="client-fullname">全称</label><Input id="client-fullname" name="fullname" value={editing.fullname??''} maxlength={500}/>
      <label for="client-type">类型</label><NativeSelect id="client-type" name="type" value={editing.type}>{#each clientTypes as type}<option value={type}>{type}</option>{/each}</NativeSelect>
      <label for="client-subtype">子类</label><Input id="client-subtype" name="subtype" value={editing.subtype??''} maxlength={100}/>
      <label for="client-aliases">别名（每行一个）</label><Textarea id="client-aliases" name="aliases" value={editing.aliases?.join('\n')??''} rows={5}/>
      {#if formError}<p role="alert">{formError}</p>{/if}
      <div class="client-actions"><Button variant="outline" type="button" disabled={saving} onclick={()=>editing=null}>取消</Button><Button type="submit" disabled={saving}>{saving?'保存中':'保存'}</Button></div>
    </form>
  </Modal>
{/if}
<style>
  .client-toolbar,.client-toolbar form,.client-pagination,.client-actions{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap}
  .client-toolbar{justify-content:space-between;margin-block:1rem}.client-pagination{justify-content:flex-end;margin-top:1rem}
  @media(min-width:901px){
    .client-toolbar form{flex:0 1 34rem;flex-wrap:nowrap;min-width:0}
    .client-toolbar form :global(input){flex:1 1 0;min-width:0}
  }
  .client-form{display:grid;gap:.75rem}.client-actions{justify-content:flex-end;margin-top:1rem}.client-form p{color:var(--red)}
</style>
