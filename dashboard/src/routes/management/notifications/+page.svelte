<script lang="ts">
import { CLIENT_SESSION_CONTEXT, type ClientSession } from '$lib/client-session';
import { getContext, onMount } from 'svelte';
import ModuleCard from '../../../components/ModuleCard.svelte';
import PanelHeading from '$lib/trading-research/PanelHeading.svelte';
import { Button } from '$lib/components/ui/button/index.js';
import { Input } from '$lib/components/ui/input/index.js';
import { Checkbox } from '$lib/components/ui/checkbox/index.js';
import { globalMessages } from '$lib/global-messages';
type Category='workflow'|'trading'|'financing';
type Channel='email'|'telegram'|'webpush';
type Settings={email:string;telegramChatId:string;subscriptions:Record<Category,Channel[]>;devices:{id:string;createdAt:number}[];vapidPublicKey:string;categories:Category[]};
const session=getContext<ClientSession>(CLIENT_SESSION_CONTEXT);
const deviceKey=()=>`eastmoney:push-device:${$session?.user?.id ?? ''}`;
let currentDevice=$state('');
let settings=$state<Settings|null>(null),busy=$state(false),failure=$state(''),supported=$state(false),pushState=$state('未开启');
const labels:Record<Category,string>={workflow:'Workflow 通知',trading:'交易流程通知',financing:'融资待办通知'};
const channels:{id:Channel;label:string}[]=[{id:'email',label:'邮件'},{id:'telegram',label:'Telegram'},{id:'webpush',label:'Web Push'}];
async function api(path:string,method='GET',body?:unknown){const response=await fetch('/api/notifications/'+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw new Error(value.message||value.error||'通知设置失败');return value;}
async function load(){try{settings=await api('settings');failure='';}catch(e){failure=e instanceof Error?e.message:'读取失败';}}
async function save(){if(!settings||busy)return;busy=true;try{await api('settings','PUT',{email:settings.email,telegramChatId:settings.telegramChatId,subscriptions:settings.subscriptions});globalMessages.success('通知设置已保存');}catch(e){globalMessages.error((e as Error).message);}finally{busy=false;}}
function select(category:Category,channel:Channel,checked:boolean){if(!settings)return;settings.subscriptions[category]=checked?[...new Set([...settings.subscriptions[category],channel])]:settings.subscriptions[category].filter(item=>item!==channel);}
async function enablePush(){if(!settings||busy)return;busy=true;try{
 if(!settings.vapidPublicKey)throw new Error('Web Push 尚未配置');
 if(await Notification.requestPermission()!=='granted')throw new Error('请在浏览器设置中允许通知');
 const registration=await navigator.serviceWorker.register('/service-worker.js',{scope:'/'});await navigator.serviceWorker.ready;
 const key=Uint8Array.from(atob(settings.vapidPublicKey.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
 const existing=await registration.pushManager.getSubscription();
 const subscription=existing??await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
 try{const result=await api('push','POST',subscription.toJSON());settings.devices=result.devices;currentDevice=result.deviceId;try{localStorage.setItem(deviceKey(),currentDevice);}catch{}}
 catch(error){if(!existing)await subscription.unsubscribe();throw error;}
 pushState='已开启';globalMessages.success('当前设备已开启通知');
}catch(e){globalMessages.error((e as Error).message);}finally{busy=false;}}
async function removeDevice(id:string){if(busy)return;busy=true;try{await api('push','DELETE',{id});if(id===currentDevice){await (await navigator.serviceWorker.ready).pushManager.getSubscription().then(subscription=>subscription?.unsubscribe());pushState='未开启';currentDevice='';try{localStorage.removeItem(deviceKey());}catch{}}if(settings)settings.devices=settings.devices.filter(d=>d.id!==id);globalMessages.success('设备已移除');}catch(e){globalMessages.error((e as Error).message);}finally{busy=false;}}
onMount(()=>{try{currentDevice=localStorage.getItem(deviceKey())??'';}catch{}supported='serviceWorker'in navigator&&'PushManager'in window&&'Notification'in window;pushState=supported?Notification.permission==='denied'?'已阻止':'未开启':'浏览器不支持';void load();if(supported)void navigator.serviceWorker.ready.then(registration=>registration.pushManager.getSubscription()).then(subscription=>{if(subscription&&currentDevice)pushState='已开启';});});
</script>
<div class="notification-settings">
{#if failure}<p role="alert">{failure}</p><Button onclick={load}>重试</Button>{:else if !settings}<p role="status">正在读取通知设置…</p>{:else}
<ModuleCard><PanelHeading id="notifications-1" title="联系方式"/><div class="contact-fields"><label for="notification-email">联系邮箱<Input id="notification-email" type="email" bind:value={settings.email}/></label><label for="notification-telegram">Telegram Chat ID<Input id="notification-telegram" bind:value={settings.telegramChatId}/></label></div></ModuleCard>
<ModuleCard><PanelHeading id="notifications-2" title="通知订阅"/><div class="subscription-table"><table><thead><tr><th>通知类型</th>{#each channels as channel}<th>{channel.label}</th>{/each}</tr></thead><tbody>{#each settings.categories as category}<tr><th scope="row">{labels[category]}</th>{#each channels as channel}<td><Checkbox aria-label={`${labels[category]} · ${channel.label}`} checked={settings.subscriptions[category].includes(channel.id)} onCheckedChange={checked=>select(category,channel.id,checked)}/></td>{/each}</tr>{/each}</tbody></table></div><Button onclick={save} disabled={busy}>{busy?'保存中…':'保存设置'}</Button></ModuleCard>
<ModuleCard><PanelHeading id="notifications-3" title="浏览器设备"/><div class="device-actions"><span>{pushState}</span><Button onclick={enablePush} disabled={busy||!supported}>开启当前设备</Button></div><ul>{#each settings.devices as device,index}<li><span>设备 {index+1} · {new Date(device.createdAt).toLocaleDateString('zh-CN')}</span><Button variant="outline" disabled={busy} onclick={()=>removeDevice(device.id)}>移除</Button></li>{/each}</ul></ModuleCard>
{/if}
</div>
<style>
.subscription-table :global([role="checkbox"]) { margin-inline: auto; }
.notification-settings{display:grid;gap:20px;max-width:1100px}.contact-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}label{display:grid;gap:10px}.subscription-table{overflow:auto;margin-bottom:20px}table{width:100%;border-collapse:collapse}th,td{padding:16px;border-bottom:1px solid var(--border-color);text-align:center}th:first-child{text-align:left}.device-actions,li{display:flex;align-items:center;justify-content:space-between;gap:16px}ul{list-style:none;padding:0}li{padding:12px 0}@media(max-width:720px){.contact-fields{grid-template-columns:1fr}}
</style>
