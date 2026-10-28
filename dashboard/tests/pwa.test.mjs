import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const script=readFileSync(new URL('../static/service-worker.js',import.meta.url),'utf8');
test('service worker never caches protected responses and keeps notification navigation same-origin',async()=>{
 const handlers={},notices=[],opened=[];let cached=[];
 const self={location:{origin:'https://eastmoney.hasbai.xyz'},addEventListener:(name,fn)=>handlers[name]=fn,skipWaiting:async()=>{},clients:{claim:async()=>{},matchAll:async()=>[],openWindow:async url=>opened.push(url)},registration:{showNotification:async(title,options)=>notices.push({title,options})}};
 runInNewContext(script,{self,URL,caches:{open:async()=>({addAll:async paths=>cached=paths}),keys:async()=>[],match:async()=>new Response('offline')},fetch:async()=>{throw new Error('offline');}});
 let waiting;handlers.install({waitUntil:p=>waiting=p});await waiting;assert.deepEqual([...cached],['/offline.html','/pwa-192.png','/pwa-512.png']);
 let responded=false;handlers.fetch({request:{method:'GET',mode:'cors',url:'https://eastmoney.hasbai.xyz/api/profile'},respondWith:()=>responded=true});assert.equal(responded,false);
 handlers.push({data:{json:()=>({title:'待办',body:'任务',url:'/financing/projects/one'})},waitUntil:p=>waiting=p});await waiting;assert.equal(notices[0].title,'待办');
 const click=url=>handlers.notificationclick({notification:{data:{url},close(){}},waitUntil:p=>waiting=p});
 click('https://external.invalid/');assert.equal(opened.length,0);click('/financing/projects/one');await waiting;assert.equal(opened[0],'https://eastmoney.hasbai.xyz/financing/projects/one');
});
