<script lang="ts">
  import { enhance } from '$app/forms';
  import ModuleCard from '../../components/ModuleCard.svelte';
  import PanelHeading from '$lib/trading-research/PanelHeading.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { NativeSelect } from '$lib/components/ui/native-select/index.js';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import type {Delivery,DeliveryList,DeliveryDetail} from './types';
  let {list,detail=null,filters={},canRetry=false,message}:{list:DeliveryList;detail?:DeliveryDetail|null;filters?:Record<string,string>;canRetry?:boolean;message?:string}=$props();
  let retryTarget= $state<Delivery|null>(null);
  const labels:Record<string,string>={queued:'已入队',processing:'发送中',retrying:'等待重试',accepted:'渠道已接收',failed:'失败',uncertain:'结果待确认'};
  const sources:Record<string,string>={'market-briefing':'市场点评',financing:'融资提醒',ingest:'央行资讯',notification:'用户订阅',workflow:'Workflow','admin-test':'测试消息'};
  const stamp=(value:number|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
  function link(values:Record<string,string|number|null>){const p=new URLSearchParams(filters);for(const [k,v]of Object.entries(values)){if(v===null)p.delete(k);else p.set(k,String(v));}return `/management/messenger?${p}`;}
</script>
<div class="messenger-view">
  <PanelHeading id="messenger-heading" title="消息投递" />
  <ModuleCard>
    <form method="GET" class="filters">
      <label>渠道<NativeSelect class="min-h-11" name="channel" value={filters.channel??''}><option value="">全部</option><option value="email">邮件</option><option value="telegram">Telegram</option><option value="webpush">Web Push</option></NativeSelect></label>
      <label>状态<NativeSelect class="min-h-11" name="status" value={filters.status??''}><option value="">全部</option>{#each Object.entries(labels) as [value,label]}<option {value}>{label}</option>{/each}</NativeSelect></label>
      <label>来源<NativeSelect class="min-h-11" name="source" value={filters.source??''}><option value="">全部</option><option value="market-briefing">市场点评</option><option value="financing">融资提醒</option><option value="ingest">央行资讯</option><option value="notification">用户订阅</option><option value="workflow">Workflow</option><option value="admin-test">测试消息</option></NativeSelect></label>
      <Button type="submit">筛选</Button><Button variant="outline" href="/management/messenger">刷新</Button>
    </form>
    <div class="counts" aria-label="消息统计">{#each list.counts as item}<span>{labels[item.status]??item.status} <strong>{item.count}</strong></span>{/each}</div>
    {#if message}<p role="status">{message}</p>{/if}
    <div class="table-scroll" tabindex="0" role="region" aria-label="消息记录">
      <table><thead><tr><th>创建时间</th><th>消息</th><th>渠道 / 来源</th><th>收件人</th><th>状态</th><th>尝试</th><th>操作</th></tr></thead>
        <tbody>{#each list.items as row}<tr>
          <td class="created">{stamp(row.createdAt)}</td><td class="subject"><a href={link({id:row.id})}>{row.subject}</a></td>
          <td><span>{row.channel==='email'?'邮件':row.channel==='webpush'?'Web Push':'Telegram'}</span><span class="delivery-source">{sources[row.source]??row.source}</span></td><td class="recipient">{row.recipient}</td>
          <td><span class:failure={row.status==='failed'||row.status==='uncertain'} class:success={row.status==='accepted'}>{labels[row.status]??row.status}</span></td>
          <td>{row.attempts}</td><td>{#if canRetry&&['failed','uncertain'].includes(row.status)}<Button variant="outline" onclick={()=>retryTarget=row} aria-label={`重试 ${row.subject}`}>重试</Button>{:else}—{/if}</td>
        </tr>{:else}<tr><td colspan="7">暂无消息</td></tr>{/each}</tbody>
      </table>
    </div>
    <div class="pagination">{#if filters.before}<Button variant="outline" href={link({before:null,id:null})}>最新记录</Button>{/if}{#if list.nextCursor}<Button variant="outline" href={link({before:list.nextCursor,id:null})}>下一页</Button>{/if}</div>
  </ModuleCard>
  {#if detail}<ModuleCard>
    <PanelHeading id="message-detail" title="投递详情" />
    <dl><dt>消息编号</dt><dd>{detail.id}</dd><dt>状态</dt><dd>{labels[detail.status]}</dd><dt>渠道编号</dt><dd>{detail.providerId??'—'}</dd><dt>错误</dt><dd>{detail.error??'—'}</dd></dl>
    <pre>{detail.content.text??detail.content.html??''}</pre>
    <div class="table-scroll" tabindex="0" role="region" aria-label="发送尝试"><table><thead><tr><th>尝试</th><th>开始时间</th><th>完成时间</th><th>结果</th><th>错误</th></tr></thead><tbody>{#each detail.history as row}<tr><td>{row.number}</td><td>{stamp(row.started_at)}</td><td>{stamp(row.finished_at)}</td><td>{labels[row.status]??row.status}</td><td>{row.error??'—'}</td></tr>{:else}<tr><td colspan="5">尚未发送</td></tr>{/each}</tbody></table></div>
    {#each detail.retries as row}<p>手动重试 · {stamp(row.created_at)} · {row.actor}</p>{/each}
  </ModuleCard>{/if}
</div>
<AlertDialog.Root open={!!retryTarget} onOpenChange={(open)=>{if(!open)retryTarget=null;}}>
  <AlertDialog.Content><AlertDialog.Header><AlertDialog.Title>重试消息</AlertDialog.Title><AlertDialog.Description>{retryTarget?.status==='uncertain'?'上次发送结果不确定，重试可能重复发送。':'确认重新发送此消息？'}</AlertDialog.Description></AlertDialog.Header>
    <form method="POST" action="?/retry" use:enhance><input type="hidden" name="id" value={retryTarget?.id??''}/><input type="hidden" name="confirmUncertain" value="yes"/>
      <AlertDialog.Footer><AlertDialog.Cancel type="button">取消</AlertDialog.Cancel><Button type="submit">确认重试</Button></AlertDialog.Footer>
    </form>
  </AlertDialog.Content>
</AlertDialog.Root>
<style>
  .messenger-view{display:grid;gap:1rem;min-width:0}.filters{display:flex;flex-wrap:wrap;align-items:end;gap:1rem}label{display:grid;gap:.5rem;font-weight:bold}.counts{display:flex;gap:1.25rem;flex-wrap:wrap;margin:1.25rem 0}.table-scroll{overflow:auto;min-width:0;max-width:100%}table{width:100%;border-collapse:collapse;font-size:.875rem}th,td{text-align:left;padding:.75rem;border-bottom:1px solid var(--border-color);white-space:nowrap}th{font-weight:bold}.created{width:7rem;white-space:normal}.delivery-source{display:block;color:var(--text-muted)}.subject{min-width:220px;max-width:420px;white-space:normal;overflow-wrap:anywhere}.subject a{display:block;overflow-wrap:anywhere}.recipient{min-width:10rem;max-width:250px;white-space:normal;overflow-wrap:anywhere}.failure{color:var(--color-danger,#b42318)}.success{color:var(--business-accent,#067647)}.pagination{display:flex;gap:1rem;justify-content:end;margin-top:1rem}dl{display:grid;grid-template-columns:auto 1fr;gap:.5rem 1rem}dd{margin:0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;max-height:24rem;overflow:auto}a{color:var(--color-primary)}
</style>
