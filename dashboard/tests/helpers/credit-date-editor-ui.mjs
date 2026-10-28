import assert from 'node:assert/strict';
import {creditDataFixture,creditDataPatch} from './credit-data-fixture.mjs';
import {installDom,loadComponent} from './svelte-dom.mjs';
const window=installDom();
const {mount,unmount,flushSync,tick}=await import('svelte');
const {PERMISSION_CODES}=await import('../../src/lib/permissions.ts');
const {createClientSession}=await import('../../src/lib/client-session.ts');
const session=createClientSession({user:{id:'auth0|test',email:'test@18.cn'},account:{name:'测试人员',department:'资金管理部'},_roles:['admin'],role:'admin',picture:'',permissions:[...PERMISSION_CODES],expiresAt:Date.now()/1000+3600});
const context=new Map([['site-session',session]]);

document.body.innerHTML='<div id="tr-topbar-actions"></div><div id="host"></div>';
const summary={reportDate:'2026-09-11',institutionCount:1,approvedCount:1,totalLimit:8,totalUsed:1,totalAvailable:7,utilization:12.5,expiringWithin30Days:0};
let institution={reportDate:summary.reportDate,institutionName:'上海农商行（金市）',institutionType:'农商行',status:'approved',confidentialityStatus:false,totalLimit:8,totalUsed:1,totalRemaining:7,availableAmount:7,utilization:12.5,effectiveDate:'2025-08-31',expiryDate:'2026-08-31',items:[],clients:[{id:'fixture-client',name:'测试关联客户'}],notes:null};
const report=()=>({availableDates:['2026-08-21'],previousDate:null,summary,previousSummary:null,weeklySummary:{...summary,addedInstitutionCount:0,expiredInstitutionCount:0},previousWeeklySummary:null,institutions:[institution],weeklyNews:[],recentApprovals:[],limitChanges:[],usageChanges:[],calendarEvents:[]});
const writes=[];let reads=0;
globalThis.fetch=async(url,options={})=>{
  if(options.method==='PATCH') {
    const body=JSON.parse(options.body);
    writes.push(body);
    institution={...institution,...body.changes.institution};
    return Response.json(creditDataPatch(report(),body));
  }
  reads++;return Response.json(creditDataFixture(report()));
};
async function settle(){for(let i=0;i<5;i++){await new Promise(r=>setImmediate(r));flushSync();await tick();}}
const View=await loadComponent('src/lib/trading-research/CreditView.svelte');
const app=mount(View,{context,target:document.querySelector('#host'),props:{tab:'ledger'}});await settle();
flushSync(()=>document.querySelector('.tr-credit-table tbody tr').click());await settle();
const detail=document.querySelector('.tr-credit-detail');
assert.ok(detail);
assert.equal([...detail.querySelectorAll('label')].some(label=>label.textContent.trim()==='记录日期'),false);
const date=[...detail.querySelectorAll('label')].find(label=>label.textContent.trim()==='到期日').querySelector('input');
assert.equal(date.disabled,false);
assert.equal([...detail.querySelectorAll('label')].find(label=>label.textContent.trim()==='授信总额（亿元）').querySelector('input').disabled,true);
assert.equal([...detail.querySelectorAll('label')].find(label=>label.textContent.trim()==='可用额度（亿元）').querySelector('input').disabled,true);
date.value='2027-08-31';date.dispatchEvent(new window.Event('input',{bubbles:true}));
date.dispatchEvent(new window.Event('change',{bubbles:true}));await settle();
assert.equal(writes.length,0);
const save=[...detail.querySelectorAll('button')].find(button=>button.textContent.trim()==='保存');
assert.ok(save);detail.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();
assert.equal(writes.length,1);
assert.equal(writes[0].operation,'maintenance');
assert.equal(writes[0].reportDate,summary.reportDate);
assert.equal(writes[0].viewDate,summary.reportDate);
assert.equal(writes[0].calendarMonth,'2026-09');
assert.equal(reads,1,'save must not reload the report');
assert.equal(writes[0].changes.institution.expiryDate,'2027-08-31');
assert.equal(institution.expiryDate,'2027-08-31');
assert.match(document.body.textContent,/授信申请/);
const toggle=detail.querySelector('[role="switch"]');
assert.equal(toggle.getAttribute('aria-label'),'定稿');
assert.equal(toggle.getAttribute('aria-checked'),'false');
toggle.click();await settle();assert.equal(writes.length,1);
detail.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();
assert.deepEqual(writes[1].changes,{institution:{verified:true}});
assert.equal(toggle.getAttribute('aria-checked'),'true');
toggle.click();await settle();
detail.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();
assert.deepEqual(writes[2].changes,{institution:{verified:false}});
assert.equal(reads,1);
await unmount(app);await tick();
document.body.innerHTML='<div id="tr-topbar-actions"></div><div id="host"></div>';
const reader=createClientSession({user:{id:'auth0|reader',email:'reader@18.cn'},account:{name:'只读人员',department:'资金管理部'},_roles:['authenticated'],role:'authenticated',picture:'',permissions:['credit.institution:read'],expiresAt:Date.now()/1000+3600});
const readonly=mount(View,{context:new Map([['site-session',reader]]),target:document.querySelector('#host'),props:{tab:'ledger'}});await settle();
flushSync(()=>document.querySelector('.tr-credit-table tbody tr').click());await settle();
const readonlyDetail=document.querySelector('.tr-credit-detail');
assert.ok([...readonlyDetail.querySelectorAll('input,select,textarea')].every(input=>input.disabled));
assert.equal(readonlyDetail.querySelector('[role="switch"]').disabled,true);
assert.equal([...readonlyDetail.querySelectorAll('button')].some(button=>button.textContent.trim()==='保存'),false);
await unmount(readonly);await tick();
// Exercise the actual editable inputs: floating tails must not reach input.value.
const Editor=await loadComponent('src/lib/trading-research/CreditDetailEditor.svelte');
const decimalInstitution={...institution,totalLimit:101.25,items:[
  {type:'bond_investment',limitAmount:47.22,usedAmount:22.2,primaryUsedAmount:23.1,secondaryUsedAmount:-0.9,details:null},
]};
const editor=mount(Editor,{context,target:document.querySelector('#host'),props:{institution:decimalInstitution,
  reportDate:summary.reportDate,calendarMonth:'2026-09',previousDate:null,contextVersion:1,onapplied:()=>{}}});await settle();
const bond=document.querySelector('.tr-credit-item-bond');
const inputFor=label=>[...bond.querySelectorAll('label')].find(node=>node.textContent.trim()===label).querySelector('input');
assert.equal(inputFor('额度（亿元）').disabled,false);
assert.equal(inputFor('已用（亿元）').value,'22.2');
assert.equal(inputFor('可用（亿元）').value,'25.02');
inputFor('可用（亿元）').value='30';
inputFor('可用（亿元）').dispatchEvent(new window.Event('input',{bubbles:true}));await settle();
assert.equal(inputFor('已用（亿元）').value,'17.22');
assert.equal(inputFor('二级买卖').value,'-5.88');
await unmount(editor);await tick();await window.happyDOM.abort();console.log('Credit editable detail and role checks passed');
