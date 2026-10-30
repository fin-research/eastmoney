import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'tsx/esm/api';
register();
const { handleDashboardMcp, executeOperation, decodeBusinessResponse, boundedText } = await import('../src/lib/server/mcp.ts');
const { mcpOperations, operationPath } = await import('../src/lib/server/mcp-catalog.ts');
const { clientRequestPermission } = await import('../src/lib/route-permissions.ts');
const { stringify } = await import('devalue');
const publishedNames = ['market_report','save_market_report','hotspots','policies','research_search','policy_articles','update_policy_articles','article','news','commentaries','commentary','commentary_revisions','create_commentary','update_commentary','economic_indicators','credit_report','bond_ledger','bond_ledger_import','financing_clients','create_client','update_client','bond_investor_reference','create_bond_investor','update_bond_investor'];
const user = { id:'auth0|test',auth0Id:'auth0|test',email:'test@18.cn',issuedAt:1,expiresAt:9999999999,authorization:{name:'测试',picture:'',roles:[],permissions:[],mode:'enforce'} };
function fixture(allow = () => true, response = () => Response.json({ saved:true })) {
  const calls = [];
  return { calls, env: { IDENTITY: { async fetch(request) {
    calls.push(request);
    if (new URL(request.url).pathname === '/mcp/policies') return Response.json({ allowed:(await request.json()).map(allow) });
    return response(request);
  } } } };
}
async function rpc(f, method, params = {}, identity = user) {
  const response = await handleDashboardMcp(new Request('https://eastmoney.hasbai.xyz/api/mcp',{method:'POST',headers:{...(method==='server/discover'?{'MCP-Protocol-Version':'2026-07-28','Mcp-Method':method}:{}),Host:'eastmoney.hasbai.xyz','Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),f.env,identity);
  const text = await response.text();
  const payload = response.headers.get('Content-Type')?.includes('text/event-stream') ? text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).find(value=>value.id===1) : JSON.parse(text);
  return {response,payload};
}
test('real MCP discovery publishes only reviewed market data, credit and bond ledger and respects Gateway permission',async()=>{
  const {response,payload}=await rpc(fixture(),'tools/list');
  assert.equal(response.status,200);
  assert.deepEqual(payload.result.tools.map(tool=>tool.name),publishedNames);
  assert.ok(!mcpOperations.some(op=>op.name.startsWith('generate_')));
  assert.ok(payload.result.tools.every(tool=>tool.annotations.openWorldHint===false));
  assert.equal(payload.result.tools[0].annotations.readOnlyHint,true);
  const denied=await rpc(fixture(()=>false),'tools/list');
  assert.deepEqual(denied.payload.result.tools,[]);
});
test('published ID schemas omit Unicode patterns while calls retain Unicode and path validation',async()=>{
  const {payload}=await rpc(fixture(),'tools/list');
  const article=payload.result.tools.find(tool=>tool.name==='article');
  assert.deepEqual(article.inputSchema.properties.id,{type:'string',minLength:1,maxLength:240});
  for(const tool of payload.result.tools) assert.doesNotMatch(JSON.stringify(tool.inputSchema),/\\\\[pP]\{/u,tool.name);
  for(const id of ['政策-2026','auth0|test','a_b.c-1','１２３']) {
    const f=fixture();
    const {payload}=await rpc(f,'tools/call',{name:'article',arguments:{id}});
    assert.equal(payload.result.isError,undefined,id);
    assert.equal(new URL(f.calls.at(-1).url).searchParams.get('target'),'/api/articles/'+encodeURIComponent(id));
  }
  for(const id of ['','.', '..','../profile','x/y','%2f','a b','😀','a'.repeat(241)]) {
    const f=fixture();
    const {payload}=await rpc(f,'tools/call',{name:'article',arguments:{id}});
    assert.ok(payload.error||payload.result.isError,id);
    assert.equal(f.calls.filter(request=>new URL(request.url).pathname==='/mcp/dispatch').length,0,id);
  }
});
test('unpublished tools and prefixed aliases cannot execute or access backing services',async()=>{
  const f=fixture();
  f.env.EASTMONEY={list(){assert.fail('Unpublished materials must not be read')}};
  f.env.CREDIT_SEARCH={search(){assert.fail('Unpublished search must not execute')}};
  for(const name of ['health','credit_public_materials','credit_public_search','dashboard_credit_report','policy_commentary','update_policy_commentary','tracking_commentary','tracking_commentaries','tracking_revisions','create_tracking_commentary','update_tracking_commentary','generate_market_focus','generate_hotspots','generate_policy_commentary','generate_tracking_commentary','generate_sell_side',...mcpOperations.filter(op=>!publishedNames.includes(op.name)).map(op=>op.name)]) {
    const {payload}=await rpc(f,'tools/call',{name,arguments:{}});
    assert.ok(payload.error||payload.result.isError,name);
  }
  assert.equal(f.calls.filter(request=>new URL(request.url).pathname==='/mcp/dispatch').length,0);
});
test('credit MCP always dispatches the anonymized API and cannot select full reports',async()=>{
  const f=fixture(()=>true,request=>{
    const target=new URL(new URL(request.url).searchParams.get('target'),'https://eastmoney.hasbai.xyz');
    assert.equal(target.pathname,'/api/credit');assert.deepEqual(target.searchParams.getAll('view'),['masked']);
    return Response.json({reportDate:'2026-08-21',amountUnit:'亿元',institutions:[{institution_id:'8',total_limit:'10.000000'}]});
  });
  const read=await rpc(f,'tools/call',{name:'credit_report',arguments:{query:{date:'2026-08-21',institutionId:'8'}}});
  assert.equal(read.payload.result.structuredContent.data.institutions[0].institution_id,'8');
  for(const query of [{view:'usage'},{institution:'身份哨兵'},{month:'2026-08'}]) {
    const result=await rpc(f,'tools/call',{name:'credit_report',arguments:{query}});
    assert.ok(result.payload.error||result.payload.result.isError);
  }
  assert.equal(f.calls.filter(request=>new URL(request.url).pathname==='/mcp/dispatch').length,1);
});
test('MCP calls validate shared schemas, reject hidden tools, and keep identities request-scoped',async()=>{
  const f=fixture();
  const invalid=await rpc(f,'tools/call',{name:'credit_report',arguments:{query:{date:'2026-02-30'}}});
  assert.ok(invalid.payload.error||invalid.payload.result.isError);assert.equal(f.calls.length,1);
  const restricted=fixture(()=>false);const denied=await rpc(restricted,'tools/call',{name:'create_project',arguments:{form:{}}});
  assert.ok(denied.payload.error||denied.payload.result.isError);assert.equal(restricted.calls.length,1);
  const anonymous=await rpc(f,'tools/list',{},null);assert.equal(anonymous.response.status,401);
  const read=await rpc(f,'tools/call',{name:'credit_report',arguments:{}});assert.deepEqual(read.payload.result.structuredContent.data,{saved:true});
});
test('catalog operations map to registered Gateway methods and cannot inject named actions or paths',()=>{
  assert.equal(new Set(mcpOperations.map(t=>t.name)).size,mcpOperations.length);
  for(const operation of mcpOperations) assert.ok(clientRequestPermission(new URL(operationPath(operation,{}),'https://eastmoney.hasbai.xyz'),operation.method),operation.name);
  assert.equal(mcpOperations.find(t=>t.name==='bond_ledger').input.safeParse({query:{workflow:'old-instance'}}).success,false);
  const op=mcpOperations.find(t=>t.name==='article');
  assert.equal(op.input.safeParse({id:'../../api/profile'}).success,false);
  assert.throws(()=>operationPath(op,{id:'a',query:{'/deleteProject':'1'}}));
});
test('JSON mutations and named actions use private dispatch, preserve user context and repeated form fields',async()=>{
  const f=fixture();
  await executeOperation(mcpOperations.find(t=>t.name==='create_timing_decision'),{body:{runId:'sample'}},f.env,user);
  const first=f.calls[0];assert.equal(first.headers.has('Authorization'),false);assert.equal(first.headers.has('Cookie'),false);
  assert.equal(JSON.parse(Buffer.from(first.headers.get('X-Eastmoney-Gateway-Context'),'base64url')).user.auth0Id,user.auth0Id);
  assert.deepEqual(await first.json(),{runId:'sample'});
  const g=fixture(()=>true,()=>Response.json({type:'success',status:200,data:stringify({saved:true})}));
  await executeOperation(mcpOperations.find(t=>t.name==='update_sop'),{id:'abc',form:{name:'模板',nodeIds:['1','2']}},g.env,user);
  assert.equal(new URL(g.calls[0].url).searchParams.get('target'),'/financing/sop/abc?%2FupdateTemplate=');
  assert.deepEqual((await g.calls[0].formData()).getAll('nodeIds'),['1','2']);
});
test('business failures and Svelte data retain their meaning; AI streams are not decoded',async()=>{
  assert.deepEqual(await decodeBusinessResponse(Response.json({type:'data',nodes:[{type:'data',data:JSON.parse(stringify({secret:'layout'}))},{type:'data',data:JSON.parse(stringify({projects:[]}))}]}),{format:'page'}),{projects:[]});
  const failure=await decodeBusinessResponse(Response.json({type:'failure',status:409,data:stringify({message:'版本冲突'})}),{format:'form'});assert.equal(failure.failed,true);assert.equal(failure.status,409);
  const f=fixture(()=>true,()=>Response.json({detail:'权限已变更'},{status:403}));
  const result=await rpc(f,'tools/call',{name:'credit_report',arguments:{}});assert.equal(result.payload.result.isError,true);assert.match(result.payload.result.content[0].text,/403/);
  const sse=text=>new Response(text,{headers:{'Content-Type':'text/event-stream'}});
  await assert.rejects(decodeBusinessResponse(sse('event: result\ndata: {"saved":true}\n\n'),{}),SyntaxError);
  await assert.rejects(boundedText(new Response('超出限制'),3),/大小限制/);
});
test('modern discovery and legacy initialization both serve the Dashboard identity',async()=>{
  for(const [method,params] of [['server/discover',{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}],['initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}]]) {
    const {response,payload}=await rpc(fixture(),method,params);
    assert.equal(response.status,200,JSON.stringify(payload));assert.ok(payload.result,JSON.stringify(payload));if(method==='initialize') assert.equal(payload.result.serverInfo.name,'eastmoney-dashboard'); else assert.ok(payload.result.supportedVersions.includes('2026-07-28'));
  }
});
test('public credit materials remain unpublished even when public files are available',async()=>{
  const f=fixture();
  f.env.EASTMONEY={list(){assert.fail('Unpublished materials must not read R2')}};
  const {payload}=await rpc(f,'tools/call',{name:'credit_public_materials',arguments:{}});
  assert.ok(payload.error||payload.result.isError);
});
test('public credit search remains unpublished and cannot return indexed financial excerpts',async()=>{
  const f=fixture();
  f.env.CREDIT_SEARCH={search(){assert.fail('Unpublished search must not query AI Search')}};
  const {payload}=await rpc(f,'tools/call',{name:'credit_public_search',arguments:{query:'近几年的ROE是多少'}});
  assert.ok(payload.error||payload.result.isError);
});

test('standard commentary MCP results omit originals, filenames and private archive/search metadata',async()=>{
  const value={id:'c1',policyId:null,type:'current_affairs',eventName:'标准点评',sources:'公开研报',eventPublishedAt:'2026-10-26',commentaryDate:'2026-10-26',eventSummary:'事件摘要',commentary:'标准点评正文',recommendation:'发行建议',model:null,promptVersion:null,generatedAt:null,edited:true,updatedAt:'v1',originalText:'原稿哨兵',sourceFiles:[{name:'内部路径哨兵.docx'}],pdf:{key:'存储哨兵'},search:{query:'检索哨兵'},evidence:[{sourceKey:'原始key哨兵'}]};
  const body=Object.fromEntries(['type','eventName','sources','eventPublishedAt','commentaryDate','eventSummary','commentary','recommendation'].map(key=>[key,value[key]]));
  for(const [name,args,response] of [
    ['commentary',{id:'c1'},value],
    ['create_commentary',{body},value],
    ['update_commentary',{id:'c1',body:{...body,updatedAt:'v1'}},value],
    ['commentaries',{}, {items:[value],hasMore:false,policy:{internal:'哨兵'}}],
    ['commentary_revisions',{id:'c1'}, {revisions:[{savedAt:'v1',content:value}]}],
  ]) {
    const {payload}=await rpc(fixture(()=>true,()=>Response.json(response)),'tools/call',{name,arguments:args});
    assert.equal(payload.result.isError,undefined,name);
    assert.doesNotMatch(JSON.stringify(payload.result),/哨兵|originalText|sourceFiles|sourceKey|pdf|search|evidence/);
    assert.match(JSON.stringify(payload.result),/标准点评/);
  }
});

test('bond ledger MCP accepts only paired dates and never dispatches downloads or extra parameters', async()=>{
  const f=fixture();
  for(const args of [
    {query:{start:'2026-10-01'}},{query:{end:'2026-10-27'}},
    {query:{start:'2026-10-27',end:'2026-10-01'}},{query:{start:'2026-02-30',end:'2026-10-27'}},
    {query:{date:'2026-10-27'}},{query:{start:'',end:''}},
    {query:{start:'2026-10-01',end:'2026-10-27',files:true}},{body:{}},
  ]) {
    const {payload}=await rpc(f,'tools/call',{name:'bond_ledger',arguments:args});
    assert.ok(payload.error||payload.result.isError,JSON.stringify(args));
  }
  assert.equal(f.calls.filter(request=>new URL(request.url).pathname==='/mcp/dispatch').length,0);
});
test('bond ledger inventory excludes file metadata while preserving empty inventories and effective dates',async()=>{
  for(const dates of [[],['2026-10-26','2026-10-27']]) {
    const expected={databaseDates:dates,availableStartDate:dates[0]??null,availableEndDate:dates.at(-1)??null};
    const f=fixture(()=>true,request=>{
      assert.equal(new URL(request.url).searchParams.get('target'),'/api/bond-ledger');
      return Response.json({...expected,files:[{fileName:'文件哨兵.xlsx',key:'R2哨兵',uploadedAt:'审计哨兵'}]});
    });
    for(const args of [{},{query:{}}]) {
      const {payload}=await rpc(f,'tools/call',{name:'bond_ledger',arguments:args});
      assert.equal(payload.result.isError,undefined);assert.deepEqual(payload.result.structuredContent.data,expected);
      assert.doesNotMatch(JSON.stringify(payload.result),/哨兵|files|fileName|uploadedAt/);
    }
  }
});
test('bond ledger reports project nested business fields and preserve empty, failed-audit and API-error semantics',async()=>{
  const {emptyBondLedgerReport,buildBondLedgerAnalytics,toBondLedgerReport}=await import('../src/lib/bond-ledger/analytics.ts');
  const date='2026-10-27';
  const performance={date,principal:100,timeWeightedPrincipal:100,marketValue:100,leverage:1,modifiedDuration:1,dailyRevenue:1,cumulativeProfit:2,ytdAnnualizedReturn:0.02,ytdExTaxAnnualizedReturn:0.018};
  const position={reportDate:date,rowNumber:1,team:'团队哨兵',investmentManager:'经理哨兵',account:'交易户',code:'TEST.IB',market:'银行间',name:'测试国债',category:'国债',yieldChangeBp:0,remainingYears:2,interestStartDate:'2025-10-27',maturityDate:'2028-10-27',currentQuantity:1,pledgedQuantity:0,availableQuantity:1,previousQuantity:0,buyQuantity:1,sellQuantity:0,maturityQuantity:0,couponRate:2,valuationYield:2,reportYield:2,fullPrice:100,dv01:1,marketValue:100,couponIncome:0,taxExemptIncome:0,realizedProfit:0,dailyProfit:1,ytdProfit:2,fullPriceCost:98};
  const report=toBondLedgerReport(buildBondLedgerAnalytics([{date,performance:[performance],positions:[position]}],date,date));
  const poison=value=>Array.isArray(value)?value.map(poison):value&&typeof value==='object'?{...Object.fromEntries(Object.entries(value).map(([key,item])=>[key,poison(item)])),team:'团队哨兵',investmentManager:'经理哨兵',storage:{key:'R2哨兵'},sourceUploadId:'导入哨兵'}:value;
  const zeroPrincipalReport=JSON.parse(JSON.stringify(toBondLedgerReport(buildBondLedgerAnalytics([{date,performance:[{...performance,principal:0}],positions:[position]}],date,date))));
  assert.equal(zeroPrincipalReport.auditPassed,false);assert.equal(zeroPrincipalReport.auditChecks.find(check=>check.key==='leverage').actual,null);
  for(const expected of [emptyBondLedgerReport(),report,{...report,auditPassed:false},zeroPrincipalReport]) {
    const {payload}=await rpc(fixture(()=>true,request=>{
      assert.equal(new URL(request.url).searchParams.get('target'),'/api/bond-ledger?start=2026-10-27&end=2026-10-27');
      return Response.json(poison({...expected,currentPositions:[position],files:[{key:'文件哨兵'}]}));
    }),'tools/call',{name:'bond_ledger',arguments:{query:{start:date,end:date}}});
    assert.equal(payload.result.isError,undefined);assert.deepEqual(payload.result.structuredContent.data,expected);
    assert.doesNotMatch(JSON.stringify(payload.result),/哨兵|team|investmentManager|storage|sourceUploadId|currentPositions|files/);
  }
  for(const status of [403,503]) {
    const {payload}=await rpc(fixture(()=>true,()=>Response.json({error:'读取失败'},{status})),'tools/call',{name:'bond_ledger',arguments:{}});
    assert.equal(payload.result.isError,true);assert.deepEqual(JSON.parse(payload.result.content[0].text),{status,detail:'读取失败'});
  }
  const denied=await rpc(fixture(operation=>operation.path!=='/api/bond-ledger'),'tools/list');
  assert.ok(!denied.payload.result.tools.some(tool=>tool.name==='bond_ledger'));
});
test('bond ledger import builds multipart upload, dispatches once and returns the import result', async () => {
  const f = fixture(() => true, async request => {
    assert.equal(new URL(request.url).searchParams.get('target'), '/api/bond-ledger');
    assert.equal(request.method, 'POST');
    const form = await request.formData();
    assert.equal(form.get('file').name, '二级资金池台账20261026.xlsx');
    assert.equal(form.get('file').type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.deepEqual(JSON.parse(form.get('parsed')), { date: '2026-10-26', performance: [], positions: [] });
    assert.equal(form.get('expectedDate'), '2026-10-26');
    return Response.json({ reportDate: '2026-10-26', statisticsCount: 1, positionCount: 2, transactionCount: 0 });
  });
  const { payload } = await rpc(f, 'tools/call', { name: 'bond_ledger_import', arguments: {
    fileName: '二级资金池台账20261026.xlsx', expectedDate: '2026-10-26',
    fileBase64: Buffer.from('xlsx-bytes').toString('base64'),
    parsed: { date: '2026-10-26', performance: [], positions: [] },
  } });
  assert.equal(payload.result.isError, undefined);
  assert.deepEqual(payload.result.structuredContent.data, { reportDate: '2026-10-26', statisticsCount: 1, positionCount: 2, transactionCount: 0 });
  assert.equal(f.calls.filter(request => new URL(request.url).pathname === '/mcp/dispatch').length, 1);
  const g = fixture(() => true, async request => {
    const form = await request.formData();
    assert.equal(form.has('expectedDate'), false);
    return Response.json({ reportDate: '2026-10-26', statisticsCount: 1, positionCount: 0, transactionCount: 0 });
  });
  const noExpected = await rpc(g, 'tools/call', { name: 'bond_ledger_import', arguments: {
    fileName: '台账.xlsx', fileBase64: 'eA==', parsed: { date: '2026-10-26', performance: [], positions: [] },
  } });
  assert.equal(noExpected.payload.result.isError, undefined);
});
test('bond ledger import rejects invalid inputs without dispatching', async () => {
  const f = fixture();
  for (const args of [
    {},
    { fileName: '', fileBase64: 'eA==', parsed: {} },
    { fileName: 'a'.repeat(181), fileBase64: 'eA==', parsed: {} },
    { fileName: '台账.xlsx', fileBase64: '', parsed: {} },
    { fileName: '台账.xlsx', fileBase64: 'eA==', expectedDate: '2026-02-30', parsed: {} },
    { fileName: '台账.xlsx', fileBase64: 'eA==', parsed: {}, extra: 1 },
  ]) {
    const { payload } = await rpc(f, 'tools/call', { name: 'bond_ledger_import', arguments: args });
    assert.ok(payload.error || payload.result.isError, JSON.stringify(args));
  }
  assert.equal(f.calls.filter(request => new URL(request.url).pathname === '/mcp/dispatch').length, 0);
});
test('research search is discoverable read-only POST and preserves request and upstream result',async()=>{
 const found=(await rpc(fixture(),'tools/list')).payload.result.tools.find(tool=>tool.name==='research_search');
 assert.equal(found.annotations.readOnlyHint,true);assert.equal(found.annotations.destructiveHint,false);
 const args={body:{query:'央行',ai_search_options:{retrieval:{max_num_results:50,retrieval_type:'hybrid',filters:{published_at:{$gte:1792598400000,$lt:1793203200000},type:{$eq:'研报'}}}}}};
 const data={success:true,result:{chunks:[{text:'a',scoring_details:{vector_score:0.8}}]}};
 const f=fixture(()=>true,async request=>{assert.equal(new URL(request.url).searchParams.get('target'),'/api/research/search');assert.deepEqual(await request.json(),args.body);return Response.json(data);});
 const result=await rpc(f,'tools/call',{name:'research_search',arguments:args});assert.deepEqual(result.payload.result.structuredContent.data,data);
});
