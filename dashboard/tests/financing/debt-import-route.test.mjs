import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({resolve(specifier,context,next){
 if(specifier==='$app/server')return {shortCircuit:true,url:'data:text/javascript,export function getRequestEvent(){throw new Error("No request context")}'};
 if(specifier.startsWith('$lib/'))return next(new URL('../../src/lib/'+specifier.slice(5)+(/\.(ts|js)$/.test(specifier)?'':'.ts'),import.meta.url).href,context);
 return next(specifier,context);
}});
const {POST}=await import('../../src/routes/financing/data/import/+server.ts');
function event(body,overrides={}) {
 const url=new URL('https://example.test/financing/data/import');
 return {url,request:new Request(url,{method:'POST',headers:{origin:url.origin,'content-type':'application/json'},body:JSON.stringify(body)}),
 locals:{user:{auth0Id:'auth0|test',email:'test@18.cn',authorization:{}},permissions:['financing.data:import']},...overrides};
}
test('JSON import rejects missing permission, foreign origin, wrong encoding and invalid payload before database access',async()=>{
 assert.equal((await POST(event({}, {locals:{permissions:[]}}))).status,403);
 assert.equal((await POST(event({}, {request:new Request('https://example.test/financing/data/import',{method:'POST',headers:{origin:'https://foreign.test','content-type':'application/json'},body:'{}'})}))).status,403);
 assert.equal((await POST(event({}, {request:new Request('https://example.test/financing/data/import',{method:'POST',headers:{origin:'https://example.test','content-type':'application/octet-stream'},body:'test'})}))).status,415);
 const response=await POST(event({action:'commit'}));assert.equal(response.status,400);assert.match((await response.json()).error,/导入数据格式无效/);
 const oversizedIndex=await POST(event({action:'index',identities:[{sourceKey:'old'}]}));
 assert.equal(oversizedIndex.status,400);
});
test('connection failures are sanitized and do not claim that a possibly committed request was rolled back',async()=>{
 const request=event({action:'index'});
 request.locals.database={query:async()=>{throw new Error('secret-database-host and credentials');}};
 const response=await POST(request);assert.equal(response.status,503);
 const result=await response.json();assert.match(result.error,/无法确认/);assert.doesNotMatch(result.error,/secret|未写入/);
});


test('direct JSON commit refuses narrative debt before opening a database connection',async()=>{
 const body={action:'commit',version:'v1',snapshot:{asOfDate:'2026-10-16',totalYi:0},balances:[],snapshotBalances:[{asOfDate:'2026-10-16',debtType:'债券',subtype:'小公募',amount:0}],cashflows:[],
  debts:[{sourceKey:'note',table:'bond',debtType:'债券',subtype:'小公募',name:'发行阶段：',amount:0,interestPayable:0,extension:{}}]};
 const response=await POST(event(body));assert.equal(response.status,400);assert.match((await response.json()).error,/说明文字不能作为负债/);
});
