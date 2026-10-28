<script lang="ts">
 import * as Popover from '$lib/components/ui/popover/index.js';
 import { Button } from '$lib/components/ui/button/index.js';
 import { Input } from '$lib/components/ui/input/index.js';
 import { NativeSelect } from '$lib/components/ui/native-select/index.js';
 import { ArrowDown, ArrowUp, ArrowUpDown, EyeOff, Filter, X } from '@lucide/svelte';
 import type { FieldConfig } from './data-admin';
 let { field, sortDirection, filter = {}, onsort, onfilter, onhide }: {
  field: FieldConfig; sortDirection?: 'asc'|'desc'; filter?: {value?:string;min?:string;max?:string};
  onsort:(direction:string)=>void;onfilter:(filter:{value?:string;min?:string;max?:string})=>void;onhide:()=>void;
 }=$props();
 let open=$state(false), value=$state(''), min=$state(''), max=$state('');
 $effect(()=>{if(open){value=filter.value??'';min=filter.min??'';max=filter.max??'';}});
 const choices=$derived(field.key==='status'?[{value:'planned',label:'未生效'},{value:'active',label:'存续'},{value:'matured',label:'到期'},{value:'closed',label:'关闭'}]:field.options??[]);
 function apply(){onfilter(Object.fromEntries(Object.entries(field.type==='number'||field.type==='date'?{min,max}:{value}).filter(([,value])=>value!==''&&value!=null).map(([key,value])=>[key,String(value)])));open=false;}
</script>
<Popover.Root bind:open>
 <Popover.Trigger>{#snippet child({props})}<Button {...props} variant="ghost" aria-label={`${field.label}列菜单`} class="column-trigger">{field.label}{#if sortDirection==='asc'}<ArrowUp size={15}/>{:else if sortDirection==='desc'}<ArrowDown size={15}/>{:else}<ArrowUpDown size={15}/>{/if}{#if Object.keys(filter).length}<Filter size={14}/>{/if}</Button>{/snippet}</Popover.Trigger>
 <Popover.Content align="start" class="w-64 p-2 overflow-y-auto" style="max-height:min(32rem,var(--bits-floating-available-height));">
  <div class="column-menu-actions">
   <Button variant="ghost" onclick={()=>{onsort('asc');open=false;}}><ArrowUp size={16}/>升序</Button>
   <Button variant="ghost" onclick={()=>{onsort('desc');open=false;}}><ArrowDown size={16}/>降序</Button>
   <Button variant="ghost" onclick={()=>{onsort('');open=false;}}><X size={16}/>默认排序</Button>
   <Button variant="ghost" disabled={field.key==='name'} onclick={()=>{onhide();open=false;}}><EyeOff size={16}/>隐藏列</Button>
  </div>
  <form class="column-filter" onsubmit={event=>{event.preventDefault();apply();}}>
   <strong>筛选</strong>
   {#if field.type==='number'||field.type==='date'}
    <label>从<Input aria-label={`${field.label}最小值`} type={field.type} step={field.step} bind:value={min}/></label>
    <label>至<Input aria-label={`${field.label}最大值`} type={field.type} step={field.step} bind:value={max}/></label>
   {:else if choices.length}<NativeSelect aria-label={`${field.label}筛选值`} bind:value><option value="">全部</option>{#each choices as choice}<option value={choice.value}>{choice.label}</option>{/each}</NativeSelect>
   {:else}<Input aria-label={`${field.label}筛选值`} bind:value/>{/if}
   <div class="filter-actions"><Button type="button" variant="ghost" onclick={()=>{onfilter({});open=false;}}>清除</Button><Button type="submit">应用</Button></div>
  </form>
 </Popover.Content>
</Popover.Root>
<style>
 .column-menu-actions{display:flex;flex-direction:column;align-items:stretch;}
 :global(.column-menu-actions button){justify-content:flex-start;width:100%;}
 .column-filter{display:flex;flex-direction:column;gap:.75rem;border-top:1px solid var(--line);margin-top:.5rem;padding:.75rem .5rem .25rem;}
 .column-filter strong,.column-filter label{font-size:.875rem;}.column-filter label{display:flex;flex-direction:column;gap:.375rem;}
 .filter-actions{display:flex;justify-content:flex-end;gap:.5rem;}
</style>
