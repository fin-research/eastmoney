<script lang="ts">
  import { enhance } from '$app/forms';
  import { untrack } from 'svelte';
  import { globalMessages } from '$lib/global-messages';
  import ModuleCard from '../../components/ModuleCard.svelte';
  import PanelHeading from '$lib/trading-research/PanelHeading.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import { NativeSelect } from '$lib/components/ui/native-select/index.js';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import type { TestRecipient, TestSendResult } from './types';
  let {people,requestId,canSend=false}:{people:TestRecipient[];requestId:string;canSend?:boolean}=$props();
  let mode=$state('single'), selected=$state<string[]>([]), channels=$state<string[]>(['email']);
  let title=$state('通知测试'), text=$state('这是一条测试消息，用于确认通知渠道可以正常接收。');
  let query=$state(''), sending=$state(false), result=$state<TestSendResult|null>(null);
  let submissionId=$state(untrack(()=>requestId));
  const names:Record<string,string>={email:'邮件',telegram:'Telegram',webpush:'Web Push'};
  const visible=$derived(people.filter(person=>`${person.name} ${person.email}`.toLowerCase().includes(query.toLowerCase())));
  function toggle(id:string,checked:boolean) {selected=checked?[...selected,id]:selected.filter(value=>value!==id);}
</script>
<ModuleCard>
  <PanelHeading id="test-message-heading" title="测试消息" />
  <form method="POST" action="?/sendTest" class="test-form" use:enhance={()=>{
    sending=true;
    return async ({result:response,update})=>{
      sending=false;
      if(response.type==='success'&&response.data?.testResult){
        result=response.data.testResult as TestSendResult;
        globalMessages.success(`已提交 ${result.deliveries} 条测试消息，跳过 ${result.skipped.length} 项`);
        submissionId=crypto.randomUUID();
      }else if(response.type==='failure'){globalMessages.error(String(response.data?.message??'测试消息提交失败'));}
      else if(response.type==='error'){globalMessages.error('测试消息提交失败，请重试');}
      await update({reset:false});
    };
  }}>
    <input type="hidden" name="requestId" value={submissionId}/>
    <div class="form-grid">
      <label>发送方式<NativeSelect name="mode" bind:value={mode} onchange={()=>selected=selected.slice(0,1)} disabled={sending} class="min-h-11"><option value="single">单发</option><option value="multiple">群发</option></NativeSelect></label>
      {#if mode==='single'}
        <label>接收用户<NativeSelect value={selected[0]??''} onchange={event=>selected=event.currentTarget.value?[event.currentTarget.value]:[]} disabled={sending} class="min-h-11"><option value="">选择用户</option>{#each people as person}<option value={person.id}>{person.name || person.email} · {person.email}</option>{/each}</NativeSelect></label>
      {:else}
        <label>查找用户<Input bind:value={query} type="search" disabled={sending}/></label>
      {/if}
    </div>
    {#if mode==='multiple'}
      <fieldset class="recipients"><legend>接收用户 · 已选 {selected.length}/50</legend>
        <div class="selection-actions"><Button type="button" variant="outline" disabled={sending||visible.length===0} onclick={()=>selected=[...new Set([...selected,...visible.map(person=>person.id)])].slice(0,50)}>选择当前结果</Button><Button type="button" variant="outline" disabled={sending||selected.length===0} onclick={()=>selected=[]}>清空</Button></div>
        <div class="recipient-list">{#each visible as person}<label class="check-label"><Checkbox checked={selected.includes(person.id)} onCheckedChange={checked=>toggle(person.id,checked===true)} disabled={sending||(!selected.includes(person.id)&&selected.length>=50)}/><span>{person.name || person.email}<span class="email">{person.email}</span></span></label>{:else}<p>没有匹配的用户</p>{/each}</div>
      </fieldset>
    {/if}
    {#each selected as id}<input type="hidden" name="userIds" value={id}/>{/each}
    <fieldset><legend>发送渠道</legend><div class="channels">{#each Object.entries(names) as [value,label]}<label class="check-label"><Checkbox checked={channels.includes(value)} onCheckedChange={checked=>channels=checked?[...channels,value]:channels.filter(channel=>channel!==value)} disabled={sending}/>{label}</label>{/each}</div></fieldset>
    {#each channels as channel}<input type="hidden" name="channels" value={channel}/>{/each}
    <label>标题<Input name="title" bind:value={title} maxlength={120} required disabled={sending}/></label>
    <label>消息内容<Textarea name="text" bind:value={text} maxlength={1000} rows={5} required disabled={sending}/></label>
    <div class="send-actions">{#if canSend}<Button type="submit" disabled={sending||selected.length===0||channels.length===0||!title.trim()||!text.trim()}>{sending?'提交中…':`发送测试消息${selected.length>1?`（${selected.length} 人）`:''}`}</Button>{/if}</div>
  </form>
  {#if result?.skipped.length}<div class="skipped"><PanelHeading id="test-skipped-heading" title="未发送"/><ul>{#each result.skipped as item}<li>{people.find(person=>person.id===item.userId)?.name || item.userId} · {names[item.channel]} · {item.reason}</li>{/each}</ul></div>{/if}
</ModuleCard>
<style>
.test-form{display:grid;gap:1.25rem}.form-grid{display:grid;grid-template-columns:1fr 2fr;gap:1rem}label{display:grid;gap:.5rem;font-weight:bold}fieldset{min-width:0}legend{font-weight:bold;margin-bottom:.5rem}.channels,.selection-actions,.send-actions{display:flex;flex-wrap:wrap;gap:1rem}.check-label{display:flex;align-items:center;gap:.75rem;min-height:44px;font-weight:normal}.recipient-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:.5rem 1rem;max-height:20rem;overflow:auto;margin-top:.75rem}.email{display:block;color:var(--text-muted);overflow-wrap:anywhere;font-size:.875rem}.send-actions{justify-content:flex-end}.skipped{margin-top:1.5rem}ul{padding-left:1.25rem}li{margin:.5rem 0;overflow-wrap:anywhere}@media(max-width:640px){.form-grid{grid-template-columns:1fr}}
</style>
