// Programmatic real-handler integration; external services use isolated in-memory fixtures.
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const gateway=resolve(process.env.GATEWAY_CHECKOUT || '../gateway');
const dashboard=resolve('.');
const data=resolve(process.env.DATA_CHECKOUT || '../data');
const directory=await mkdtemp(join(tmpdir(),'unified-mcp-integration-'));
const require=createRequire(import.meta.resolve('wrangler'));
await require('esbuild').build({entryPoints:[join(data,'src/public-access.ts')],bundle:true,outfile:join(directory,'data.mjs'),format:'esm',platform:'node',target:'es2022',logLevel:'silent'});
const {handleGatewayRequest}=await import(pathToFileURL(join(directory,'data.mjs')).href);
const { fixture } = await import(gateway+'/tests/helpers/fixture.mjs');
const { gatewayRequest } = await import(gateway+'/src/app.ts');
const { identityService } = await import(gateway+'/src/identity-service.ts');
const { Server } = await import(dashboard+'/.svelte-kit/output/server/index.js');
const { manifest } = await import(dashboard+'/.svelte-kit/output/server/manifest.js');
const cleanup=[];const f=await fixture({after:fn=>cleanup.push(fn)});
const appEnv={IDENTITY:{fetch:r=>identityService(r,f.env)},HYPERDRIVE:{connectionString:'postgresql://fixture:fixture@127.0.0.1:1/fixture'},DB:{prepare(sql){assert.match(sql,/^UPDATE financing_reminder_checkpoint/);return {async run(){return {success:true}}}}}};
const server=new Server(manifest);await server.init({env:appEnv});
f.env.DASHBOARD={fetch(request){const context=JSON.parse(Buffer.from(request.headers.get('X-Eastmoney-Gateway-Context'),'base64url'));const headers=new Headers(request.headers);headers.delete('X-Eastmoney-Gateway-Context');headers.set('Host','eastmoney.hasbai.xyz');return server.respond(new Request(request,{headers}),{getClientAddress:()=> '127.0.0.1',platform:{env:{...appEnv,GATEWAY_CONTEXT:context},context:{waitUntil(){}}}})}};
f.env.DATA={fetch:request=>handleGatewayRequest(request,{CHOICE_RPC:{fetch:async()=>Response.json({function:'CSS',fields:['RATE'],rows:[{RATE:1.5}]},{headers:{'X-Choice-Rpc-Version':'choice.rpc.v1'}})},CHOICE_RPC_TOKEN:'fixture',CHOICE_FAST_LIMIT:{limit:async()=>({success:true})},CHOICE_OTHER_LIMIT:{limit:async()=>({success:true})}})};
const token=await f.signed({azp:'https://chatgpt.com/oauth/codex/client.json','https://eastmoney.hasbai.xyz/identity':f.flatClaims,email:undefined});
async function rpc(method,params={}) {const response=await gatewayRequest(new Request(f.env.SITE_ORIGIN+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,Host:'eastmoney.hasbai.xyz','Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),f.env);const text=await response.text();assert.equal(response.status,200,text);const value=response.headers.get('Content-Type')?.includes('text/event-stream')?text.split('\n').filter(v=>v.startsWith('data: ')).map(v=>JSON.parse(v.slice(6))).find(v=>v.id===1):JSON.parse(text);return value.error?{isError:true,rpcError:value.error}:value.result;}
try{
const list=await rpc('tools/list');assert.ok(list.tools.length>=40,list.tools.length);assert.ok(list.tools.some(tool=>tool.name==='commentary'));assert.equal(list.tools.find(tool=>tool.name==='bond_ledger')?.annotations.readOnlyHint,true);assert.equal(list.tools.find(tool=>tool.name==='research_search')?.annotations.readOnlyHint,true);assert.ok(list.tools.every(tool=>!tool.name.startsWith('generate_')));
const call=(name,args={})=>rpc('tools/call',{name,arguments:args});
for(const name of ['health','fund_reports','save_trading_progress','trading_progress','update_project','credit_public_search','dashboard_credit_report','generate_market_focus','generate_hotspots','generate_policy_commentary','generate_tracking_commentary','tracking_commentary','delete_bond_ledger','import_bond_ledger','generate_bond_ledger'])assert.ok((await call(name)).isError,name);
// Invalid arguments are rejected before any business database connection.
assert.ok((await call('credit_report',{query:{view:'usage'}})).isError);
assert.ok((await call('credit_report',{query:{date:'2026-02-30'}})).isError);
for(const query of [{start:'2026-10-01'},{end:'2026-10-27'},{start:'2026-10-27',end:'2026-10-01'},{start:'2026-02-30',end:'2026-10-27'},{date:'2026-10-27'},{start:'2026-10-01',end:'2026-10-27',files:true}])assert.ok((await call('bond_ledger',{query})).isError);
assert.ok((await call('research_search',{body:{query:''}})).isError);
const choice=await call('choice_css',{codes:'000001.SH',indicators:'RATE'});assert.deepEqual(choice.structuredContent.data,{function:'CSS',fields:['RATE'],rows:[{RATE:1.5}]});
await f.updateGrants(['financing.data:create']);
const clientValidation=await call('create_client',{form:{name:'测试客户',fullname:'',type:'无效类型',subtype:'',aliases:[]}});
assert.equal(clientValidation.isError, true);assert.equal(clientValidation.structuredContent.data.status,400);assert.match(JSON.stringify(clientValidation.structuredContent.data.data),/客户字段无效/);
for(const path of ['/api/mcp','/data/mcp'])assert.equal((await gatewayRequest(new Request(f.env.SITE_ORIGIN+path),f.env)).status,410);
await f.updateGrants([]);
const remaining=(await rpc('tools/list')).tools;assert.ok(remaining.length>=23,remaining.length);assert.ok(remaining.some(tool=>tool.name==='market_report'));assert.ok(remaining.some(tool=>tool.name==='news_list'));assert.ok(!remaining.some(tool=>tool.name==='credit_report'));
assert.ok((await call('research_search',{body:{query:'央行'}})).isError);assert.ok(!remaining.some(tool=>tool.name==='research_search'));assert.ok((await call('credit_report')).isError);assert.ok(!remaining.some(tool=>tool.name==='bond_ledger'));assert.ok((await call('bond_ledger')).isError);
console.log(JSON.stringify({integration:true,tools:list.tools.length,realGateway:true,builtSvelteKit:true,unpublishedToolsRejected:true,inputValidation:true,permissionRevocation:true,externalServices:'mocked',browserUsed:false}));
}finally{for(const fn of cleanup)fn();await rm(directory,{recursive:true,force:true})}
