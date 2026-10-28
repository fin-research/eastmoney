import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { installDom, loadComponent } from './svelte-dom.mjs';
const window = installDom();
const { mount, unmount, flushSync, tick } = await import('svelte');
const { globalMessages } = await import('../../src/lib/global-messages.ts');
const { PERMISSION_CODES } = await import('../../src/lib/permissions.ts');
const {createClientSession}=await import('../../src/lib/client-session.ts');
const session=createClientSession({user:{id:'auth0|test',email:'test@18.cn'},account:{name:'测试人员',department:'资金管理部'},_roles:['admin'],role:'admin',picture:'',permissions:[...PERMISSION_CODES],expiresAt:Date.now()/1000+3600});
const context=new Map([['site-session',session]]);
globalThis.fetch = async () => Response.json({user:null,account:null});
const View = await loadComponent('src/lib/management/ManagementPeopleView.svelte', (await readFile(new URL('../../src/lib/management/ManagementPeopleView.svelte',import.meta.url),'utf8')).replace("import { invalidate } from '$app/navigation';", "const invalidate=async()=>{};"));
const people=[{id:'auth0|test',name:'测试人员',department:'资金管理部',email:'test@18.cn',active:true,roles:[]},{id:'auth0|other',name:'同事',department:'研究部',email:'other@18.cn',active:true,roles:[]}];
const roles=[{id:'rol_A',name:'测试管理员',description:''},{id:'rol_B',name:'测试成员',description:''}];
const configurations={rol_A:{permissions:[PERMISSION_CODES[0]]},rol_B:{permissions:[]}};
const pageData={permissions:['auth.permission:update'],updatedAt:Date.now(),mode:'enforce'};
const app = mount(View,{context,target:document.body,props:{data:{...pageData,tab:'people',people,roles:[],configurations:{}}}});
flushSync();
assert.equal(document.querySelector('#person-department').value,'资金管理部');
assert.equal(document.querySelector('.people-list').textContent.includes('test@18.cn'),false);
flushSync(()=>document.querySelectorAll('.people-list button')[1].click());
assert.equal(document.querySelector('#person-name').value,'同事');
assert.equal(document.querySelector('#person-department').value,'研究部');
assert.equal(document.querySelector('.permission-editor form'),null);
assert.equal(document.querySelector('.role-list'),null);
const personWrites=[];
globalThis.fetch=async(url,init)=>{
  if(url==='/api/management/people'){
    personWrites.push(JSON.parse(init.body));
    return Response.json({id:'auth0|other',name:'新同事',department:'投资部',email:'other@18.cn'});
  }
  return Response.json({user:null,account:null});
};
flushSync(()=>{
  const input=document.querySelector('#person-name');input.value='新同事';input.dispatchEvent(new window.Event('input',{bubbles:true}));
  const department=document.querySelector('#person-department');department.value='投资部';department.dispatchEvent(new window.Event('input',{bubbles:true}));
  document.querySelector('.person-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
});
for(let i=0;i<5;i++){await new Promise(resolve=>setTimeout(resolve,0));flushSync();}
assert.deepEqual(personWrites,[{id:'auth0|other',name:'新同事',department:'投资部'}]);
assert.match(document.querySelector('.people-list').textContent,/新同事/);
await unmount(app);

const rolesApp = mount(View,{context,target:document.body,props:{data:{...pageData,tab:'roles',people:[],roles,configurations}}});
flushSync();
assert.equal(document.querySelector('.people-list'),null);
assert.equal(document.querySelector('a[target="_blank"]').getAttribute('href'),'https://manage.auth0.com/dashboard/eu/hasbai/roles');
assert.equal(document.querySelectorAll('.action-granted').length,1);
assert.ok(document.querySelectorAll('.scope-section').length>1);
flushSync(()=>document.querySelectorAll('.role-list button')[1].click());
assert.equal(document.querySelectorAll('.action-granted').length,0);
const search=document.querySelector('input[aria-label="搜索权限"]');
flushSync(()=>{search.value='没有的权限';search.dispatchEvent(new window.Event('input',{bubbles:true}));});
assert.ok(document.querySelector('.permission-editor').textContent.includes('无匹配权限'));
const scopeButton = label => [...document.querySelectorAll('.scope-filters button')].find(button => button.textContent.trim() === label);
flushSync(()=>{search.value='';search.dispatchEvent(new window.Event('input',{bubbles:true}));scopeButton('二级债券池').click();});
flushSync(()=>{search.value='市场';search.dispatchEvent(new window.Event('input',{bubbles:true}));});
assert.equal(scopeButton('二级债券池').getAttribute('aria-pressed'),'true','search must keep the active scope visible');
assert.ok(document.querySelector('.permission-editor').textContent.includes('无匹配权限'));
flushSync(()=>scopeButton('全部范围').click());
assert.ok(document.querySelector('.scope-section[aria-label="市场研究"]'),'clearing the scope recovers matching search results');
assert.equal(search.value,'市场','changing scope preserves the search');
await unmount(rolesApp);
const LoadingPage=await loadComponent('src/routes/management/people/+page.svelte');
let peopleReads=0;
globalThis.fetch=async url=>{
  if(url==='/api/management/people'){
    peopleReads++;
    return peopleReads===1 ? Response.json({detail:'暂时不可用'},{status:503}) : Response.json(people);
  }
  return Response.json({user:null,account:null});
};
const directApp=mount(LoadingPage,{context,target:document.body,props:{data:{tab:'people',view:null,permissions:[]}}});
flushSync();
for(let i=0;i<5;i++){await new Promise(resolve=>setTimeout(resolve,0));flushSync();}
assert.equal(peopleReads,1);
assert.match(document.querySelector('[role="alert"]').textContent,/人员资料加载失败/);
flushSync(()=>[...document.querySelectorAll('button')].find(button=>button.textContent==='重试').click());
for(let i=0;i<5;i++){await new Promise(resolve=>setTimeout(resolve,0));flushSync();}
assert.equal(peopleReads,2);
assert.match(document.querySelector('.people-list').textContent,/测试人员/);
await unmount(directApp);
let resolveView;
const pendingView=new Promise(resolve=>{resolveView=resolve;});
const loadingApp=mount(LoadingPage,{context,target:document.body,props:{data:{tab:'people',view:pendingView,permissions:['auth.permission:update']}}});
flushSync();
assert.equal(document.querySelector('[role="status"][aria-busy="true"]').getAttribute('aria-label'),'正在加载人员');
assert.equal(document.querySelector('.people-list'),null);
resolveView({tab:'people',people,roles:[],configurations:{}});
for(let i=0;i<5;i++){await new Promise(resolve=>setTimeout(resolve,0));flushSync();}
assert.match(document.querySelector('.people-list').textContent,/测试人员/);
await unmount(loadingApp);
let rejectView;
const failedView=new Promise((_,reject)=>{rejectView=reject;});
const failedApp=mount(LoadingPage,{context,target:document.body,props:{data:{tab:'people',view:failedView,permissions:[]}}});
flushSync();
rejectView(new Error('fixture identity failure'));
for(let i=0;i<5;i++){await new Promise(resolve=>setTimeout(resolve,0));flushSync();}
assert.match(document.querySelector('[role="alert"]').textContent,/人员资料加载失败/);
assert.ok([...document.querySelectorAll('button')].some(button=>button.textContent==='重试'));
await unmount(failedApp);
globalMessages.clear();

const profileSource=(await readFile(new URL('../../src/routes/management/me/+page.svelte',import.meta.url),'utf8'))
  .replace("import { invalidate } from '$app/navigation';", "const invalidate=async()=>{};")
  .replace("import { isLoginRedirecting } from '$lib/auth-client';", "const isLoginRedirecting=()=>false;");
const ProfilePage=await loadComponent('src/routes/management/me/+page.svelte',profileSource);
globalThis.fetch=async()=>Response.json({name:'测试人员',department:'资金管理部',email:'test@18.cn',emailVerified:true,roles:[],permissions:[]});
const profileApp=mount(ProfilePage,{context,target:document.body,props:{data:{email:'test@18.cn',account:{name:'测试人员',department:'资金管理部'}}}});
for(let i=0;i<10;i++){await new Promise(resolve=>setTimeout(resolve,0));flushSync();}
assert.equal(document.querySelector('input[name="name"]').value,'测试人员');
assert.equal(document.querySelector('input[name="department"]').value,'资金管理部');
assert.equal(document.querySelector('input[name="department"]').readOnly,false);
assert.equal(document.querySelector('.profile-permissions'),null,'permissions moved to their own page');
await unmount(profileApp);
const PermissionPage=await loadComponent('src/routes/management/permissions/+page.svelte');
session.seed({...session.current(),_roles:['authenticated','financing:admin'],permissions:[PERMISSION_CODES[0]]});
const permissionsApp=mount(PermissionPage,{context,target:document.body});flushSync();
assert.deepEqual([...document.querySelectorAll('.permission-roles li')].map(node=>node.textContent.trim()),['基础用户','融资管理员']);
assert.equal([...document.querySelectorAll('a')].find(node=>node.textContent.trim()==='刷新权限').getAttribute('href'),'/auth/login?returnTo=%2Fmanagement%2Fpermissions');
assert.equal(document.querySelectorAll('.action-granted').length,1);
await unmount(permissionsApp);

const AccountHost=await loadComponent('tests/helpers/AccountHost.svelte',`<script>
import {setContext} from 'svelte';
import AuthMenu from '../../src/lib/AuthMenu.svelte';
let account=$state({name:'测试人员',department:'资金管理部'});
setContext('site-account',()=>account);
export function rename(){account={name:'新姓名',department:'资金管理部'}};
</script><AuthMenu />`);
const accountApp=mount(AccountHost,{context,target:document.body});flushSync();
assert.equal(document.querySelectorAll('a').length,1);
assert.equal(document.querySelector('a').getAttribute('href'),'/management/me');
assert.match(document.querySelector('a').textContent,/测试人员\s*\/\s*资金管理部/);
assert.ok(document.querySelector('a svg'));
assert.equal(document.querySelector('[href="/management"]'),null);
flushSync(()=>accountApp.rename());assert.match(document.querySelector('a').textContent,/新姓名/);
await unmount(accountApp);

// Popover interaction and focus are covered in tests/visual/ui-contracts.spec.mjs.
await tick();await window.happyDOM.abort();
console.log('Management and account interaction checks passed');
